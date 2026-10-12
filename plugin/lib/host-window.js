/**
 * dsh-mini-window —— host 侧真窗口模块（把 companion 的实现搬进插件）。
 *
 * ## 这个文件做什么
 *
 *   在**宿主自己的 Electron 主进程里**创建一个「小窗」`BrowserWindow`：
 *   · 无边框 + 透明底 + 圆角（与 companion 同款）
 *   · **置顶可切换**（`setAlwaysOnTop`，用户明确要求做成可切换）
 *   · 可移动 / 可缩放（用户核心诉求：「能拖离宿主应用之外」）
 *   · 内容是 DSH 自己的页面（带 `?dsh-mini=1`）—— **不搬运别处，零下载**
 *
 * ## 为什么放在 host 侧而不是前端
 *
 *   前端的 `window.open()` 只能开出**普通浏览器窗口**（不能置顶、没有自绘顶栏）。
 *   而 host 侧**就跑在 Electron 主进程里** ⇒ 能拿到完整的 `BrowserWindow` 能力。
 *   实测取证（app.asar）：
 *     · `from "electron"` 有真实 import（powerMonitor/protocol/session/shell…）
 *     · DSH 主进程用 `BrowserWindow` 6 次、`Tray` 12 次、`setWindowOpenHandler` 7 次
 *     · 有 `@deepseek-ai/dsh-desktop-host` / `-runtime` 包
 *
 * ## ★ 两条硬性纪律（本项目已付过代价）
 *
 *   1. **绝不让可选 UI 的失败冒泡**：宿主以「entry 是否 activate」判定启动成败，
 *      一个装饰的异常 = 整个应用打不开（批次19 事故）。
 *      ⇒ 本模块所有对外函数**全部 try/catch 兜底**，失败只返回 null/打日志。
 *   2. **不能只靠静态证据**：`import('electron')` 在 host 侧能否成功，
 *      必须**真跑一次**才能说"可用"（本项目 CR-10）。
 *      ⇒ 提供 `probeElectron()` 供验收真调用。
 */

/** 小窗默认尺寸（与 companion 一致：520×720 客户区）。 */
export const WIN_W = 520;
export const WIN_H = 720;

/** 小窗最小尺寸（防止拖到不可用）。 */
export const WIN_MIN_W = 300;
export const WIN_MIN_H = 320;

/**
 * 动态取 Electron 模块。
 *
 * 为什么用 `import()` 而不是顶层 `import`：
 *   · 让**加载失败可被捕获**（顶层 import 失败会炸掉整个 host entry ⇒ 应用打不开）
 *   · 前端/浏览器环境下也能安全加载本文件（拿不到就返回 null）
 * @returns {Promise<object|null>} electron 模块；不可用时 null。
 */
export async function loadElectron() {
	try {
		const mod = await import('electron');
		// ESM/CJS 互操作：有的环境要 .default
		const e = mod && mod.BrowserWindow ? mod : (mod && mod.default) || null;
		return e && e.BrowserWindow ? e : null;
	} catch {
		return null;
	}
}

/**
 * 真调用探测：**能不能拿到 Electron 并创建窗口**。
 *
 * 这是给验收用的（本项目纪律：能力判定必须真调用，不能只看 `typeof`）。
 * @returns {Promise<{ok: boolean, reason?: string, hasWindow?: boolean}>}
 */
export async function probeElectron() {
	try {
		const e = await loadElectron();
		if (!e) return { ok: false, reason: 'import("electron") 失败或非 Electron 环境' };
		const okWindow = typeof e.BrowserWindow === 'function';
		return { ok: okWindow, hasWindow: okWindow, reason: okWindow ? undefined : 'BrowserWindow 不是构造器' };
	} catch (err) {
		return { ok: false, reason: String((err && err.message) || err) };
	}
}

/**
 * 创建一个「小窗」窗口。
 *
 * 窗口参数**照抄 app.asar 里读到的官方写法**（`desktop-host` 的授权弹窗）：
 *   `{ frame:false, transparent:true, show:false, skipTaskbar:true, hasShadow:false,
 *      webPreferences:{ contextIsolation:true, sandbox:true, nodeIntegration:false } }`
 *
 * 与官方那处的差异（都是 user 明确要求）：
 *   · `resizable: true`（用户要"能调整大小"）
 *   · `minimizable: true`（顶栏有最小化按钮）
 *   · `_alwaysOnTop` 由状态控制（用户要"置顶可切换"）
 *
 * @param {object} opts
 * @param {string} opts.url - 要加载的 URL（通常是 `http://127.0.0.1:<port>/?dsh-mini=1`）。
 * @param {boolean} [opts.alwaysOnTop] - 初始是否置顶。
 * @returns {Promise<object|null>} 窗口对象；失败返回 null（**绝不抛**）。
 */
export async function createMiniWindow(opts) {
	try {
		const e = await loadElectron();
		if (!e) return null;
		const url = (opts && opts.url) || '';
		if (!url) return null;

		const win = new e.BrowserWindow({
			width: WIN_W,
			height: WIN_H,
			minWidth: WIN_MIN_W,
			minHeight: WIN_MIN_H,
			// 不指定 x/y ⇒ 交给系统居中（用户可随后自由拖动）
			useContentSize: true,
			frame: false,
			transparent: true,
			backgroundColor: '#00000000',
			resizable: true,
			minimizable: true,
			maximizable: false,
			fullscreenable: false,
			skipTaskbar: false,
			hasShadow: true,
			show: false,
			title: 'DSH 小窗',
			alwaysOnTop: !!(opts && opts.alwaysOnTop),
			webPreferences: {
				contextIsolation: true,
				sandbox: true,
				nodeIntegration: false,
			},
		});

		// 置顶用 screen-saver 层级（跨平台最稳的"浮在所有窗口之上"）
		try { win.setAlwaysOnTop(!!(opts && opts.alwaysOnTop), 'screen-saver'); } catch { /* 平台不支持则忽略 */ }

		try {
			await win.loadURL(url);
			win.show();
		} catch {
			// 加载失败也要把窗口销毁，避免留一个空白窗口
			try { win.destroy(); } catch { /* noop */ }
			return null;
		}
		return win;
	} catch {
		return null;
	}
}

/**
 * 窗口控制台（供路由调用）。
 *
 * 设计：一个 `createMiniController()` 持有单个窗口引用，所有操作幂等且不抛。
 * @param {() => string} resolveUrl - 返回要加载的 URL（延迟解析，避免启动期取值）。
 */
export function createMiniController(resolveUrl) {
	/** @type {any} */
	let win = null;
	let pinned = true;

	function isAlive() {
		try { return !!win && !win.isDestroyed(); } catch { return false; }
	}

	return {
		/** 当前是否开着。 */
		isOpen() {
			try { return isAlive(); } catch { return false; }
		},

		/** 当前是否置顶。 */
		isPinned() {
			try { return isAlive() ? !!win.isAlwaysOnTop() : pinned; } catch { return pinned; }
		},

		/**
		 * 开窗（已开着则聚焦，不重复创建）。
		 * @returns {Promise<boolean>} 是否开着。
		 */
		async open() {
			try {
				if (isAlive()) {
					try { win.show(); win.focus(); } catch { /* noop */ }
					return true;
				}
				const url = typeof resolveUrl === 'function' ? resolveUrl() : '';
				win = await createMiniWindow({ url, alwaysOnTop: pinned });
				if (!win) return false;
				try {
					win.on('closed', () => { win = null; });
				} catch { /* noop */ }
				return true;
			} catch { return false; }
		},

		/** 关窗。未开窗时返回 false（表示"没有窗口被关"）。 */
		close() {
			try {
				if (!isAlive()) return false;
				win.close();
				return true;
			} catch { return false; }
		},

		/** 切换置顶；返回切换后的状态。 */
		togglePin() {
			try {
				pinned = !pinned;
				if (isAlive()) win.setAlwaysOnTop(pinned, 'screen-saver');
				return pinned;
			} catch { return pinned; }
		},

		/** 最小化。未开窗时返回 false（★ 曾写成恒 true 的假绿，见下）。 */
		minimize() {
			try {
				// ★ 2026-10-11 自测抓到的真缺陷：原写法
				//     `try { if (isAlive()) win.minimize(); return true; } catch { return false; }`
				//   在**未开窗**时也 `return true` —— 报告"最小化成功"但什么都没做。
				//   验收里 `minimize(未开窗)` 实测返回 true 才暴露出来。
				//   ⇒ 未开窗必须返回 false（调用方据此判断是否真的执行了）。
				if (!isAlive()) return false;
				win.minimize();
				return true;
			} catch { return false; }
		},

		/** 切换紧凑尺寸（companion 的 T7）。 */
		toggleCompact() {
			try {
				if (!isAlive()) return false;
				const b = win.getBounds();
				const compact = b.width > 460;
				if (compact) win.setBounds({ x: b.x, y: b.y, width: 400, height: 460 });
				else win.setBounds({ x: b.x, y: b.y, width: WIN_W, height: WIN_H });
				return compact;
			} catch { return false; }
		},
	};
}
