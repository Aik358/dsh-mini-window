/**
 * dsh-mini-window —— host 侧小窗路由（前端 ↔ 主进程的桥）。
 *
 * ## 通信模型
 *
 *   前端（renderer）点悬浮球 ⇒ `fetch('/dsh-mini-window/open', {method:'POST'})`
 *   ⇒ host 侧路由 ⇒ 在主进程创建 / 操作真窗口。
 *
 *   为什么不用 IPC：
 *     前端跑在 renderer，`__ModuleLoader__` 的 require 只提供平台基座，
 *     **拿不到 `ipcRenderer`**（那是 preload 的能力）。
 *     而宿主已给出 `webServer` 服务（官方契约）⇒ 用 HTTP 路由是最省事且官方的路径。
 *
 * ## 官方契约（从 app.asar 读到原文，非猜测）
 *
 *   ```ts
 *   interface WebRoute {
 *     kind: WebRouteKind;                    // "exact" | "prefix"
 *     path: string;
 *     handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
 *   }
 *   webServer.register(route: WebRoute): () => void
 *   ```
 *   官方调用范例：`ctx.effect(() => ctx.webServer.register({kind:"exact", path, handler}), "描述")`
 *   ⇒ `ctx.effect` 返回 disposer，插件卸载时自动注销路由。
 *
 * ## ★ 安全
 *
 *   路由只要能开窗就够，不给它任何文件/命令能力。所有 handler 都：
 *     · 只接受 POST/GET，其他方法 405
 *     · 只返回 JSON，绝不回显请求体
 *     · 全部 try/catch ⇒ 失败回 500，**绝不抛到宿主**
 *   （宿主以「entry 是否 activate」判定启动成败，任何冒泡异常都可能让应用打不开。）
 */

import { createMiniController, probeElectron } from './host-window.js';
import { openBrowserMiniWindow, findBrowser, setBrowserWindowTopmost, getLastBrowserPid } from './browser-window.js';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** 路由前缀（带包名前缀避免与其他插件冲突）。 */
export const ROUTE_PREFIX = '/dsh-mini-window';

// ════════════════════════════════════════════════════════════════════════
// ★★★ localStorage seed：让小窗里的插件**认为自己是老用户**
// ════════════════════════════════════════════════════════════════════════
//
// ## 为什么需要（用户在批次29 实测点破）
//
//   用户原话：「这些插件什么的现在都在里面，这个浮窗都在里面浮着呢，而且，
//   那些插件的更新检测，还有新手引导，都会自己蹦出来。」
//
// ## 真因（照抄 companion/lib/ls-seed.js 的实测结论，不是我推断）
//
//   Web 存储按 **(partition, origin)** 隔离。小窗是另一个 Electron 进程、
//   另一个 partition ⇒ 那块 localStorage 是**空的** ⇒ 插件判定为**全新安装**
//   ⇒ 反复弹欢迎向导 / 更新提示；插件的浮层也因为读不到「上次的位置/开关」
//   而用默认值 ⇒ **全浮出来**。
//
//   实测 key（宿主里真实存在，共 243 条）：
//     `dsh-auto-memory.tourDismissed` = 1
//     `dsh-auto-memory.seenVersion`   = 3.2.15     ← 更新检测靠它
//     `dsh-auto-memory.semWizardDone` = 1
//     `dsh-vision-router:onboarding:model-guide-v2` = seen
//     `dsh-workbuddy-connect:update-dismissed` = 0.6.5:0.7.1
//     `dsh-sidebar:v1:session-*`（浮层/侧栏位置）
//
// ## ★ 关键：origin 不同，必须映射
//
//   宿主桌面壳前端跑在  `dsh-app://app`       ← 243 条业务 key 全在这里
//   小窗 iframe 加载      `http://127.0.0.1:19387`
//   ⇒ 照 origin 原样匹配**一条都注入不进去**（companion 早期就踩过，
//     preload 报 `no-bucket-for-origin`）⇒ 必须把应用桶**映射**到目标 origin。
//
// ## ★ 为什么不用 companion 的 webview+preload 方案
//
//   companion 用 `<webview>` + `preload` + `ipcRenderer.sendSync`，
//   是因为 webview 是**独立 webContents**、主进程的 additionalArguments 不透传，
//   只能靠 preload 在文档创建前写入。
//
//   但**我的外壳页与 iframe 同源**（都是 127.0.0.1:19387）⇒ localStorage 共享
//   ⇒ **外壳页直接写就够了**。已用带负路径的实验证明：
//     `probe/same-origin-ls-seed.cjs` ⇒ A 组 SEEN 3/3、B 组（不写）SEEN 0/3
//   ⇒ 不需要 webview / preload / ipc，且**不引入任何第三方依赖**。
//
// ## 安全边界（沿用 companion 的约定）
//
//   · 只**写入** localStorage；不读页面数据、不发网络请求、不碰 DOM
//   · **仅在缺失时写入**（小窗里用户可能已经改过，用宿主旧快照覆盖会冲掉）
//   · 只注入白名单前缀之外的通用 key（黑名单见下）
// ════════════════════════════════════════════════════════════════════════

/** 宿主桌面壳前端的 origin（实测：243 条业务 key 都挂在这里）。 */
const SHELL_ORIGIN = 'dsh-app://app';

/** 与业务无关、不注入的 origin。 */
const IGNORED_ORIGINS = new Set(['devtools://devtools']);

/**
 * 明确**不注入**的 key 前缀。
 *
 * 为什么排除：这些是**宿主壳自身的会话/窗口状态**，小窗是独立窗口，
 * 把宿主的会话指针搬进去会让小窗"以为"自己开着宿主的那个会话
 * （历史上曾因改会话指针出过事故 ⇒ 保守不碰）。
 */
const SEED_KEY_DENY = [
	'dsh.sessions.current',      // 会话指针
	'dsh.sessions.list',         // 会话列表
	'dsh-mini-window.',          // 本插件自己的状态
	'router:onboarding',         // 引导：让页面自己按正常流程走，不伪造
];

/**
 * ★★★ 2026-10-11 实测踩到的**真 bug**：seed 太大 ⇒ 小窗卡死在「启动小窗…」
 *
 * 现象：用户点球后窗口停在我们的 boot 页，永不跳转。
 *
 * 实测数据（`probe/real-mini-hang-browser.cjs`）：
 * ```
 * /boot 总长 103,100 字节
 *   其中内联 seed = 102,577 字节（99.5%）
 *   key 数量 ≈ 3,033
 * ```
 * 而且**抽出来做真语法检查直接报错**：
 * ```
 * $ node --check bootscript.js
 * SyntaxError: Unexpected identifier 'location'
 * ```
 * ⇒ 内联脚本语法一错，`location.replace` **永远不会执行** ⇒ 页面永远停在「启动小窗…」。
 *
 * 根因：宿主存储里塞满了**每个会话各自的侧栏布局**（`dsh.sidebar-right.v1.session-*`，
 * 一个就好几 KB，几百个）——这些**与小窗毫无关系**，却被整包内联进了 HTML。
 *
 * ⇒ **两道防线**：
 *   ① **只注入"真正影响插件行为"的 key**（白名单前缀，见 `SEED_KEY_ALLOW`）
 *      ⇒ 体积从 100KB 降到 1KB 级别，语法出错概率与解析开销都大幅下降；
 *   ② **跳转不依赖内联脚本** —— 用 `<meta http-equiv="refresh">` 兜底，
 *      就算脚本挂了也一定会跳（**关键：跳转是主路径，不能被注入脚本的成败绑架**）。
 */
const SEED_KEY_ALLOW_PREFIX = [
	'dsh-auto-memory.',        // 引导/更新/皮肤（用户明确抱怨过的那一批）
	'dam-',                    // 皮肤相关
	'dsh-vision-router:onboarding',
	'dsh-workbuddy-connect:update-dismissed',
	'dshm-',                   // 面板位置等
	'mini-',                   //
];

/** 单个 value 的上限（超过就丢弃：这些是布局快照，对小窗无意义）。 */
const SEED_VALUE_MAX = 512;

/** key 总数上限（防极端情况把 HTML 撑爆）。 */
const SEED_KEY_MAX = 200;

/**
 * 从宿主 LocalStorage 提取原始 seed。
 *
 * ★ 用**打包进来的**零依赖提取器 `lib/ls-extract.cjs`（42,060 B，只 require fs/path）。
 *
 *   为什么不用我先前手写的"只读 .log"简化版：
 *     实测只读到 **11 条**，而真值 **243 条** —— 因为绝大部分 key 在 `.ldb`（SSTable）里，
 *     不是 `.log`。完整解析 SSTable 很容易写错，**直接复用已在 lab 里验证过的实现**
 *     比自创一个"看起来对"的解析器可靠得多（本项目第 N 次同类教训）。
 *
 *   ⚠️ 它是 CJS，而本文件是 ESM ⇒ 用 createRequire 加载。
 *
 * @returns {{ok:boolean, reason:string, raw?:object}}
 */
function extractHostSeed() {
	try {
		const appData = process.env.APPDATA || '';
		if (!appData) return { ok: false, reason: 'no-appdata' };
		const dir = join(appData, '@deepseek-ai', 'dsh-desktop', 'Local Storage', 'leveldb');
		if (!existsSync(dir)) return { ok: false, reason: 'no-leveldb-dir' };

		// ESM 里加载 CJS：createRequire(import.meta.url)
		const require_ = createRequire(import.meta.url);
		const mod = require_(join(dirname(fileURLToPath(import.meta.url)), 'ls-extract.cjs'));
		if (!mod || typeof mod.extractLevelDB !== 'function') return { ok: false, reason: 'bad-extractor' };

		const r = mod.extractLevelDB({ dir: dir });
		// 返回值形状（读源码得到，非猜测）：{ stores, meta, records, stats, warnings }
		// stores: { "<origin>": { "<key>": "<value>" } }
		const stores = (r && r.stores) || null;
		if (!stores || typeof stores !== 'object') return { ok: false, reason: 'no-stores' };
		if (Object.keys(stores).length === 0) return { ok: false, reason: 'empty' };
		return { ok: true, reason: 'ok', raw: stores };
	} catch (err) {
		return { ok: false, reason: 'extract-failed: ' + String((err && err.message) || err) };
	}
}

/**
 * 把原始 seed 规范成「可直接注入的 seed」。
 *
 * 规则（照抄 companion 的语义，但加了本项目的黑名单）：
 *   1. 丢弃无关 origin（devtools 等）
 *   2. 把 `dsh-app://app` 这份**应用桶**映射到 `targetOrigin`
 *   3. 丢弃黑名单 key（会话指针等，见 `SEED_KEY_DENY`）
 *
 * @param {object} raw
 * @param {string} targetOrigin
 */
function normalizeSeed(raw, targetOrigin) {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { seed: {}, stats: { entries: 0, error: 'bad-raw-shape' } };
	if (typeof targetOrigin !== 'string' || targetOrigin === '') return { seed: {}, stats: { entries: 0, error: 'bad-target-origin' } };

	const merged = {};
	const appBucket = raw[SHELL_ORIGIN];
	if (appBucket && typeof appBucket === 'object' && !Array.isArray(appBucket)) {
		Object.assign(merged, appBucket);
	}
	// 并入其它业务 origin（不含被忽略的、不含目标 origin 自己那份）（后并入的不覆盖已有）
	for (const [origin, bucket] of Object.entries(raw)) {
		if (origin === SHELL_ORIGIN || IGNORED_ORIGINS.has(origin) || origin === targetOrigin) continue;
		if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
		for (const [k, v] of Object.entries(bucket)) if (!(k in merged)) merged[k] = v;
	}
	const own = raw[targetOrigin];
	if (own && typeof own === 'object' && !Array.isArray(own)) {
		for (const [k, v] of Object.entries(own)) if (!(k in merged)) merged[k] = v;
	}

	// 黑名单过滤
	let denied = 0;
	for (const k of Object.keys(merged)) {
		if (SEED_KEY_DENY.some((pre) => k.startsWith(pre))) { delete merged[k]; denied++; }
	}

	// ★★ 白名单 + 体积过滤（2026-10-11 修「卡死在启动小窗…」）
	//
	//   实测：不加这两道过滤时，seed 有 **3,033 条 / 102,577 字节**，
	//   全被内联进 HTML ⇒ boot 页 103KB ⇒ 内联脚本语法出错 ⇒ **永不跳转**。
	//
	//   而其中绝大部分是**每个会话各自的侧栏布局快照**
	//   （`dsh.sidebar-right.v1.session-*`，一条几 KB）—— 与小窗行为**毫无关系**。
	//
	//   ⇒ 只保留**真正影响插件行为**的 key（引导/更新/皮肤/面板位置）。
	let droppedByAllow = 0;
	let droppedBySize = 0;
	for (const k of Object.keys(merged)) {
		if (!SEED_KEY_ALLOW_PREFIX.some((pre) => k.startsWith(pre))) { delete merged[k]; droppedByAllow++; continue; }
		if (typeof merged[k] !== 'string' || merged[k].length > SEED_VALUE_MAX) { delete merged[k]; droppedBySize++; }
	}
	// 仍然太多时按 key 名排序截断（保证结果稳定、可复现）
	let truncated = 0;
	const keys = Object.keys(merged).sort();
	if (keys.length > SEED_KEY_MAX) {
		for (const k of keys.slice(SEED_KEY_MAX)) { delete merged[k]; truncated++; }
	}

	const entries = Object.keys(merged).length;
	return {
		seed: entries > 0 ? { [targetOrigin]: merged } : {},
		stats: { entries, denied, droppedByAllow, droppedBySize, truncated },
	};
}

/** 缓存：避免每次请求都读一遍磁盘（宿主存储变动不频繁）。 */
let seedCache = { at: 0, value: null };
const SEED_TTL_MS = 5 * 60 * 1000;

/** 取（并缓存）当前 host 的 seed。 */
function getHostSeed(targetOrigin) {
	const now = Date.now();
	if (seedCache.value && now - seedCache.at < SEED_TTL_MS) {
		return normalizeSeed(seedCache.value.raw, targetOrigin);
	}
	const ex = extractHostSeed();
	if (!ex.ok) return { seed: {}, stats: { entries: 0, error: ex.reason } };
	seedCache = { at: now, value: ex };
	return normalizeSeed(ex.raw, targetOrigin);
}


/** 只接受这些方法。 */
function methodOk(req, allow) {
	return allow.includes(String(req.method || 'GET').toUpperCase());
}

/** 回一个 JSON 响应（统一出口，保证不抛）。 */
function sendJson(res, code, obj) {
	try {
		const body = JSON.stringify(obj == null ? {} : obj);
		res.writeHead(code, {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
		});
		res.end(body);
	} catch {
		try { res.end('{}'); } catch { /* noop */ }
	}
}

/** 读请求体（有上限，防止被塞爆内存）；失败返回空对象。 */
function readJsonBody(req, limit = 64 * 1024) {
	return new Promise((resolve) => {
		let size = 0;
		const chunks = [];
		try {
			req.on('data', (c) => {
				size += c.length;
				if (size > limit) { try { req.destroy(); } catch { /* noop */ } resolve({}); return; }
				chunks.push(c);
			});
			req.on('end', () => {
				try {
					const s = Buffer.concat(chunks).toString('utf8').trim();
					resolve(s ? JSON.parse(s) : {});
				} catch { resolve({}); }
			});
			req.on('error', () => resolve({}));
		} catch { resolve({}); }
	});
}

/**
 * 把任意输入收成合法数字，否则回退默认值。
 * @param {unknown} v
 * @param {number} dflt
 */
function numOr(v, dflt) {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * 注册小窗路由。
 *
 * @param {object} ctx - Cordis 上下文（需已 inject `webServer`）。
 * @param {object} opts
 * @param {() => string} opts.resolveUrl - 返回小窗要加载的 URL。
 * @returns {{ controller: object, dispose: () => void } | null} 失败返回 null（绝不抛）。
 */
export function registerMiniRoutes(ctx, opts) {
	try {
		if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') return null;

		const controller = createMiniController((opts && opts.resolveUrl) || (() => ''));
		/** 供 launchCompanion 拼接小窗要加载的 URL（宿主 origin）。 */
		const resolveOrigin = (opts && opts.resolveOrigin) || (() => '');

		/** 处理一个动作；返回给前端的 JSON 体。 */
		async function handleAction(action, body) {
			switch (action) {
				case 'open': {
					const ok = await controller.open();
					return { ok, open: controller.isOpen(), pinned: controller.isPinned(), hint: ok ? undefined : '无法创建窗口（可能不是 Electron 桌面端）' };
				}
				case 'close':
					return { ok: controller.close(), open: false, pinned: controller.isPinned() };
				case 'toggle': {
					if (controller.isOpen()) return { ok: controller.close(), open: false, pinned: controller.isPinned() };
					const ok = await controller.open();
					return { ok, open: controller.isOpen(), pinned: controller.isPinned() };
				}
				case 'pin': {
					// ★★ 2026-10-11 用户实测：「这个『图钉』钉在最上层的功能没法用了」
					//
					//   真因：`pin` 原先**只操作 Electron 控制器**
					//   （`controller.togglePin()`）；而浏览器模式下**根本没有 Electron 窗口**
					//   ⇒ 返回 false、点了完全没反应。
					//
					//   修法（**前端一行不改**，协议保持不变）：host 侧自动判断——
					//     · 有 Electron 窗口 ⇒ 走原来的 controller（保持旧行为）
					//     · 否则若有浏览器小窗 ⇒ 用 Win32 SetWindowPos 操作它
					if (controller.isOpen()) {
						return { ok: true, open: true, pinned: controller.togglePin(), via: 'electron' };
					}
					const bpid = getLastBrowserPid();
					if (bpid) {
						// ★★ 2026-10-11 实测踩到：**尺寸校正会把 topmost 重置掉**。
						//
						//   证据（两次运行对比）：
						//     · `probe/pin-diagnose2.cjs` 里**不改尺寸**直接置顶 ⇒ 回读 True ✓
						//     · `probe/final34-pin-size.mjs` 里**先校正尺寸**再置顶 ⇒ 回读 False ✗
						//   ⇒ Windows 在 `SetWindowPos` 改尺寸时会把 Z 序一起重排。
						//
						//   ⇒ 处理：**先做尺寸校正（若需要），再设置顶**；顺序错了就白设。
						//   （这里不主动改尺寸 —— 尺寸已在启动时校正过；只确保置顶在最后）
						const cur = setBrowserWindowTopmost(bpid, null);
						if (cur.ok) {
							const next = !cur.topmost;
							const set = setBrowserWindowTopmost(bpid, next);
							// 置顶失败且原因是"窗口刚被改过尺寸"⇒ 重试一次（给 Windows 一点时间）
							if (set.ok && set.topmost !== next) {
								const retry = setBrowserWindowTopmost(bpid, next);
								return {
									ok: retry.ok,
									open: true,
									pinned: retry.ok ? !!retry.topmost : !!set.topmost,
									via: 'browser',
									window: retry.window || set.window,
									retried: true,
								};
							}
							return {
								ok: set.ok,
								open: true,
								pinned: set.ok ? !!set.topmost : !!cur.topmost,
								via: 'browser',
								window: set.window,
								reason: set.ok ? undefined : set.reason,
							};
						}
						return { ok: false, open: true, pinned: false, via: 'browser', reason: cur.reason };
					}
					// 两者都没有：如实说，不假装成功
					return { ok: false, open: false, pinned: false, hint: '当前没有小窗（Electron 与浏览器小窗都没有）' };
				}
				case 'minimize':
					return { ok: controller.minimize(), open: controller.isOpen(), pinned: controller.isPinned() };
				case 'compact':
					return { ok: controller.toggleCompact(), open: controller.isOpen(), pinned: controller.isPinned() };
				case 'state':
					return { ok: true, open: controller.isOpen(), pinned: controller.isPinned() };
				// ★★★ 2026-10-11：真 DSH 里唯一能开独立小窗的路径（见下方说明）
				case 'companion':
					return launchCompanion();

				/**
				 * ★★★ 浏览器小窗（**用户 2026-10-11 拍板的最终方案，零下载**）
				 *
				 * 用户原话：「这就好说了，**全部用一个浏览器窗口实现就行**。自动找用户的浏览器，
				 * 比如 Chrome 或者 Edge，就默认是 Chrome 吧。然后监听端口、key 什么的都是老思路，
				 * 直接给它扔出来就行。尺寸也好调，这个置顶也好做。」
				 *
				 * 三条基石（均已实测，见 `evidence/batch31/32`）：
				 *   ① `chrome --app=<url> --window-size=520,720` → 无地址栏独立窗口，**尺寸精确**
				 *   ② **cookie 忽略端口**（A 端口 Set-Cookie ⇒ B 端口也收到）
				 *   ③ host 能读密钥自签 cookie（与 Electron 路线同一套算法）
				 */
				case 'browser': {
					const origin = String(resolveOrigin() || '').replace(/\/+$/, '');
					if (!/^https?:\/\//.test(origin)) {
						return { ok: false, reason: 'no-origin', hint: '解析不到宿主 origin，无法开浏览器小窗' };
					}
					const r = await openBrowserMiniWindow({
						dshOrigin: origin,
						width: numOr(body && body.width, 520),
						height: numOr(body && body.height, 720),
						position: (body && body.position) || undefined,
					});
					return Object.assign({ action: 'browser' }, r);
				}

				/** 浏览器探测（前端可据此显示"用哪个浏览器开"）。 */
				case 'browser-probe': {
					const b = findBrowser();
					return Object.assign({ action: 'browser-probe' }, b);
				}

				/** 浏览器窗口置顶切换（用户说「这个置顶也好做」）。 */
				case 'browser-pin': {
					const pid = Number((body && body.pid) || 0);
					if (!pid) return { ok: false, reason: 'need-pid' };
					const on = !(body && body.on === false);
					const r = setBrowserWindowTopmost(pid, on);
					return Object.assign({ action: 'browser-pin', topmost: on }, r);
				}

				default:
					return { ok: false, error: 'unknown action: ' + String(action) };
			}
		}

		/**
		 * ★★★ 启动 Companion —— **真 DSH 里唯一能开出"独立小窗"的路径**。
		 *
		 * ## 为什么必须靠它（2026-10-11 在真 DSH 里逐条实测）
		 *
		 *   用户原话：「默认调起的是兜底形式，就是在页面里面的那种，并没有新建一个小窗口」
		 *
		 *   | 路径 | 真 DSH 实测 |
		 *   |---|---|
		 *   | host 侧 `import('electron')` | ❌ host 是 Node 子进程（PID 68420），不是 Electron |
		 *   | `window.open()` | ❌ 主进程 7 处 `setWindowOpenHandler` **全部 `{action:"deny"}`** |
		 *   | `documentPictureInPicture` | ❌ 权限策略拒绝 |
		 *   | `window.dshPlatform.open()` | ❌ 只接受 `usage`/`top-up` |
		 *   | 页面内 iframe 浮层 | ⚠️ 能显示但**拖不出应用**，且 iframe 载入 DSH 会一直转圈 |
		 *
		 *   ⇒ 只有 **Companion（独立 Electron 程序，自己就是主进程）** 能开真窗口。
		 *
		 * ## 本函数做什么
		 *
		 *   ① 找 Companion 的可执行文件（几个已知位置）
		 *   ② 已在跑就直接成功（幂等，不重复拉起）
		 *   ③ 没跑就 `spawn` 拉起（**分离进程**，不阻塞、不随宿主退出）
		 *   ④ 找不到就如实回 `{ok:false}` —— **不假装成功**
		 *
		 * @returns {Promise<object>} `{ok, launched, running, path?, hint?}`
		 */
		async function launchCompanion() {
			try {
				const { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync } = await import('node:fs');
				const { spawn } = await import('node:child_process');
				const { join, dirname } = await import('node:path');
				const { homedir, tmpdir } = await import('node:os');

				/**
				 * ★★★ 本机实测（2026-10-11，两条都跑过）：
				 *
				 *   | 用谁跑我们的 app | 结果 |
				 *   |---|---|
				 *   | **DSH 自带 Electron**（`G:\dsh_desktop\DeepSeek Harness.exe <app>`） | ❌ 退出码 0、**无任何输出**（它被自己的启动逻辑接管，不认外部 app） |
				 *   | **Companion 的 Electron** + 正确 cwd | ✅ **`MINI_READY {"x":1020,"y":336,"width":520,"height":720}`** 真的开出来了 |
				 *
				 *   ⇒ 所以用 Companion 的 Electron，但**必须显式给 cwd**。
				 *
				 * ## 原版为什么会静默失败（根因留痕）
				 *
				 *   原代码 `spawn(exe, ['main.js'], {stdio:'ignore'})`：
				 *     · 入口用**相对路径** `main.js`，而宿主进程的 cwd 不在 companion 目录
				 *       ⇒ Electron 找不到入口 ⇒ 起来就退
				 *     · `stdio:'ignore'` 把报错也吞了 ⇒ 界面上「点了没反应」，路由却回 `ok:true`
				 *   ⇒ **"spawn 没抛错" ≠ "进程起来了"**（本项目 CR-10 的又一次翻版）。
				 */

				/** Companion 目录（含 electron 与我们的窗口 app）。 */
				const companionDir = process.env.DSH_MINI_COMPANION_DIR
					|| join('E:', 'dsh-mini-window-lab', 'companion');
				const electronExe = join(companionDir, 'node_modules', 'electron', 'dist', 'electron.exe');

				if (!existsSync(electronExe)) {
					return {
						ok: false, launched: false,
						hint: '没找到 Companion 的 Electron（' + electronExe + '）。装上 Companion 后即可开真正的独立小窗。',
					};
				}

				/**
				 * 准备「小窗 app」目录。
				 *
				 * 为什么要现写一个 app 而不是直接跑 companion 的 main.js：
				 *   companion 是**完整应用**（要握手、要取交接链接）；而用户点球只想
				 *   **开一个属于 DSH 的小窗**。这里给它一个最小 app：
				 *   iframe 载入 DSH 的 `?dsh-mini=1`，外壳是 companion 同款 55px 顶栏。
				 *
				 * ★ 放在 **tmp 之外**（Windows `os.tmpdir()` 会给 8.3 短名，
				 *   导致 Electron `loadFile/loadURL` 报 EBUSY/ERR_FAILED —— 本项目已踩过）。
				 */
				const appDir = join(companionDir, '.mini-shell');
				try {
					mkdirSync(appDir, { recursive: true });
					// 清理上一次的残留文件（只删我们自己的三个，不动别人的）
					for (const f of readdirSync(appDir)) {
						if (f === 'main.cjs' || f === 'preload.cjs' || f === 'package.json') {
							try { rmSync(join(appDir, f), { force: true }); } catch { /* noop */ }
						}
					}
				} catch { /* 目录已存在即可 */ }

				// ★ 小窗 app 的地址：宿主自己的 origin + `?dsh-mini=1`
				//
				// ⚠️ 2026-10-11 实测踩到：`resolveOrigin()` 取到空串时，
				//   生成的 `const TARGET = "about:blank"` ⇒ 窗口开出来了但**里面全黑**。
				//   根因：`resolveOrigin(webCtx)` 的那几个候选（`webServer.port` / `.address` 等）
				//   在真实宿主上**都取不到**（webServer 没暴露这些字段）⇒ 必须有兜底。
				//   ⇒ 兜底用 DSH 默认端口 19387（用户本机就是这个；可用 ENV 覆盖）。
				const origin0 = String((opts && opts.resolveOrigin && opts.resolveOrigin()) || '').replace(/\/+$/, '');
				const fallback = process.env.DSH_MINI_ORIGIN
					|| ('http://127.0.0.1:' + (process.env.DSH_PORT || '19387'));
				const origin = origin0 || fallback;
				const target = origin + '/?dsh-mini=1';

				const mainSrc = buildMiniShellMain(target);
				const preloadSrc = buildMiniShellPreload();
				const pkgSrc = JSON.stringify({ name: 'dsh-mini-shell', version: '1.0.0', main: 'main.cjs', private: true }, null, 2);
				try {
					writeFileSync(join(appDir, 'main.cjs'), mainSrc, 'utf8');
					writeFileSync(join(appDir, 'preload.cjs'), preloadSrc, 'utf8');
					writeFileSync(join(appDir, 'package.json'), pkgSrc, 'utf8');
				} catch (e) {
					return { ok: false, launched: false, hint: '写小窗 app 失败：' + String((e && e.message) || e) };
				}

				// ---- 起它（★ 四个关键点）----
				try {
					/**
					 * ★★ 必须显式清掉 `ELECTRON_RUN_AS_NODE`（2026-10-11 实测踩到，花了两轮）。
					 *
					 *   DSH 的服务进程本身就是**用这个变量以 Node 模式启动 Electron 二进制**的
					 *   （`PID 68420 --expose-internals .../dsh-desktop-host/lib/index.js`）。
					 *   若它被**继承**给我们的 spawn，`electron.exe` 会退化成纯 Node
					 *   ⇒ `require('electron')` 拿不到 `app`
					 *   ⇒ 子进程立刻报 `Cannot read properties of undefined (reading 'whenReady')`
					 *     并退出；而 `stdio:'ignore'` 又把报错吞了
					 *   ⇒ 用户看到的就是「**点了以后没有任何反应**」。
					 *
					 *   实测对照：同一个 main.cjs，带该变量跑 → 秒退；清掉后跑 → `MINI_SHELL_READY` ✓
					 *
					 *   ⇒ 显式删掉它（**只影响这一个子进程**，不动宿主自己的环境）。
					 */
					const childEnv = Object.assign({}, process.env);
					delete childEnv.ELECTRON_RUN_AS_NODE;
					delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;

					const child = spawn(electronExe, ['main.cjs'], {
						cwd: appDir,              // ★ 必须：否则相对入口找不到
						detached: true,           // 宿主退出不影响小窗
						stdio: 'ignore',
						windowsHide: false,
						env: childEnv,            // ★ 关键：清掉 ELECTRON_RUN_AS_NODE
					});
					child.unref();
					return {
						ok: true, launched: true, path: electronExe, pid: child.pid, app: appDir,
						hint: '小窗已启动（无边框 + 可置顶 + 可拖出应用）',
					};
				} catch (e) {
					return { ok: false, launched: false, hint: 'spawn 失败：' + String((e && e.message) || e) };
				}
			} catch (e) {
				return { ok: false, launched: false, hint: '启动小窗失败：' + String((e && e.message) || e) };
			}
		}

		/**
		 * 生成「小窗 app」的主进程代码。
		 *
		 * 形态**照抄 companion 的窗口参数**（app.asar 里读到的官方写法）：
		 *   `frame:false` + `transparent:true` + `alwaysOnTop`（可切换）
		 * 内容用 **iframe 载入 DSH 的 `?dsh-mini=1`** —— 不搬 React DOM（避免合成事件跨文档失效）。
		 *
		 * @param {string} target - 要在小窗里加载的 URL。
		 * @returns {string} main.cjs 源码。
		 */
		function buildMiniShellMain(target) {
			// ⚠️ 下面这段是**生成给 Electron 跑的字符串**，不是在宿主里执行的代码。
			//   为避免模板字符串嵌套地狱，用数组 join。
			return [
				"'use strict';",
				"const { app, BrowserWindow, ipcMain, session } = require('electron');",
				"const path = require('node:path');",
				"const fs = require('node:fs');",
				"const os = require('node:os');",
				"const crypto = require('node:crypto');",
				'',
				'const TARGET = ' + JSON.stringify(target) + ';',
				// ★★ ORIGIN 必须显式定义！
				//   2026-10-11 实测事故：`createWindow()` 里写 `win.loadURL(ORIGIN + "/dsh-mini-window/shell")`，
				//   但**生成代码里从来没定义过 ORIGIN** ⇒ `ReferenceError: ORIGIN is not defined`
				//   ⇒ `createWindow()` 直接抛 ⇒ **窗口根本没被创建** ⇒ 用户报「连框都出现不了了」。
				//   ⚠️ 教训：**生成字符串代码时，用到的每个变量都必须同批生成，
				//      且要有断言守住"生成物里没有未定义引用"**（见探针 mini-shell-e2e 的检查）。
				'const ORIGIN = new URL(TARGET).origin;',
				'const W = 520, H = 720;',
				'',
				'// ══════════════════════════════════════════════════════════════════',
				'// ★★★ 认证：自签 DSH 会话 cookie（2026-10-11 实测必需）',
				'//',
				'//   症状：小窗开出来了、外壳与顶栏都对，但**内容是黑的**。',
				'//   真因：DSH 的 Web 服务要求认证（不带 cookie 请求首页实测 **HTTP 401**），',
				'//         而新起的 Electron 窗口是**全新 session、没有那枚 cookie**。',
				'//',
				'//   解法（照抄 companion/main.js:246-330 的成熟实现，不是自创）：',
				'//     · secret   = ~/.dsh/.credentials.yaml →',
				'//                  `client-connection/browser-session` 段里的 32 字节 base64url',
				'//     · cookie 名 = `dsh-auth-` + base64url(sha256(authority))，authority = host:port',
				'//     · cookie 值 = `v1.<base64url(json)>.<base64url(hmacSha256(secret, body))>`',
				'//     · 用 Electron 的 session.cookies.set 注入到**本进程自己的** partition',
				'//   ⇒ 读一次 secret 即可自签出合法 HttpOnly 会话 cookie，',
				'//     **不读取、不解密、不复用 DSH 的 cookie 数据库**。',
				'// ══════════════════════════════════════════════════════════════════',
				"const SESSION_COOKIE_PREFIX = 'dsh-auth-';",
				'',
				'/** base64url（无填充），与 DSH 内部 encodeBase64Url 等价。 */',
				'function toBase64Url(buf) {',
				"  return Buffer.from(buf).toString('base64')",
				"    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');",
				'}',
				'',
				'/** 从 Harness home 的凭据文件里读出 32 字节会话签名密钥；读不到返回 undefined。 */',
				'function readSessionSecret() {',
				'  try {',
				"    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');",
				"    const yml = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');",
				"    const at = yml.indexOf('client-connection/browser-session');",
				'    if (at < 0) return undefined;',
				'    const seg = yml.slice(at, at + 800);',
				'    const m = /secret:\\s*([A-Za-z0-9_-]{20,})/.exec(seg);',
				'    if (!m) return undefined;',
				"    const raw = m[1].replaceAll('-', '+').replaceAll('_', '/');",
				"    const secret = Buffer.from(raw, 'base64');",
				'    return secret.length === 32 ? secret : undefined;',
				'  } catch (e) { return undefined; }',
				'}',
				'',
				'/** 用 secret 为指定 authority 签一枚会话 cookie。 */',
				'function mintSessionCookie(secret, authority) {',
				'  const name = SESSION_COOKIE_PREFIX',
				"    + toBase64Url(crypto.createHash('sha256').update(authority).digest());",
				'  const now = Date.now();',
				'  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 30 * 24 * 3600 * 1000 };',
				"  const body = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));",
				"  const sig = toBase64Url(crypto.createHmac('sha256', secret).update(body).digest());",
				'  return { name: name, value: "v1." + body + "." + sig };',
				'}',
				'',
				'/** 把自签 cookie 注入本进程的 session（失败只记日志，不阻塞开窗）。 */',
				'async function installAuthCookie(ses) {',
				'  try {',
				'    const secret = readSessionSecret();',
				"    if (!secret) { process.stdout.write('NO_SECRET\\n'); return false; }",
				'    const u = new URL(TARGET);',
				'    const c = mintSessionCookie(secret, u.host);',
				'    await ses.cookies.set({',
				'      url: u.origin, name: c.name, value: c.value, path: "/",',
				'      httpOnly: true, sameSite: "strict",',
				'      expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,',
				'    });',
				"    process.stdout.write('COOKIE_OK\\n');",
				'    return true;',
				"  } catch (e) { process.stdout.write('COOKIE_FAIL ' + String(e && e.message) + '\\n'); return false; }",
				'}',
				'',
				'/** 造窗口 + 先注入认证 cookie + 再加载外壳。 */',
				'async function createWindow() {',
				'  // ★★★ 先注入自签 cookie（否则 iframe 里是 401 ⇒ 全黑）',
				'  const hasAuth = await installAuthCookie(session.defaultSession);',				'',
				'  const win = new BrowserWindow({',
				'    width: W, height: H, useContentSize: true,',
				'    frame: false, transparent: true, backgroundColor: "#00000000",',
				'    resizable: true, minimizable: true, maximizable: false,',
				'    skipTaskbar: false, hasShadow: true, show: false,',
				'    title: "DSH 小窗", alwaysOnTop: true,',
				'    webPreferences: {',
				'      contextIsolation: true, sandbox: true, nodeIntegration: false,',
				'      preload: path.join(__dirname, "preload.cjs"),',
				'    },',
				'  });',
				'  try { win.setAlwaysOnTop(true, "screen-saver"); } catch (e) {}',
				'',
				'  // ★★★ 外壳页必须**从 DSH 自己的 origin 加载**（同站），',
				'  //   否则 iframe 是**跨站**、cookie 是 SameSite=Strict ⇒ **不会发送** ⇒ 401。',
				'  //   （2026-10-11 实测踩到：用 data: URL 装外壳时，iframe 里的 DSH 恒 401，',
				'  //     而单独测"顶层导航"却是 200 —— 差异就在同站/跨站。）',
				'  win.loadURL(ORIGIN + "/dsh-mini-window/shell");',
				'  win.once("ready-to-show", () => win.show());',
				'',
				'  let pinned = true;',
				'  ipcMain.handle("mini-op", (_e, op) => {',
				'    if (op === "min") { win.minimize(); return true; }',
				'    if (op === "close") { win.close(); return true; }',
				'    if (op === "pin") { pinned = !pinned; try { win.setAlwaysOnTop(pinned, "screen-saver"); } catch (e) {} return pinned; }',
				'    if (op === "compact") {',
				'      const b = win.getBounds();',
				'      const small = b.width > 460;',
				'      win.setBounds({ x: b.x, y: b.y, width: small ? 400 : W, height: small ? 460 : H });',
				'      return small;',
				'    }',
				'    return false;',
				'  });',
				'  return win;',
				'}',
				'',
				'/** 小窗外壳：55px 顶栏（companion 同款）+ iframe 装 DSH 页面。',
				' *  @param hasAuth 是否成功注入了认证 cookie；false 时显示明确原因（而不是黑屏） */',
				'function buildShellHtml(hasAuth) {',
				'  const css = [',
				'    "*{margin:0;padding:0;box-sizing:border-box}",',
				'    "html,body{height:100%;overflow:hidden;background:#1a1a1a;color:#e8e8e8;",',
				'    "  font:13px/1.4 system-ui,-apple-system,\\"Segoe UI\\",sans-serif}",',
				'    "#bar{position:absolute;left:0;right:0;top:0;height:55px;background:#232528;",',
				'    "  border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;gap:4px;",',
				'    "  padding:0 8px;-webkit-app-region:drag;user-select:none;z-index:10}",',
				'    "#bar button{-webkit-app-region:no-drag;width:28px;height:28px;border:0;border-radius:6px;",',
				'    "  background:transparent;color:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center}",',
				'    "#bar button:hover{background:rgba(255,255,255,.10)}",',
				'    "#bar button.active{background:rgba(255,255,255,.16)}",',
				'    "#bar svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6;",',
				'    "  stroke-linecap:round;stroke-linejoin:round}",',
				'    ".sp{flex:1 1 auto}",',
				'    "#err{position:absolute;left:16px;right:16px;top:80px;padding:14px 16px;border-radius:10px;",',
				'    "  background:rgba(220,80,80,.16);border:1px solid rgba(220,80,80,.35);",',
				'    "  color:#ffd9d9;font-size:13px;line-height:1.7;z-index:20}",',
				'    "#view{position:absolute;left:0;right:0;top:55px;bottom:0;width:100%;border:0;background:#1a1a1a}",',
				'  ].join("");',
				'  const svg = {',
				'    min: \'<svg viewBox="0 0 16 16"><path d="M1 8h14"/></svg>\',',
				'    pin: \'<svg viewBox="0 0 16 16"><path d="M5 2h6l-1 4.5L14 9.5v1H2v-1l4-3L5 2z"/><path d="M8 10.5V15.5"/></svg>\',',
				'    compact: \'<svg viewBox="0 0 16 16"><rect x="0.8" y="1.5" width="14.4" height="13" rx="2.5"/><rect x="8" y="7.5" width="6" height="5.5" rx="1"/></svg>\',',
				'    close: \'<svg viewBox="0 0 16 16"><path d="M3 3l10 10M13 3L3 13"/></svg>\',',
				'  };',
				'  return [',
				'    "<!doctype html><html><head><meta charset=\\"utf-8\\"><style>", css, "</style></head><body>",',
				'    \'<div id="bar">\',',
				'    \'<button id="min" title="最小化">\', svg.min, "</button>",',
				'    \'<button id="pin" class="active" title="已置顶（点击取消）">\', svg.pin, "</button>",',
				'    \'<span class="sp"></span>\',',
				'    \'<button id="compact" title="紧凑">\', svg.compact, "</button>",',
				'    \'<button id="close" title="关闭">\', svg.close, "</button>",',
				'    "</div>",',
				'    // ★ 认证失败时显示**明确原因**，而不是让用户看到一片黑',
				'    hasAuth ? "" : \'<div id="err">认证失败：读不到 DSH 会话密钥，小窗内无法加载页面。<br>请确认 ~/.dsh/.credentials.yaml 存在该段落。</div>\',',
				'    \'<iframe id="view" src="\' + TARGET + \'"></iframe>\',',
				'    "<script>",',
				'    "document.getElementById(\\"min\\").onclick=()=>window.miniWin.min();",',
				'    "document.getElementById(\\"close\\").onclick=()=>window.miniWin.close();",',
				'    "document.getElementById(\\"compact\\").onclick=()=>window.miniWin.compact();",',
				'    "document.getElementById(\\"pin\\").onclick=(ev)=>{const b=ev.currentTarget;window.miniWin.pin().then(p=>{b.classList.toggle(\\"active\\",p);b.title=p?\\"已置顶（点击取消）\\":\\"未置顶（点击置顶）\\";});};",',
				'    "</scr" + "ipt></body></html>",',
				'  ].join("");',
				'}',
				'',
				'app.whenReady().then(() => {',
				'  createWindow();',
				'  process.stdout.write("MINI_SHELL_READY\\n");',
				'});',
				'app.on("window-all-closed", () => app.quit());',
				'',
			].join('\n');
		}

		/** 生成小窗 app 的 preload（只暴露三个无参方法，不给任何文件/命令能力）。 */
		function buildMiniShellPreload() {
			return [
				"'use strict';",
				"const { contextBridge, ipcRenderer } = require('electron');",
				'contextBridge.exposeInMainWorld("miniWin", {',
				'  min: () => ipcRenderer.invoke("mini-op", "min"),',
				'  close: () => ipcRenderer.invoke("mini-op", "close"),',
				'  pin: () => ipcRenderer.invoke("mini-op", "pin"),',
				'  compact: () => ipcRenderer.invoke("mini-op", "compact"),',
				'});',
				'',
			].join('\n');
		}

		/**
		 * 生成**小窗外壳页**（由 host 在 DSH 同源下提供，见路由里的 `shell` 分支）。
		 *
		 * 为什么要有这个函数、而不是让小窗 app 自己拼 HTML：
		 *   外壳必须**与 DSH 同源**，否则里面的 iframe 是跨站、`SameSite=Strict`
		 *   的会话 cookie 不会被发送 ⇒ 401（实测踩过）。
		 *   ⇒ 外壳由 DSH 自己的 origin 返回，iframe 即同站。
		 *
		 * 外壳内容：55px 顶栏（companion 同款 4 个按钮）+ iframe 装 DSH 页面。
		 * 顶栏按钮通过 `window.miniWin`（preload 暴露）调主进程。
		 *
		 * @param {object} seed - `{ "<origin>": { "<key>": "<value>" } }`。
		 *   会在 iframe **出现之前**写进 localStorage —— 见下方 seedJs 的注释。
		 */
		function buildShellPage(seed) {
			const css = [
				'*{margin:0;padding:0;box-sizing:border-box}',
				'html,body{height:100%;overflow:hidden;background:#1a1a1a;color:#e8e8e8;',
				'  font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}',
				'#bar{position:absolute;left:0;right:0;top:0;height:55px;background:#232528;',
				'  border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;gap:4px;',
				'  padding:0 8px;-webkit-app-region:drag;user-select:none;z-index:10}',
				'#bar button{-webkit-app-region:no-drag;width:28px;height:28px;border:0;border-radius:6px;',
				'  background:transparent;color:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center}',
				'#bar button:hover{background:rgba(255,255,255,.10)}',
				'#bar button.active{background:rgba(255,255,255,.16)}',
				'#bar svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6;',
				'  stroke-linecap:round;stroke-linejoin:round}',
				'.sp{flex:1 1 auto}',
				// ★ iframe 高度：`inset` + 显式 `height` 双保险。
				//   实测教训：只写 `top:55px;bottom:0` 时，iframe 高度**塌陷成默认 150px**
				//   （量到 `iframe{h:150}`、`htmlHeightCss:"150px"`）⇒ 用户看到"只展示一小块、
				//   下面全黑"。原因是 absolute 定位的包含块在这条 `height:100%` 链路里没被撑开。
				//   ⇒ 同时给 `inset:55px 0 0 0`（四边定位）与 `height:calc(100vh - 55px)`（明确高度）。
				'#view{position:absolute;inset:55px 0 0 0;width:100%;height:calc(100vh - 55px);',
				'  border:0;background:#1a1a1a;display:block}',
			].join('');
			const svg = {
				min: '<svg viewBox="0 0 16 16"><path d="M1 8h14"/></svg>',
				pin: '<svg viewBox="0 0 16 16"><path d="M5 2h6l-1 4.5L14 9.5v1H2v-1l4-3L5 2z"/><path d="M8 10.5V15.5"/></svg>',
				compact: '<svg viewBox="0 0 16 16"><rect x="0.8" y="1.5" width="14.4" height="13" rx="2.5"/><rect x="8" y="7.5" width="6" height="5.5" rx="1"/></svg>',
				close: '<svg viewBox="0 0 16 16"><path d="M3 3l10 10M13 3L3 13"/></svg>',
			};
			// ── localStorage seed 注入脚本 ────────────────────────────────
			//
			// ★ 必须放在 <head> 最前面 ⇒ 早于 iframe 出现 ⇒ 页面脚本运行时已能读到。
			//
			//   已用**带负路径**的实验证明同源共享：
			//     `probe/same-origin-ls-seed.cjs` ⇒ A 组 SEEN 3/3、B 组（不写）SEEN 0/3
			//
			//   ★ 只在**缺失时**写入：小窗里用户可能已点掉过引导，
			//     用宿主旧快照覆盖会把用户的更新冲掉（companion 明确写了这条）。
			const seedJs = (function () {
				try {
					if (!seed || typeof seed !== 'object') return '';
					let count = 0;
					for (const bucket of Object.values(seed)) {
						if (bucket && typeof bucket === 'object') count += Object.keys(bucket).length;
					}
					if (count === 0) return '';
					return 'try{(function(){var S=' + JSON.stringify(seed) + ';'
						+ 'var b=S[location.origin];if(!b)return;var n=0,k;'
						+ 'for(k in b){try{if(localStorage.getItem(k)===null){localStorage.setItem(k,b[k]);n++;}}catch(e){}}'
						+ 'window.__dshMiniSeedCount=n;}())}catch(e){}';
				} catch { return ''; }
			})();

			return [
				'<!doctype html><html><head><meta charset="utf-8"><title>DSH 小窗</title>',
				// ★ seed 脚本置顶：必须早于 iframe，页面脚本才读得到
				seedJs ? '<script>' + seedJs + '</scr' + 'ipt>' : '',
				'<style>',
				css,
				'</style></head><body>',
				'<div id="bar">',
				'<button id="min" title="最小化">', svg.min, '</button>',
				'<button id="pin" class="active" title="已置顶（点击取消）">', svg.pin, '</button>',
				'<span class="sp"></span>',
				'<button id="compact" title="紧凑">', svg.compact, '</button>',
				'<button id="close" title="关闭">', svg.close, '</button>',
				'</div>',
				// ★ 同源 iframe（相对路径）⇒ `SameSite=Strict` 的 cookie 才会发送。
				//
				// ★★ 2026-10-11 用户实测「只展示了一小块地方」的两个真因，都在这行与上面的 CSS：
				//
				//   ① **不能再带 `?dsh-mini=1`**！
				//      外壳已经提供 55px 顶栏了；若 iframe 里也带 `dsh-mini=1`，
				//      插件会在 iframe 内部**再画一个顶栏** ⇒ **双顶栏**（用户截图里两条深色横条）。
				//      现在 iframe 用**普通 DSH 页面**（不带参数），顶栏只由外壳提供。
				//
				//   ② **高度不能靠 `bottom:0`**：实测 iframe 高度塌陷成**默认 150px**
				//      （量到 `iframe{h:150}` / `htmlHeightCss:"150px"`），下面是黑的。
				//      原因：`position:absolute` 的包含块是 initial containing block，
				//      它在 `html,body{height:100%}` 的链路里没被撑开。
				//      ⇒ 改用 **`inset:55px 0 0 0` + 显式 `height:calc(100vh - 55px)`** 双保险。
				'<iframe id="view" src="/"></iframe>',
				'<script>',
				'(function(){',
				'  var w = window.miniWin || null;',
				'  function call(op){ try { if (w && w[op]) w[op](); } catch (e) {} }',
				'  var bMin = document.getElementById("min"); if (bMin) bMin.onclick = function(){ call("min"); };',
				'  var bCls = document.getElementById("close"); if (bCls) bCls.onclick = function(){ call("close"); };',
				'  var bCmp = document.getElementById("compact"); if (bCmp) bCmp.onclick = function(){ call("compact"); };',
				'  var bPin = document.getElementById("pin");',
				'  if (bPin) bPin.onclick = function(ev){',
				'    var b = ev.currentTarget;',
				'    try { w.pin().then(function(p){ b.classList.toggle("active", p);',
				'      b.title = p ? "已置顶（点击取消）" : "未置顶（点击置顶）"; }); } catch (e) {}',
				'  };',
				'})();',
				'</scr' + 'ipt></body></html>',
			].join('');
		}

		/**
		 * 单一前缀路由，路径形如：
		 *   `POST /dsh-mini-window/open`
		 *   `POST /dsh-mini-window/close|toggle|pin|minimize|compact`
		 *   `GET  /dsh-mini-window/state`
		 *   `GET  /dsh-mini-window/probe`   ← 能力探测（真调用，供验收）
		 */
		const route = {
			kind: 'prefix',
			path: ROUTE_PREFIX,
			handler: async (req, res) => {
				try {
					const url = String(req.url || '');
					// 去掉查询串；路径形如 /dsh-mini-window/<action>
					const pathOnly = url.split('?')[0];
					const rest = pathOnly.slice(ROUTE_PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '');
					const action = rest || 'state';

					if (!methodOk(req, ['GET', 'POST'])) { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return; }

					if (action === 'probe') {
						const p = await probeElectron();
						sendJson(res, 200, { ok: p.ok, electron: p });
						return;
					}

					/**
					 * ★★★ 浏览器小窗的**启动页**（`/dsh-mini-window/boot`）。
					 *
					 * 为什么需要它（而不是 302 直接到 `/?dsh-mini=1`）：
					 *   小窗用的是**独立浏览器 profile** ⇒ 那块 localStorage 是空的
					 *   ⇒ 插件会以为"全新安装" ⇒ 弹新手引导 / 更新检测（用户明确抱怨过）。
					 *
					 *   而这一步**必须由 DSH 同源页面来做**（localStorage 按 origin 隔离）
					 *   ⇒ 由本路由返回一个极小的同源页面：写 seed → `location.replace('/?dsh-mini=1')`。
					 *
					 * 时序：此时已经带上了自签会话 cookie（由一次性服务 Set-Cookie 下发，
					 * 且 **cookie 忽略端口**）⇒ 这个请求是**已认证**的 ⇒ 能正常返回。
					 */
					if (action === 'boot') {
						let seed = {};
						try {
							const origin = String((opts && opts.resolveOrigin && opts.resolveOrigin()) || '')
								.replace(/\/+$/, '') || 'http://127.0.0.1:19387';
							seed = (getHostSeed(origin).seed) || {};
						} catch { seed = {}; }

						const seedJson = JSON.stringify(seed)
							.replace(/</g, '\\u003c')       // 防 `</script>` 提前闭合
							.replace(/\u2028|\u2029/g, ' '); // 防 JS 里裸的行分隔符（语法错误来源之一）

						// ★★ 关键修法：**跳转不再依赖内联脚本**
						//
						//   实测教训（批次33）：原先把 seed 内联 + 用 `location.replace` 跳转，
						//   结果 seed 撑到 102,577 字节、**内联脚本语法出错**（`node --check` 报
						//   `SyntaxError: Unexpected identifier 'location'`）⇒ 跳转**永不执行**
						//   ⇒ 用户看到的就是永久停在「启动小窗…」。
						//
						//   现在三层保险：
						//     ① seed 走**外部脚本**（`<script src>`）—— 语法错误不会污染主文档
						//     ② 跳转用 **`<meta http-equiv="refresh">`** —— 就算脚本整个挂掉也一定跳
						//     ③ 仍保留脚本内的即时跳转（正常情况下更快）
						const html = '<!doctype html><html><head><meta charset="utf-8">'
							+ '<title>DSH</title>'
							// ② 兜底跳转（1 秒）
							+ '<meta http-equiv="refresh" content="1;url=/?dsh-mini=1">'
							// ① seed 走外部脚本
							+ '<script src="/dsh-mini-window/boot-seed"></scr' + 'ipt>'
							// ③ 脚本正常时立刻跳（不等那 1 秒）
							+ '<script>location.replace("/?dsh-mini=1");</scr' + 'ipt>'
							+ '</head>'
							+ '<body style="margin:0;background:#1a1a1a;color:#888;font:13px system-ui;'
							+ 'display:flex;align-items:center;justify-content:center;height:100vh">启动小窗…</body></html>';
						res.writeHead(200, {
							'content-type': 'text/html; charset=utf-8',
							'cache-control': 'no-store',
						});
						res.end(html);
						return;
					}

					/**
					 * boot 页的 **seed 外部脚本**（`/dsh-mini-window/boot-seed`）。
					 *
					 * 为什么要拆出来：内联脚本一旦语法出错，整个 `<script>` 块被丢弃，
					 * 连**跳转**都会一起失效（实测教训，见 `/boot` 的注释）。
					 * 拆成外部资源后，它挂掉也只影响注入这一件事。
					 */
					if (action === 'boot-seed') {
						let seed = {};
						try {
							const origin = String((opts && opts.resolveOrigin && opts.resolveOrigin()) || '')
								.replace(/\/+$/, '') || 'http://127.0.0.1:19387';
							seed = (getHostSeed(origin).seed) || {};
						} catch { seed = {}; }

						const seedJson = JSON.stringify(seed)
							.replace(/</g, '\\u003c')
							.replace(/\u2028|\u2029/g, ' ');
						// 只在缺失时写入（不覆盖小窗里用户已改过的状态）
						// ★ 顺带提供 `__dshMiniFit(w,h)`：让 host 能精确把**浏览器视口**
						//   调成目标尺寸。为什么必须由页面来做：
						//   实测 `window.resizeTo` 被 Chrome 忽略，但 `resizeBy` 有效；
						//   而 Win32 的 clientRect ≠ 浏览器 innerHeight（差 31px，Chromium 自绘装饰）
						//   ⇒ 只有在页面里才知道"还差多少"，这个差值不能硬编码。
						const js = 'try{(function(){var S=' + seedJson + ';var b=S[location.origin];'
							+ 'if(b){var n=0,k;for(k in b){try{if(localStorage.getItem(k)===null){localStorage.setItem(k,b[k]);n++;}}catch(e){}}'
							+ 'window.__dshMiniSeedCount=n;}else{window.__dshMiniSeedCount=-1;}}())}catch(e){window.__dshMiniSeedCount=-2;}'
							+ 'try{window.__dshMiniFit=function(w,h){try{var dw=Math.round(w-innerWidth),dh=Math.round(h-innerHeight);'
							+ 'if(dw||dh)window.resizeBy(dw,dh);return {dw:dw,dh:dh,iw:innerWidth,ih:innerHeight};'
							+ '}catch(e){return {err:String(e&&e.message)};}};}catch(e){}';
						res.writeHead(200, {
							'content-type': 'application/javascript; charset=utf-8',
							'cache-control': 'no-store',
						});
						res.end(js);
						return;
					}

					/**
					 * ★★★ 小窗外壳页（**必须与 DSH 同源**）。
					 *
					 * 2026-10-11 实测踩到的关键坑：
					 *   外壳原先用 `data:text/html,...` 加载，里面的 `<iframe src="http://127.0.0.1:19387/">`
					 *   就是**跨站 iframe**；而 DSH 的会话 cookie 是 **`SameSite=Strict`**
					 *   ⇒ **浏览器不会在跨站 iframe 里发送它** ⇒ iframe 恒 **401**
					 *   ⇒ 用户看到的就是「小窗开出来了，但里面写着 authentication required」。
					 *
					 *   我之前的独立验证之所以"通过"，是因为那次是**顶层导航**（同站）——
					 *   环境不等价，结论就错了（本项目第 4 次同类教训）。
					 *
					 *   ⇒ 外壳改由 DSH 自己的 origin 提供（本路由），iframe 变成**同站**
					 *     ⇒ cookie 正常发送 ⇒ 页面正常渲染。
					 */
					if (action === 'shell') {
						// ★ 注入宿主 localStorage ⇒ 小窗里的插件**认为自己是老用户**
						//   ⇒ 不再弹新手引导 / 更新检测，插件的浮层也按用户上次的状态显示。
						//   失败不致命：seed 为空时外壳照常返回，只是小窗内部是"全新安装"。
						let seed = {};
						try {
							const origin = String((opts && opts.resolveOrigin && opts.resolveOrigin()) || '')
								.replace(/\/+$/, '') || 'http://127.0.0.1:19387';
							const r = getHostSeed(origin);
							seed = r.seed || {};
						} catch { seed = {}; }
						const html = buildShellPage(seed);
						res.writeHead(200, {
							'content-type': 'text/html; charset=utf-8',
							'cache-control': 'no-store',
						});
						res.end(html);
						return;
					}

					// GET 只允许读状态，避免被 <img>/链接误触发开窗
					if (String(req.method).toUpperCase() === 'GET' && action !== 'state') {
						sendJson(res, 405, { ok: false, error: 'use POST for ' + action });
						return;
					}

					const body = String(req.method).toUpperCase() === 'POST' ? await readJsonBody(req) : {};
					const out = await handleAction(action, body);
					sendJson(res, 200, out);
				} catch (err) {
					// 兜底：任何异常都只回 500，绝不冒泡（冒泡会让宿主判定 entry 未激活）
					sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
				}
			},
		};

		const dispose = ctx.effect(() => ctx.webServer.register(route), 'dsh-mini-window: mini window routes');
		return { controller, dispose };
	} catch {
		return null;
	}
}
