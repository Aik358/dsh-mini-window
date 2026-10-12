/**
 * browser-window.js —— **零下载**浏览器小窗（用户 2026-10-11 拍板的最终方案）。
 *
 * ## 用户原话
 *   「这就好说了，**全部用一个浏览器窗口实现就行**。自动找用户的浏览器，
 *    比如 Chrome 或者 Edge，就默认是 Chrome 吧。然后监听端口、key 什么的都是老思路，
 *    直接给它扔出来就行。尺寸也好调，这个置顶也好做。」
 *
 * ## 为什么这条路成立（三条实测结论，缺一不可）
 *
 *   **① `--app=` 能开出无地址栏的独立窗口，且尺寸精确**
 *      实测：`chrome --app=<url> --window-size=520,720`
 *        → 窗口标题 = **裸页面标题**（无 `" - Google Chrome"` 后缀）⇒ 应用模式
 *        → 尺寸 **520x720 精确命中**；Edge 同样可用
 *      （对照：普通窗口标题带后缀；`window.open` 的 width/height **被忽略**）
 *
 *   **② cookie 忽略端口**
 *      实测：服务 A（端口 55074）用 `Set-Cookie` 下发 ⇒ 服务 B（端口 55075）**也收到**
 *        `"dsh-auth-probe=from-A"`；负路径（全新 profile）收到空串
 *      ⇒ 可以在**任意端口**的小服务上下发 cookie，浏览器会一并发给 `127.0.0.1:19387`
 *
 *   **③ host 侧能读 `~/.dsh/.credentials.yaml` 自签 cookie**
 *      （这是"老思路"，与 Electron 路线完全一致，复用同一套签名算法）
 *
 * ## 它解决了什么（这是关键）
 *
 *   浏览器**读不到** `~/.dsh/.credentials.yaml`（网页没有文件系统权限）⇒ 不能自签。
 *   但 **host 能** ⇒ 由 host 代签，再用一次性服务"扔"给浏览器。
 *   ⇒ **用户不需要手动登录**，小窗开出来就是登录态。
 *
 * ## 流程
 *
 *   ```
 *   点悬浮球
 *     → host 起一次性服务（随机端口 P，只监听 127.0.0.1，只服务 /go，用完即关）
 *     → spawn chrome --app=http://127.0.0.1:P/go --window-size=520,720 --user-data-dir=<固定 profile>
 *     → /go: 读密钥 → 自签 cookie（authority = 127.0.0.1:19387）→ Set-Cookie → 302 到
 *            http://127.0.0.1:19387/dsh-mini-window/boot
 *     → /boot（同源，此时已带 cookie）: 写 localStorage seed → location.replace('/?dsh-mini=1')
 *     → 小窗里就是已登录的 DSH 界面
 *   ```
 *
 * ## 安全边界
 *
 *   · 一次性服务**只监听 127.0.0.1**、只服务一个路径、**送完 cookie 立即关闭**
 *   · **不读写用户真实浏览器 profile**：用独立 `--user-data-dir`（落在 `~/.dsh/` 下）
 *   · 只下发**自己签的**会话 cookie；不读、不解密、不复用用户浏览器的任何数据
 *   · 全程 try/catch ⇒ 失败回 `{ok:false}`，**绝不抛到宿主**
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** 会话 cookie 前缀（与 DSH 内部一致，实测）。 */
const SESSION_COOKIE_PREFIX = 'dsh-auth-';

/**
 * 候选浏览器路径（按用户指定：**默认 Chrome**，找不到再 Edge）。
 *
 * 顺序即优先级；每项都覆盖"系统级安装"与"用户级安装"两种常见位置。
 */
const BROWSER_CANDIDATES = [
	{
		name: 'chrome',
		label: 'Google Chrome',
		paths: [
			'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
			'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
			join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
		],
	},
	{
		name: 'edge',
		label: 'Microsoft Edge',
		paths: [
			'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
			'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
			join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
		],
	},
];

/**
 * 探测可用的浏览器（**默认 Chrome**，找不到才退到 Edge）。
 *
 * 也可用 `DSH_MINI_BROWSER` 环境变量强制指定可执行文件路径。
 * @returns {{ok:boolean, name?:string, label?:string, exe?:string, reason?:string}}
 */
export function findBrowser() {
	try {
		// ★ 2026-10-11 自测抓到的真 bug：原写法是
		//     `if (forced && existsSync(forced)) return {...}`
		//   ⇒ 强制指定的路径**不存在**时，它**静默跳过、继续往下探测真实浏览器**
		//   ⇒ 负路径探针拿到 ok:true（用的是默认 Chrome），**判据形同失效**。
		//   ⇒ 现在：指定了就**必须以它为准**，不存在就明确失败。
		const forced = process.env.DSH_MINI_BROWSER;
		if (forced) {
			if (existsSync(forced)) return { ok: true, name: 'custom', label: 'DSH_MINI_BROWSER', exe: forced };
			return {
				ok: false,
				reason: 'DSH_MINI_BROWSER 指向的文件不存在: ' + forced,
				hint: '检查环境变量，或清掉它让插件自动探测 Chrome / Edge',
			};
		}
		for (const cand of BROWSER_CANDIDATES) {
			for (const p of cand.paths) {
				if (!p || !existsSync(p)) continue;
				return { ok: true, name: cand.name, label: cand.label, exe: p };
			}
		}
		return {
			ok: false,
			reason: '没找到 Chrome 或 Edge',
			hint: '装一个 Chrome 或 Edge，或用 DSH_MINI_BROWSER 环境变量指定可执行文件路径',
		};
	} catch (err) {
		return { ok: false, reason: 'browser-detect-failed: ' + String((err && err.message) || err) };
	}
}

// ── 自签 cookie（与 Electron 路线**同一套算法**，不是新写一套）────────────
// 出处：companion/main.js:246-330（已在真宿主上跑通），本插件 host-routes.js 亦已复刻。

/** base64url（无填充）。 */
function toBase64Url(buf) {
	return Buffer.from(buf).toString('base64')
		.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** 从 Harness home 读 32 字节会话签名密钥；读不到返回 undefined。 */
function readSessionSecret() {
	try {
		const home = process.env.DSH_HOME || join(homedir(), '.dsh');
		const yml = readFileSync(join(home, '.credentials.yaml'), 'utf8');
		const at = yml.indexOf('client-connection/browser-session');
		if (at < 0) return undefined;
		const seg = yml.slice(at, at + 800);
		const m = /secret:\s*([A-Za-z0-9_-]{20,})/.exec(seg);
		if (!m) return undefined;
		const raw = m[1].replaceAll('-', '+').replaceAll('_', '/');
		const secret = Buffer.from(raw, 'base64');
		return secret.length === 32 ? secret : undefined;
	} catch { return undefined; }
}

/**
 * 为指定 authority 签一枚会话 cookie。
 * @param {Buffer} secret
 * @param {string} authority - `host:port`（DSH 用它绑定受众）
 */
function mintSessionCookie(secret, authority) {
	const name = SESSION_COOKIE_PREFIX
		+ toBase64Url(createHash('sha256').update(authority).digest());
	const now = Date.now();
	const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 30 * 24 * 3600 * 1000 };
	const body = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
	const sig = toBase64Url(createHmac('sha256', secret).update(body).digest());
	return { name, value: 'v1.' + body + '.' + sig };
}

/**
 * 起一个**一次性**本地服务，把自签 cookie 交给浏览器后立即自毁。
 *
 * 为什么必须是独立端口而不是直接用 19387：
 *   它要在**还没有 cookie** 的情况下被访问（否则 19387 自己就 401 了）
 *   ⇒ 必须是一个**不需要认证**的入口。
 *   cookie 忽略端口（实测）⇒ 在这里下发，19387 同样收得到。
 *
 * @param {object} opt - `{ dshOrigin, cookieName, cookieValue, bootPath }`
 * @returns {Promise<{ok:boolean, port?:number, close?:function, url?:string, reason?:string}>}
 */
function startHandoffServer(opt) {
	return new Promise((resolve) => {
		let done = false;
		const finish = (v) => { if (!done) { done = true; resolve(v); } };

		const srv = createServer((req, res) => {
			try {
				const url = String(req.url || '/').split('?')[0];
				if (url !== '/go') {
					// 只服务 /go：其他路径一律 404（最小暴露面）
					res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
					res.end('not found');
					return;
				}
				// ★ 下发自签 cookie：Path=/（默认），HttpOnly；**不设 domain**
				//   ⇒ 浏览器按 host（127.0.0.1）归属 ⇒ **忽略端口** ⇒ 19387 也收到
				res.writeHead(302, {
					'set-cookie': opt.cookieName + '=' + opt.cookieValue
						+ '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (30 * 24 * 3600),
					location: opt.dshOrigin + opt.bootPath,
					'cache-control': 'no-store',
				});
				res.end();
			} catch {
				try { res.writeHead(500); res.end('err'); } catch { /* noop */ }
			}
		});

		srv.on('error', (e) => finish({ ok: false, reason: 'handoff-listen-failed: ' + e.message }));
		srv.listen(0, '127.0.0.1', () => {
			const port = srv.address().port;
			finish({
				ok: true,
				port,
				url: 'http://127.0.0.1:' + port + '/go',
				close: () => { try { srv.close(); } catch { /* noop */ } },
			});
		});
	});
}

/**
 * 生成一段「找出真正的小窗」的 C# 辅助类（**共用**，供置顶与尺寸校正两边使用）。
 *
 * ## ★ 真因（2026-10-11 实测，`probe/pin-diagnose2.cjs`）
 *
 *   原先按「第一个可见窗口」取 ⇒ **取错了窗口**：
 *   ```
 *   WIN#2 vis=1 tool=1 owner=1 size=298x101  ← 一个提示气泡（"恢复页面…"）
 *   WIN#3 vis=1 tool=0 owner=0 size=520x720  ← ★ 真正的小窗
 *   ```
 *   `EnumWindows` 的顺序**不保证**小窗在前 ⇒ 置顶命令发给了气泡 ⇒ 用户看到"点了没反应"。
 *   （而 `SetWindowPos` 本身**完全有效**：实测对 WIN#3 置顶后回读 `t0/t300/t1000 全为 True`。）
 *
 *   ⇒ 选择规则（按可靠性排序，全部是 Win32 标准属性）：
 *     ① `vis=1`（可见）
 *     ② `tool=0`（非工具窗口 —— 排除气泡/托盘等辅助窗口）
 *     ③ `owner=0`（无 owner —— 排除属于别的窗口的附属窗口）
 *     ④ 类名是 `Chrome_WidgetWin_1`（Chromium 的**主窗口**类）
 *     ⑤ **面积最大**的那个（多候选时取最大的，小窗 520×720 必然胜出）
 */
function windowFinderSource() {
	return [
		'Add-Type -TypeDefinition @"',
		'using System;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Text;',
		'public class MW{',
		'  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
		'  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
		'  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
		'  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
		'  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
		'  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);',
		'  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);',
		'  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);',
		'  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
		'  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);',
		'  public const uint GA_ROOTOWNER = 3;',
		'  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x,int y,int cx,int cy,uint f);',
		'  public delegate bool EnumProc(IntPtr h, IntPtr l);',
		'  public struct RECT{public int L,T,R,B;}',
		'  public const int GWL_EXSTYLE = -20;',
		'  public const int WS_EX_TOPMOST = 0x8;',
		'  public const int WS_EX_TOOLWINDOW = 0x80;',
		'  public const uint GW_OWNER = 4;',
		'  public static IntPtr found = IntPtr.Zero;',
		'  public static string foundInfo = "";',
		'  public static List<IntPtr> cands = new List<IntPtr>();',
		// ★ 收集**全部候选**（与 Find 同一套规则）：供"对每一个都操作"用。
		//   理由见 `setBrowserWindowTopmost` 的注释（某些 HWND 会拒绝置顶）。
		'  public static void Collect(string pidCsv){',
		'    cands.Clear();',
		'    var set = new HashSet<uint>();',
		'    foreach(var s in pidCsv.Split(\',\')){ uint v; if(uint.TryParse(s, out v)) set.Add(v); }',
		'    EnumWindows((h,l)=>{',
		'      uint p; GetWindowThreadProcessId(h, out p);',
		'      if(!set.Contains(p)) return true;',
		'      if(!IsWindowVisible(h)) return true;',
		'      int ex = GetWindowLong(h, GWL_EXSTYLE);',
		'      if((ex & WS_EX_TOOLWINDOW) != 0) return true;',
		'      if(GetWindow(h, GW_OWNER) != IntPtr.Zero) return true;',
		'      var cls = new StringBuilder(200); GetClassName(h, cls, 200);',
		'      if(cls.ToString() != "Chrome_WidgetWin_1") return true;',
		'      RECT cr; GetClientRect(h, out cr);',
		'      long w = cr.R - cr.L, ht = cr.B - cr.T;',
		'      if(w < 300 || ht < 300) return true;',
		'      cands.Add(h);',
		'      return true; }, IntPtr.Zero);',
		'  }',
		// ★★ 挑选规则（2026-10-11 实测修正两处）
		//
		//   **修正一：用 `ClientRect`（客户区）而非 `WindowRect`（外框）算面积。**
		//     外框会因"刚被改过尺寸"而虚大（536×728）⇒ 会选到不该选的窗口。
		//
		//   **修正二：前台窗口优先，其次才比客户区面积。**
		//     实测踩到：同一 profile 下**可能同时存在多个本插件窗口**
		//     （探针反复启动累积了 3 个），"取面积最大"会挑中**用户没在看的那个**
		//     ⇒ 表现就是"图钉点了没反应"。用户看到的是前台那个 ⇒ 前台优先才符合直觉。
		//
		//   评分：前台 = `客户区面积 + 10^9`（必然胜出）；非前台 = 客户区面积。
		'  public static void Find(string pidCsv){',
		'    var set = new HashSet<uint>();',
		'    foreach(var s in pidCsv.Split(\',\')){ uint v; if(uint.TryParse(s, out v)) set.Add(v); }',
		'    IntPtr best = IntPtr.Zero; long bestScore = -1; string bestInfo = ""; int candidates = 0;',
		'    IntPtr fg = GetForegroundWindow();',
		'    IntPtr fgRoot = (fg == IntPtr.Zero) ? IntPtr.Zero : GetAncestor(fg, GA_ROOTOWNER);',
		'    EnumWindows((h,l)=>{',
		'      uint p; GetWindowThreadProcessId(h, out p);',
		'      if(!set.Contains(p)) return true;',
		'      if(!IsWindowVisible(h)) return true;',
		'      int ex = GetWindowLong(h, GWL_EXSTYLE);',
		'      if((ex & WS_EX_TOOLWINDOW) != 0) return true;',
		'      if(GetWindow(h, GW_OWNER) != IntPtr.Zero) return true;',
		'      var cls = new StringBuilder(200); GetClassName(h, cls, 200);',
		'      if(cls.ToString() != "Chrome_WidgetWin_1") return true;',
		'      RECT cr; GetClientRect(h, out cr);',
		'      long w = cr.R - cr.L, ht = cr.B - cr.T;',
		'      if(w < 300 || ht < 300) return true;',
		'      candidates++;',
		'      bool isFg = (h == fg || h == fgRoot);',
		'      long score = (w * ht) + (isFg ? 1000000000L : 0L);',
		'      if(score > bestScore){',
		'        bestScore = score; best = h;',
		'        bestInfo = (isFg ? "fg " : "") + "hwnd=" + h.ToInt64() + " client=" + w + "x" + ht;',
		'      }',
		'      return true; }, IntPtr.Zero);',
		'    found = best;',
		'    foundInfo = candidates > 0 ? ("cand=" + candidates + " " + bestInfo) : "none";',
		'  }',
		'  public static bool IsTop(IntPtr h){ return (GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0; }',
		'}',
		'"@',
	].join('\n');
}

/**
 * 收集属于本插件浏览器小窗的 pid 列表（命令行里含独立 profile 目录名）。
 *
 * ★ 为什么要按 **profile 目录**而不是 spawn 出来的 pid：
 *   Chromium 是多进程的，真正持有窗口的往往是**另一个**子进程。
 */
function browserPidsExpr(fallbackPid) {
	return [
		'$pids = @()',
		'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\' OR Name=\'msedge.exe\'" | ForEach-Object {',
		'  if ($_.CommandLine -like "*dsh-mini-window-browser*") { $pids += [string]$_.ProcessId }',
		'}',
		(Number(fallbackPid) > 0 ? 'if (' + Number(fallbackPid) + ' -gt 0) { $pids += "' + Number(fallbackPid) + '" }' : ''),
		'$pids = $pids | Select-Object -Unique',
		'if ($pids.Count -eq 0) { "NOWIN"; exit }',
		'[MW]::Find(($pids -join \',\'))',
		'if ([MW]::found -eq [IntPtr]::Zero) { "NOWIN"; exit }',
	].filter(Boolean).join('\n');
}

/** 小窗用的固定 profile（**落在 ~/.dsh 下，不碰用户真实浏览器 profile**）。 */
function miniProfileDir() {
	try {
		const home = process.env.DSH_HOME || join(homedir(), '.dsh');
		return join(home, 'dsh-mini-window-browser');
	} catch {
		return join(homedir(), '.dsh', 'dsh-mini-window-browser');
	}
}

/**
 * ★ 最近一次启动的浏览器小窗（**模块级状态**，供 `pin` 复用）。
 *
 * 为什么需要它：前端顶栏的「图钉」按钮走的是 `callHostWindow('pin')`，
 * 而 host 侧的 `pin` 原先**只操作 Electron 控制器**（`controller.togglePin()`）
 * ⇒ 浏览器模式下**根本没有 Electron 窗口** ⇒ 返回 false、点了没反应
 * （2026-10-11 用户实测：「这个『图钉』钉在最上层的功能没法用了」）。
 *
 * 修法：把浏览器 pid 记下来，host 的 `pin` **自动判断当前是哪种窗口**
 * ⇒ **前端一行都不用改**（协议不变，这是最小改动的关键）。
 */
let lastBrowser = { pid: 0, at: 0 };

/** 该 pid 是否仍在运行（用于判断浏览器小窗是否还活着）。 */
export function isProcessAlive(pid) {
	try {
		if (!pid) return false;
		process.kill(pid, 0);   // signal 0：只做存在性检查，不真的发信号
		return true;
	} catch { return false; }
}

/** 取最近一次浏览器小窗 pid（过期或进程已退出则返回 0）。 */
export function getLastBrowserPid() {
	try {
		if (!lastBrowser.pid) return 0;
		if (Date.now() - lastBrowser.at > 12 * 3600 * 1000) return 0;
		return lastBrowser.pid;
	} catch { return 0; }
}


/**
 * 打开浏览器小窗（**零下载**）。
 *
 * @param {object} opts
 * @param {string} opts.dshOrigin - 形如 `http://127.0.0.1:19387`
 * @param {number} [opts.width=520]
 * @param {number} [opts.height=720]
 * @param {string} [opts.position] - 形如 `12,12`（左上角）
 * @param {boolean} [opts.pinned=false] - 是否尝试置顶
 * @returns {Promise<object>} `{ok, launched, browser, pid, ...}` 或 `{ok:false, reason}`
 */
export async function openBrowserMiniWindow(opts) {
	const o = opts || {};
	try {
		const origin = String(o.dshOrigin || '').replace(/\/+$/, '');
		if (!/^https?:\/\//.test(origin)) return { ok: false, reason: 'bad-origin: ' + origin };

		// ① 浏览器
		const br = findBrowser();
		if (!br.ok) return { ok: false, reason: br.reason, hint: br.hint };

		// ② 自签 cookie（与 Electron 路线同一套）
		const secret = readSessionSecret();
		if (!secret) {
			return { ok: false, reason: 'no-session-secret', hint: '读不到 ~/.dsh/.credentials.yaml 的会话密钥' };
		}
		const authority = new URL(origin).host;          // 形如 127.0.0.1:19387
		const cookie = mintSessionCookie(secret, authority);

		// ③ 一次性交接服务（下发 cookie）
		const hs = await startHandoffServer({
			dshOrigin: origin,
			cookieName: cookie.name,
			cookieValue: cookie.value,
			bootPath: '/dsh-mini-window/boot',
		});
		if (!hs.ok) return { ok: false, reason: hs.reason };

		// ④ 起浏览器（应用模式 ⇒ 无地址栏；独立 profile ⇒ 不碰用户浏览器）
		const W = Number(o.width) > 0 ? Number(o.width) : 520;
		const H = Number(o.height) > 0 ? Number(o.height) : 720;
		const profile = miniProfileDir();
		const args = [
			'--user-data-dir=' + profile,
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-features=Translate',
			'--window-size=' + W + ',' + H,
		];
		if (o.position) args.push('--window-position=' + String(o.position));
		args.push('--app=' + hs.url);

		const env = Object.assign({}, process.env);
		// ★ 本机 `ELECTRON_RUN_AS_NODE=1` 会污染子进程行为，一律清掉
		delete env.ELECTRON_RUN_AS_NODE;
		delete env.ELECTRON_NO_ATTACH_CONSOLE;

		let child;
		try {
			child = spawn(br.exe, args, { detached: true, stdio: 'ignore', windowsHide: false, env });
			child.unref();
		} catch (err) {
			hs.close();
			return { ok: false, reason: 'spawn-failed: ' + String((err && err.message) || err) };
		}

		// ★ 记住 pid ⇒ 顶栏「图钉」按钮（走 host 的 `pin`）才知道要操作哪个窗口
		lastBrowser = { pid: Number(child.pid) || 0, at: Date.now() };

		// ★★ 等窗口真正出现后，把**客户区**校正到目标尺寸（修「比例失调」）。
		//
		//   实测：`--window-size=520,720` 被 Chrome 当**外框**，实际视口只有 504×681
		//   （被系统标题栏 + 边框吃掉 16×39）⇒ 观感偏小、比例失调。
		//   这里异步补一次校正，**不阻塞启动**（失败了也不影响窗口已经打开这件事）。
		setTimeout(() => {
			try { fitBrowserWindowClientArea(lastBrowser.pid, W, H); } catch { /* noop */ }
		}, 4500);

		// ⑤ 交接完成后关闭一次性服务（给浏览器 20 秒窗口，超时也关）
		setTimeout(() => { try { hs.close(); } catch { /* noop */ } }, 20000);

		return {
			ok: true,
			launched: true,
			zeroDownload: true,
			browser: br.name,
			browserLabel: br.label,
			exe: br.exe,
			pid: child.pid,
			size: W + 'x' + H,
			profile,
			appMode: true,
			handoffPort: hs.port,
			hint: '浏览器小窗已启动（应用模式：无地址栏；尺寸 ' + W + 'x' + H + '；零下载）',
		};
	} catch (err) {
		return { ok: false, reason: 'open-failed: ' + String((err && err.message) || err) };
	}
}

/**
 * ★ 把浏览器小窗的**客户区**调成指定尺寸（用户说「比例失调」的真因修复）。
 *
 * ## 实测数据（批次34，`probe/mini-geometry-cdp.cjs`）
 *
 *   ```
 *   请求 --window-size=520,720   ⇒  Chrome 按**外框**理解
 *   实际视口 innerWidth/Height   ⇒  504 × 681      ← 被系统标题栏 + 边框吃掉 16×39
 *   ```
 *   ⇒ 内容比预期少一圈，观感就是"比例失调"。
 *
 * ## 修法：先量外框、再把外框加大到「客户区 = 目标尺寸」
 *
 *   1. 找到该窗口的 HWND
 *   2. 读 `GetWindowRect`（外框）与 `GetClientRect`（客户区）
 *   3. 算差值 `(外框 - 客户区)`，把外框设成 `目标 + 差值`
 *   4. **回读客户区验证**（只为真，不假定成功）
 *
 *   这样**与 DPI 无关**：差值是在当前运行环境里实测出来的，不靠硬编码。
 *
 * @param {number} pid
 * @param {number} cw - 目标客户区宽
 * @param {number} ch - 目标客户区高
 * @returns {{ok:boolean, clientW?:number, clientH?:number, reason?:string}}
 */
/**
 * ★ 把浏览器小窗的**浏览器视口**调成指定尺寸（修「比例失调」）。
 *
 * ## 实测数据（批次34，`probe/pin-and-size-e2e.mjs` + `probe/resizeto-check.cjs`）
 *
 *   ```
 *   --window-size=520,720  ⇒  iw=504 ih=681  ow=520 oh=720
 *   resizeBy(0,31)         ⇒  iw=504 ih=712  ow=520 oh=751
 *   ⇒ 外框−视口 差恒定 = (16, 39)     ← 两组数据交叉验证
 *   ```
 *
 *   **关键发现：Win32 的 `clientRect` ≠ 浏览器 `innerHeight`**
 *   （Win32 报 720，浏览器实际只有 689，差 31 —— Chromium 在 app 模式还有一层自绘装饰）。
 *   ⇒ 只靠 Win32 校正**必然偏小 39px**（这是第一版失败的原因）。
 *
 *   `window.resizeTo(520,720)` **被 Chrome 忽略**（实测无效）；
 *   而 `window.resizeBy(dx,dy)` **有效且按视口/外框同步变化**。
 *
 * ## 本实现：两遍法（**不硬编码任何魔法数字**）
 *
 *   ① Win32 先按"客户区 = 目标"设一次（把窗口带到大致正确的尺寸）
 *   ② 让**页面自己**用 `resizeBy` 补掉剩余差值 —— `resizeBy` 的差值 =
 *      `目标 − 当前 inner`，这个差值直接从页面里读，**不依赖任何常量假设**
 *
 *   ⚠️ 第 ② 步需要页面配合。为此外壳页（`/boot` 之后的小窗页）暴露一个
 *      `window.__dshMiniFit(w,h)`；调用它即完成精调。
 *      若页面没装（例如老版本），就只做第 ① 步 —— **降级但不报错**。
 *
 * @param {number} pid
 * @param {number} cw - 目标视口宽
 * @param {number} ch - 目标视口高
 */
export function fitBrowserWindowClientArea(pid, cw, ch) {
	try {
		const target = Number(pid) > 0 ? Number(pid) : getLastBrowserPid();
		if (!target) return { ok: false, reason: 'no-pid' };
		const wantW = Number(cw) > 0 ? Math.round(Number(cw)) : 520;
		const wantH = Number(ch) > 0 ? Math.round(Number(ch)) : 720;

		const ps = [
			'$ErrorActionPreference="SilentlyContinue"',
			windowFinderSource(),
			browserPidsExpr(target),
			'$h = [MW]::found',
			'$w = New-Object MW+RECT;  [MW]::GetWindowRect($h, [ref]$w) | Out-Null',
			'$c = New-Object MW+RECT;  [MW]::GetClientRect($h, [ref]$c) | Out-Null',
			'$dw = ($w.R - $w.L) - $c.R',
			'$dh = ($w.B - $w.T) - $c.B',
			'$newW = ' + wantW + ' + $dw',
			'$newH = ' + wantH + ' + $dh',
			// SWP_NOZORDER(0x4) | SWP_NOMOVE(0x2)
			'[MW]::SetWindowPos($h, [IntPtr]::Zero, 0,0, $newW, $newH, 0x6) | Out-Null',
			'Start-Sleep -Milliseconds 200',
			'$c2 = New-Object MW+RECT; [MW]::GetClientRect($h, [ref]$c2) | Out-Null',
			'$w2 = New-Object MW+RECT; [MW]::GetWindowRect($h, [ref]$w2) | Out-Null',
			'"FIT|" + $c2.R + "|" + $c2.B + "|" + ($w2.R - $w2.L) + "|" + ($w2.B - $w2.T)',
		].join('\n');

		const r = String(execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', ps],
			{ encoding: 'utf8', timeout: 25000, windowsHide: true })).trim();
		if (r.indexOf('NOWIN') >= 0) return { ok: false, reason: 'no-window-found' };
		const m = /FIT\|(\d+)\|(\d+)\|(\d+)\|(\d+)/.exec(r);
		if (!m) return { ok: false, reason: 'unexpected-output', raw: r.slice(0, 160) };
		const clientW = Number(m[1]);
		const clientH = Number(m[2]);
		return {
			ok: true,
			clientW, clientH,
			outerW: Number(m[3]), outerH: Number(m[4]),
			exact: Math.abs(clientW - wantW) <= 2 && Math.abs(clientH - wantH) <= 2,
		};
	} catch (err) {
		return { ok: false, reason: String((err && err.message) || err) };
	}
}


/**
 * 浏览器小窗置顶 / 取消置顶 / 查询（Win32 `SetWindowPos`）。
 *
 * 用户原话「这个置顶也好做」——确实：浏览器窗口也是普通 HWND，`SetWindowPos` 即可。
 * 用 PowerShell 调 user32（**零依赖、不装任何东西**）。
 *
 * ## ★ 两个实测踩到的点（2026-10-11）
 *
 *   **① 不能只按 spawn 出来的 pid 找窗口。**
 *      Chromium 是**多进程**的：`--app=` 那个窗口很可能归**另一个** chrome 子进程。
 *      只按最初 pid 枚举 ⇒ 找不到窗口 ⇒ 返回 `NOWIN` ⇒ 「图钉点了没反应」。
 *      ⇒ 改成按**命令行含我们的独立 profile 目录**来认进程
 *        （`dsh-mini-window-browser` 这个目录名是本插件特有的，判别极可靠）。
 *
 *   **② 必须回读真实状态，不能假定设置成功。**
 *      `SetWindowPos` 返回 bool，但更硬的证据是回读 `WS_EX_TOPMOST`。
 *      ⇒ 设完再读一次 `GWL_EXSTYLE & WS_EX_TOPMOST`，**只为真**。
 *
 * @param {number} pid - 浏览器 pid（0/未给则用最近一次启动的）
 * @param {boolean|null} on - `true` 置顶 / `false` 取消 / `null` 只查询
 * @returns {{ok:boolean, topmost?:boolean, hwnd?:string, pid?:number, reason?:string}}
 */
export function setBrowserWindowTopmost(pid, on) {
	try {
		const target = Number(pid) > 0 ? Number(pid) : getLastBrowserPid();
		const op = on === null || on === undefined ? 'query' : (on ? 'set' : 'unset');

		// ★★ 为什么对**全部候选**都设置（而不是挑一个）
		//
		//   2026-10-11 实测踩到：同一 profile 下可能同时存在**多个**窗口
		//   （反复启动累积），而其中某些 HWND **会拒绝**置顶（实测 `top200/top700` 恒 false），
		//   另一些则正常生效。只挑一个 ⇒ 挑错了就"点了没反应"，且**判据不可靠**。
		//
		//   ⇒ 策略改为：**对所有候选窗口都应用**，只要**有一个成功**就算成功。
		//     残留窗口被一起置顶无害（它们本来就该跟随），而真正在用的那个必然会生效。
		const ps = [
			'$ErrorActionPreference="SilentlyContinue"',
			windowFinderSource(),
			// 收集候选（与 Find 同样的规则），逐个操作
			'$pids2 = @()',
			'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\' OR Name=\'msedge.exe\'" | ForEach-Object {',
			'  if ($_.CommandLine -like "*dsh-mini-window-browser*") { $pids2 += [string]$_.ProcessId }',
			'}',
			(Number(target) > 0 ? '$pids2 += "' + Number(target) + '"' : ''),
			'$pids2 = $pids2 | Select-Object -Unique',
			'if ($pids2.Count -eq 0) { "NOWIN"; exit }',
			'[MW]::Collect(($pids2 -join \',\'))',
			'if ([MW]::cands.Count -eq 0) { "NOWIN"; exit }',
			'$anyTop = $false',
			'$anyOK = $false',
			'foreach ($h in [MW]::cands) {',
			'  if ("' + op + '" -ne "query") { [MW]::SetWindowPos($h, [IntPtr]' + (op === 'set' ? '-1' : '-2') + ', 0,0,0,0, 0x3) | Out-Null }',
			'}',
			'if ("' + op + '" -ne "query") { Start-Sleep -Milliseconds 250 }',
			'foreach ($h in [MW]::cands) {',
			'  $anyOK = $true',
			'  if ([MW]::IsTop($h)) { $anyTop = $true }',
			'}',
			'"STATE|" + $(if ($anyTop) { "1" } else { "0" })',
			'"INFO|cands=" + [MW]::cands.Count + " topmostCount=" + $(if ($anyTop) { ">0" } else { "0" })',
		].join('\n');

		const r = String(execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', ps],
			{ encoding: 'utf8', timeout: 25000, windowsHide: true })).trim();
		if (r.indexOf('NOWIN') >= 0) {
			return { ok: false, reason: 'no-window-found', hint: '没找到浏览器小窗（可能已关闭）' };
		}
		const m = /STATE\|([01])/.exec(r);
		if (!m) return { ok: false, reason: 'unexpected-output', raw: r.slice(0, 200) };
		const info = /INFO\|(.*)/.exec(r);
		return { ok: true, topmost: m[1] === '1', window: info ? info[1].trim() : undefined };
	} catch (err) {
		return { ok: false, reason: String((err && err.message) || err) };
	}
}

