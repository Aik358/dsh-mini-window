/**
 * dsh-mini-window —— host 侧入口。
 *
 * ## 职责（批次22 起）
 *
 *   把 companion 那套「Electron 真窗口」实现搬进插件：
 *   · 注册小窗路由（`/dsh-mini-window/*`）供前端悬浮球调用
 *   · 在宿主自己的 Electron 主进程里创建**无边框 + 置顶可切换**的小窗
 *   · **零额外下载**（用宿主自带的 Electron，不装第二个 Electron）
 *
 * ## ★ 三条硬性纪律（均来自本项目已付代价的实测教训）
 *
 *   1. **绝不冒泡**：宿主以「entry 是否 activate」判定启动成败。
 *      任何未捕获异常 ⇒ `web boot: N entry did not activate` ⇒ **整个应用打不开**
 *      （2026-10-11 批次19 真实事故）。⇒ 本文件所有逻辑 try/catch 兜底。
 *   2. **能力必须真调用判定**：`typeof x === 'function'` 不等于可用（批次20/21 教训）。
 *      ⇒ 提供 `/dsh-mini-window/probe` 真调用探测。
 *   3. **零 inject 优先**：缺服务时 Cordis 会让插件永久 pending。
 *      但注册路由**需要** `webServer` ⇒ 用 `ctx.inject([...])` **延迟注入**，
 *      拿不到就不注册（降级为"只有页面内浮层"），而不是卡住整个插件。
 *
 * ## 契约来源（读到原文，非推测）
 *   · `@deepseek-ai/*` 官方包均为 `export function apply(ctx)`
 *   · profile 通过 package.json 的 `dsh.bundle.patch` 指向本包 cordis.patch.yml
 *   · `webServer.register(route: WebRoute): () => void`（app.asar 原文）
 */

import { registerMiniRoutes, ROUTE_PREFIX } from './host-routes.js';

/** Host 侧包名（与 package.json / client.js 的注册 id 三处一致）。 */
export const name = '@a9i5k4/dsh-mini-window';

/** 小窗要加载的 URL —— 由 webServer 的真实端口拼出。 */
let resolvedOrigin = '';

/**
 * 解析宿主自己监听的 origin。
 *
 * 为什么要动态取：web 端口由宿主决定（不保证是 19387），
 * 硬编码会在端口变化时开出一个打不开的窗口。
 * @param {object} webCtx - 已 inject 的上下文。
 * @returns {string} 形如 `http://127.0.0.1:19387`；取不到返回空串。
 */
function resolveOrigin(webCtx) {
	try {
		// ★ 2026-10-11 实测：下面这些候选在**真实宿主上全都取不到**
		//   （`webServer.port` / `.address` 都不是官方字段）
		//   ⇒ 曾经返回空串，导致生成的小窗 `TARGET = "about:blank"`、窗口开出来是**全黑**。
		//   现在保留探测（万一某版本暴露了就能用对），但**最终一定给得出兜底值**。
		const cands = [
			webCtx && webCtx.webServer && webCtx.webServer.port,
			webCtx && webCtx.webServer && webCtx.webServer.address,
			webCtx && webCtx.webServer && webCtx.webServer.origin,
			webCtx && webCtx.port,
		];
		for (const c of cands) {
			if (typeof c === 'number' && c > 0) return 'http://127.0.0.1:' + c;
			if (typeof c === 'string' && /^https?:\/\//.test(c)) return c.replace(/\/+$/, '');
			if (typeof c === 'function') {
				try {
					const v = c.call(webCtx && webCtx.webServer);
					if (typeof v === 'number' && v > 0) return 'http://127.0.0.1:' + v;
					if (typeof v === 'string' && /^https?:\/\//.test(v)) return v.replace(/\/+$/, '');
				} catch { /* 换下一个 */ }
			}
			if (c && typeof c === 'object' && typeof c.port === 'number' && c.port > 0) {
				return 'http://127.0.0.1:' + c.port;
			}
		}
	} catch { /* 落到兜底 */ }
	// ★ 兜底：DSH 默认监听 19387（本机实测就是这个）；可用环境变量覆盖
	try {
		if (process.env.DSH_MINI_ORIGIN) return String(process.env.DSH_MINI_ORIGIN).replace(/\/+$/, '');
		const p = process.env.DSH_PORT || process.env.PORT;
		if (p && /^\d+$/.test(String(p))) return 'http://127.0.0.1:' + p;
	} catch { /* noop */ }
	return 'http://127.0.0.1:19387';
}

export function apply(ctx) {
	try {
		ctx.logger?.info?.('[dsh-mini-window] host 侧已加载');

		// 延迟注入 webServer：拿不到就只打日志，不阻塞插件激活
		try {
			ctx.inject(['webServer'], (webCtx) => {
				try {
					resolvedOrigin = resolveOrigin(webCtx);
					const r = registerMiniRoutes(webCtx, {
						resolveUrl: () => (resolvedOrigin || '') + '/?dsh-mini=1',
						// 小窗 app 要用**宿主自己的 origin** 去加载 DSH 页面
						resolveOrigin: () => resolvedOrigin || '',
					});
					if (r) {
						ctx.logger?.info?.(
							'[dsh-mini-window] 小窗路由已注册：' + ROUTE_PREFIX + '/*（origin=' + (resolvedOrigin || '未取到，将用相对地址') + '）'
						);
					} else {
						ctx.logger?.warn?.('[dsh-mini-window] 小窗路由注册失败（降级：仅页面内浮层）');
					}
				} catch (e) {
					ctx.logger?.warn?.('[dsh-mini-window] 小窗路由装配失败（已降级）：' + String((e && e.message) || e));
				}
			});
		} catch (e) {
			ctx.logger?.warn?.('[dsh-mini-window] inject webServer 失败（已降级）：' + String((e && e.message) || e));
		}
	} catch (e) {
		// ★ 最外层兜底：绝不让 host 侧异常导致 web boot 失败（应用打不开）
		try { console.error('[dsh-mini-window] host apply 出现未预期错误（已吞掉以保证应用可用）：', e); } catch { /* noop */ }
	}
}
