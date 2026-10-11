/**
 * DSH Companion — 独立伴随进程（悬浮球 + 小窗）
 *
 * 设计要点（对齐用户需求）：
 *  1. 完全独立于 DSH 客户端：不依赖 Electron 桌面壳，web 版也能用；
 *     只通过 HTTP 与 DSH Host 通信。
 *  2. 悬浮球默认在 DSH 窗口内（由 DSH 插件渲染）；
 *     "投到桌面"后由本进程渲染为独立置顶窗口。
 *  3. 小窗永远是独立顶层窗口（不是 DSH 的子窗口），
 *     可拖动、可钉（置顶）、位置持久化。
 *  4. 认证走 DSH 自己设计的通道：插件 host 侧生成带 ?token= 的 URL
 *     写入交接文件 → 本进程读取 → 换取签名 cookie → 之后免交接。
 *     **不读取、不解密、不复用 DSH 的 cookie 数据库。**
 */

'use strict';

// ---- 环境自检：必须在 require('electron') 之前 ---------------------------
// 本机陷阱（2026-10-11 实测）：DSH 的子进程 shell 自带 ELECTRON_RUN_AS_NODE=1，
//   electron.exe 会因为该变量退化成纯 Node 运行 ⇒ `electron` 模块解析成字符串路径，
//   app 变成 undefined，报 "Cannot read properties of undefined (reading 'getPath')""。
// 这里主动检出并给出可执行的修复提示，而不是抛出难以理解的二次错误。
if (process.env.ELECTRON_RUN_AS_NODE && !process.versions.electron) {
  console.error([
    '',
    '=== DSH Companion 启动失败：环境变量污染 ===',
    '',
    '检测到 ELECTRON_RUN_AS_NODE 已设置，Electron 被当作纯 Node 启动，',
    '因此拿不到 app / BrowserWindow 等 Electron API。',
    '',
    '修复：用自带的启动器（它会先清掉该变量）：',
    '    powershell -ExecutionPolicy Bypass -File E:\\dsh-mini-window-lab\\companion\\start.ps1',
    '',
    '或手动清除后启动：',
    '    Remove-Item Env:\\ELECTRON_RUN_AS_NODE',
    `    & "E:\\dsh-mini-window-lab\\companion\\node_modules\\electron\\dist\\electron.exe" E:\\dsh-mini-window-lab\\companion`,
    '',
  ].join('\n'));
  process.exit(78); // EX_CONFIG
}

const { app, BrowserWindow, ipcMain, screen, session, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

// ---- 常量 ----------------------------------------------------------------
const DSH_ORIGIN = process.env.DSH_ORIGIN || 'http://127.0.0.1:19387';
const PARTITION = 'persist:dsh-companion';
// 悬浮球尺寸：窗口 44px（含透明外圈，便于悬停放大不裁边），可见球体 36px。
// 上一版 64px 偏大，且球底是实心深色，观感像"贴了一块黑胶布"。
const BALL_SIZE = 44;
// 小窗尺寸。依据：参考小窗**客户区**实测 **520×720**，其中内容卡片 400×600
// （留白 左60/右60/上30/下90），顶栏 55px 属于卡片内部第一段。
// ★ 必须配 `useContentSize: true`：参考实现实测的 520×720 是**客户区**而非外框。
//   此前只写 width/height，实测得到 444×655 客户区（少 16×65），这正是
//   「上下留白不对称、卡片像被压扁」的根因（probe/overlay-zorder.cjs 与
//   probe/official-controls.cjs 双双量到）。
const PANEL_W = 520;
const PANEL_H = 720;
// T7 紧凑浮窗尺寸（参考实现有该能力；这里取卡片宽 + 顶栏，高度收到 420）
const COMPACT_W = 400;
const COMPACT_H = 420;
const SNAP_MARGIN = 8;

const STATE_FILE = path.join(app.getPath('userData'), 'companion-state.json');

// ---- 状态 ----------------------------------------------------------------
const defaultState = {
  ballMode: 'desktop',              // 'desktop'(独立窗口) | 'inline'(页内，由插件渲染)
  ballSide: 'right',                // 吸附侧
  ballY: 0.5,                       // 垂直位置比例 0..1
  pinned: true,                     // 小窗是否置顶
  panelBounds: null,                // 小窗几何
  showBall: true,
};

let state = { ...defaultState };

/** 数值兜底：状态文件被手改坏时，坏值会让 setPosition 抛 conversion failure。 */
function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = { ...defaultState, ...raw };
  } catch { /* 首次运行，用默认值 */ }
  // 逐字段校验：越界或非法即回退默认，绝不把坏值带进几何计算
  state.ballSide = state.ballSide === 'left' ? 'left' : 'right';
  state.ballY = Math.min(Math.max(num(state.ballY, 0.5), 0), 1);
  state.showBall = state.showBall !== false;
  state.pinned = state.pinned !== false;
  if (state.panelBounds && typeof state.panelBounds === 'object') {
    const b = state.panelBounds;
    state.panelBounds = {
      x: Math.round(num(b.x, 0)),
      y: Math.round(num(b.y, 0)),
      width: Math.round(num(b.width, PANEL_W)),
      height: Math.round(num(b.height, PANEL_H)),
    };
  } else {
    state.panelBounds = null;
  }
}
function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) { console.error('[companion] saveState failed:', err.message); }
}

/**
 * localStorage 注入 seed 的装载与投递（实现见 lib/ls-seed.js）。
 *
 * 数据流：
 *   宿主 leveldb ──提取器──▶ ls-seed.raw.json ──origin 映射──▶ ls-seed.json
 *     ──ipcMain 同步通道──▶ webview preload ──▶ 页面脚本运行前写入 localStorage
 *
 * ★ 为什么需要 origin 映射（本设计的关键，实测所得）：
 *   提取出来的宿主存储里，业务 key 全部挂在 **`dsh-app://app`**（238 条）——
 *   桌面壳的前端跑在自定义协议下。而 Companion 的 webview 加载的是
 *   `http://127.0.0.1:19387/`，origin 完全不同。照 origin 原样匹配必然
 *   一条都注入不进去（早期版本正是如此，preload 报 `no-bucket-for-origin`）。
 */
const lsSeedLib = require('./lib/ls-seed.js');

let lsSeed = undefined;
let lsSeedMeta = { loaded: false, reason: 'not-loaded' };

/** 提取器原始输出（未做 origin 映射）。 */
function lsSeedRawPath() {
  return path.join(app.getPath('userData'), 'ls-seed.raw.json');
}

/** 映射后的、可直接注入的 seed。 */
function lsSeedPath() {
  return path.join(app.getPath('userData'), 'ls-seed.json');
}

/**
 * 从宿主提取 → 映射到目标 origin → 写入 `ls-seed.json` → 载入内存。
 *
 * 两级回落（保证任何一环不可用时功能仍不瘫痪）：
 *   一级：现场跑提取器（数据最新）
 *   二级：用上次留下的原始文件重新映射
 * 都失败则 `loaded:false`，preload 自动跳过注入 —— **不阻断启动**。
 *
 * @param {string} targetOrigin webview 实际会有的 origin（即 DSH_ORIGIN）
 * @returns {{loaded:boolean, reason:string, source:string}}
 */
function refreshLsSeed(targetOrigin) {
  const rawPath = lsSeedRawPath();
  const outPath = lsSeedPath();

  // 一级：现场提取
  let extracted = false;
  const ex = lsSeedLib.runExtractor(rawPath, process.env.DSH_LS_EXTRACTOR);
  if (ex.ok) {
    extracted = true;
  } else if (ex.reason !== 'extractor-missing') {
    console.warn(`[companion] 提取器未成功（${ex.reason}）${ex.stderr ? '：' + ex.stderr : ''}`);
  }

  // 读原始数据（一级或二级）
  const read = lsSeedLib.readSeedFile(rawPath);
  if (!read.ok) {
    lsSeed = undefined;
    return (lsSeedMeta = { loaded: false, reason: read.reason, source: extracted ? 'extractor-only' : 'none' });
  }

  // ★ origin 映射
  const { seed, stats } = lsSeedLib.normalizeSeed(read.raw, targetOrigin);
  if (stats.error !== undefined) {
    lsSeed = undefined;
    return (lsSeedMeta = { loaded: false, reason: stats.error, source: 'map-failed' });
  }

  // 落盘映射结果供排查（体积很小，只含与当前 origin 相关的键）
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(seed, null, 2), 'utf8');
  } catch (err) {
    console.warn('[companion] 写 ls-seed.json 失败（不影响注入）:', err.message);
  }

  const entries = stats.entries;
  if (entries === 0) {
    lsSeed = undefined;
    return (lsSeedMeta = {
      loaded: false,
      reason: 'no-entries-after-map',
      source: extracted ? 'extracted' : 'existing-file',
      rawOrigins: stats.rawOrigins,
    });
  }

  lsSeed = seed;
  return (lsSeedMeta = {
    loaded: true,
    reason: 'ok',
    source: extracted ? 'extracted' : 'existing-file',
    origins: Object.keys(seed).length,
    entries,
    bytes: fs.existsSync(outPath) ? fs.statSync(outPath).size : 0,
    mergedFrom: stats.mergedFrom,
  });
}

/** webview preload 的同步取数通道（必须同步：页面脚本运行前就要有值）。 */
ipcMain.on('companion:ls-seed-sync', (event) => {
  if (lsSeed === undefined) {
    event.returnValue = { ok: false, reason: lsSeedMeta.reason };
    return;
  }
  event.returnValue = { ok: true, data: lsSeed };
});

// ---- 认证：自签 DSH 会话 cookie（零插件依赖） -----------------------------
/**
 * 为什么这样做：
 *   Companion 必须**只依赖 DSH 本体**。此前借用某个第三方生态插件的
 *   配对通道是设计缺陷 —— 没装那个插件的人就用不了。
 *
 * DSH 本体的会话认证机制（读 @deepseek-ai/dsh-client-connection 源码得出，全部公开可查）：
 *   · 签名密钥**持久化**在 Harness home 的凭据文件里
 *     （`.credentials.yaml` → `client-connection/browser-session.payload.secret`，32 字节 base64url）；
 *     `initializeSecret()` 只在缺失时生成，所以这个 secret 长期稳定。
 *   · cookie 名 = `dsh-auth-` + base64url(sha256(authority))，authority 形如 `127.0.0.1:19387`。
 *   · cookie 值 = `v1.<base64url(json)>.<base64url(hmacSha256(secret, body))>`
 *   · 载荷 = `{ version: 1, authority, issuedAt, expiresAt }`
 *
 *   ⇒ 读一次 secret 即可自签出合法的 HttpOnly 会话 cookie，无需任何令牌交换、
 *     无需插件配合、无需重启宿主。实测 `/` 与 `/api/pair/status` 均返回 200。
 *
 * 安全边界：
 *   · secret **只读不写**，绝不外传、不落日志、不进状态文件；进程内用完即留在内存。
 *   · cookie 通过 Electron 的 session.cookies.set 注入到 Companion 自己的 partition，
 *     与用户的浏览器存储互不影响。
 *   · 若读不到 secret（例如未来的 DSH 改了存储格式），返回明确原因由界面提示，
 *     不做猜测性降级。
 */
const SESSION_COOKIE_PREFIX = 'dsh-auth-';

/** base64url（无填充），与 DSH 内部 encodeBase64Url 等价。 */
function toBase64Url(buf) {
  return Buffer.from(buf).toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** 从 Harness home 的凭据文件里读出 32 字节会话签名密钥；读不到返回 undefined。 */
function readSessionSecret(targetOrigin) {
  try {
    /**
     * Harness home 的选择必须**跟着 authority 走**，不能全局用一个。
     *
     * 实测教训：cookie 名由 authority 的 sha256 决定，而签名密钥来自各自的
     * `.credentials.yaml`。E2E 里我们同时面对两个主体 ——
     *   真宿主（127.0.0.1:19387，密钥在 `~/.dsh`）
     *   隔离实例（127.0.0.1:19999，密钥在 `$DSH_HOME`）
     * 曾经用一个全局 `DSH_HOME` 覆盖，导致「用 B 的密钥签 A 的 cookie」⇒ 401。
     *
     * 现在：非默认端口的 origin 才走 `DSH_HOME`（那是隔离实例的特征），
     * 默认 origin 一律用真实 Harness home。
     */
    const origin = typeof targetOrigin === 'string' && targetOrigin !== '' ? targetOrigin : DSH_ORIGIN;
    const isDefaultTarget = origin === DSH_ORIGIN;
    const home = (!isDefaultTarget && process.env.DSH_HOME)
      ? process.env.DSH_HOME
      : path.join(os.homedir(), '.dsh');
    const yml = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
    const at = yml.indexOf('client-connection/browser-session');
    if (at < 0) return undefined;
    // 只在该记录段内匹配，避免误取别的 secret
    const seg = yml.slice(at, at + 800);
    const m = /secret:\s*([A-Za-z0-9_-]{20,})/.exec(seg);
    if (!m) return undefined;
    const raw = m[1].replaceAll('-', '+').replaceAll('_', '/');
    const secret = Buffer.from(raw, 'base64');
    return secret.length === 32 ? secret : undefined;
  } catch {
    return undefined;
  }
}

/** 用 secret 为指定 authority 签一枚会话 cookie。 */
function mintSessionCookie(secret, authority) {
  const name = SESSION_COOKIE_PREFIX
    + toBase64Url(crypto.createHash('sha256').update(authority).digest());
  const now = Date.now();
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 30 * 24 * 3600 * 1000 };
  const body = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = toBase64Url(crypto.createHmac('sha256', secret).update(body).digest());
  return { name, value: `v1.${body}.${sig}` };
}

/** authority = URL 的 host:port（DSH 用它绑定 cookie 的受众）。 */
function authorityOf(origin) {
  const u = new URL(origin);
  return u.host;
}

/**
 * 把自签 cookie 写进本进程的 session。
 * @returns 成功与否；失败时附原因，供上层回退到别的路径。
 */
async function installSelfSignedCookie(targetOrigin) {
  // 默认对主 origin 签；E2E 需要对隔离实例（不同端口 = 不同 authority）签。
  // cookie 名由 authority 的 sha256 决定，所以换 origin 必须重新签 —— 这正是
  // 「对 19387 签的 cookie 在 19999 上无效」的原因。
  const origin = typeof targetOrigin === 'string' && targetOrigin !== '' ? targetOrigin : DSH_ORIGIN;
  // 密钥必须与 origin 配套取（详见 readSessionSecret 的注释）
  const secret = readSessionSecret(origin);
  if (secret === undefined) return { ok: false, reason: 'no-secret' };
  const authority = authorityOf(origin);
  const { name, value } = mintSessionCookie(secret, authority);
  const ses = session.fromPartition(PARTITION);
  try {
    await ses.cookies.set({
      url: origin,
      name,
      value,
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    });
  } catch (err) {
    return { ok: false, reason: `set-failed: ${err.message}` };
  }

  // 校验：真的被服务端接受才算成功（不靠"我写了 cookie"自证）。
  // 必须传 origin —— 否则校验的是主 origin，会给出与本次 target 无关的假绿。
  const probe = await probeAuth(origin);
  return probe.authed ? { ok: true, authority } : { ok: false, reason: `rejected(${probe.status})@${probe.origin}` };
}

/**
 * 探测当前 session 能否访问 DSH。
 *
 * 判据：带自签 cookie 请求 `/`，200 即通过。
 * 只使用 DSH 本体路由，不依赖任何第三方插件的路径。
 *
 * ⚠️ 必须接受 targetOrigin：cookie 名由 authority 的 sha256 决定，
 * 校验「19999 的 cookie」时若仍然请求 19387，会拿 19387 的结果冒充成功
 * —— 那是**假绿**（本文件曾因此漏掉一个真实的接线错误）。
 *
 * @param {string} [targetOrigin] 缺省用 DSH_ORIGIN
 */
async function probeAuth(targetOrigin) {
  const origin = typeof targetOrigin === 'string' && targetOrigin !== '' ? targetOrigin : DSH_ORIGIN;
  const ses = session.fromPartition(PARTITION);
  try {
    const res = await ses.fetch(`${origin}/`, { redirect: 'manual' });
    return { authed: res.status === 200, status: res.status, origin };
  } catch (err) {
    return { authed: false, status: 0, error: err.message };
  }
}

/** 读回 partition 里的 dsh-auth cookie，作为"凭据确实在"的独立证据。 */
async function hasAuthCookie() {
  try {
    const ses = session.fromPartition(PARTITION);
    const list = await ses.cookies.get({});
    return list.some((c) => c.name.startsWith(SESSION_COOKIE_PREFIX));
  } catch { return false; }
}

// ---- 图标 -----------------------------------------------------------------
// 全部由 renderer/whale.svg（DeepSeek 官方矢量，取自 DSH 内置 dsh-web-frontend）
// 经 sharp 烘成 PNG，见 assets/。**不使用 Electron 默认图标**。
const ICON = {
  app: path.join(__dirname, 'assets', 'app-icon.png'),       // 256，透明底
  tray: path.join(__dirname, 'assets', 'whale-32.png'),       // 托盘
  ball: path.join(__dirname, 'renderer', 'whale.svg'),
};

/** 给窗口挂图标：Windows 下没有它，任务栏/Alt-Tab 会退回 Electron 默认图标。 */
function applyIcon(win) {
  try {
    if (fs.existsSync(ICON.app)) win.setIcon(ICON.app);
  } catch (err) {
    console.error('[companion] setIcon failed:', err.message);
  }
}

// ---- 窗口：悬浮球 --------------------------------------------------------
let ballWin = null;
let panelWin = null;
let dragging = false;

function ballPosition() {
  const display = screen.getPrimaryDisplay();
  // 同样必须取整：DPI 缩放非整数时 workArea 可能带小数
  const wa = {
    x: Math.round(display.workArea.x),
    y: Math.round(display.workArea.y),
    w: Math.round(display.workArea.width),
    h: Math.round(display.workArea.height),
  };
  const x = state.ballSide === 'left' ? wa.x + SNAP_MARGIN : wa.x + wa.w - BALL_SIZE - SNAP_MARGIN;
  const y = Math.round(wa.y + state.ballY * (wa.h - BALL_SIZE));
  return { x: Math.round(x), y };
}

function createBall() {
  if (ballWin && !ballWin.isDestroyed()) return ballWin;
  const pos = ballPosition();
  ballWin = new BrowserWindow({
    width: BALL_SIZE,
    height: BALL_SIZE,
    x: pos.x,
    y: pos.y,
    frame: false,
    // 透明底是"不要一块黑胶布"的前提；配合 html/body 的 background:transparent
    transparent: true,
    backgroundColor: '#00000000',
    roundedCorners: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,          // 点球不抢焦点（对齐参考实现悬浮球行为）
    show: false,
    title: 'DeepSeek',
    icon: fs.existsSync(ICON.app) ? ICON.app : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,   // 悬浮球要一直可见，不能被后台节流停掉渲染
    },
  });
  ballWin.loadFile(path.join(__dirname, 'renderer', 'ball.html'));
  applyIcon(ballWin);
  ballWin.once('ready-to-show', () => {
    if (state.showBall) ballWin.showInactive();   // showInactive：不抢焦点
  });
  ballWin.setAlwaysOnTop(true, 'screen-saver');
  ballWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  ballWin.on('closed', () => { ballWin = null; });
  return ballWin;
}

/** 松手后吸附到最近的左右边缘。 */
function snapBall() {
  if (!ballWin || ballWin.isDestroyed()) return;
  // 注意：Electron 的 setPosition/setBounds 只接受整数。
  // getDisplayMatching 的 workArea 在缩放非整数（如 125%/150% DPI）时会给出小数，
  // 直接传下去会抛 "Error processing argument at index 1, conversion failure from ..."。
  // 因此所有几何值都必须显式取整。
  const [rawX, rawY] = ballWin.getPosition();
  const x0 = Math.round(rawX);
  const y0 = Math.round(rawY);

  const display = screen.getDisplayMatching({ x: x0, y: y0, width: BALL_SIZE, height: BALL_SIZE });
  const wa = {
    x: Math.round(display.workArea.x),
    y: Math.round(display.workArea.y),
    w: Math.round(display.workArea.width),
    h: Math.round(display.workArea.height),
  };

  const centerX = x0 + BALL_SIZE / 2;
  state.ballSide = centerX < wa.x + wa.w / 2 ? 'left' : 'right';

  const span = Math.max(1, wa.h - BALL_SIZE);
  const clampedY = Math.min(Math.max(y0, wa.y), wa.y + wa.h - BALL_SIZE);
  state.ballY = (clampedY - wa.y) / span;

  const targetX = state.ballSide === 'left'
    ? wa.x + SNAP_MARGIN
    : wa.x + wa.w - BALL_SIZE - SNAP_MARGIN;

  ballWin.setPosition(Math.round(targetX), Math.round(clampedY));
  saveState();
}

// ---- 窗口：小窗 ----------------------------------------------------------
/**
 * 默认位置：**光标所在那台显示器**的右下角。
 *
 * 为什么不是 `getPrimaryDisplay()`（原先的写法，是真缺陷）：
 *   多显示器时用户在小屏上点小窗，窗口会跑到主屏去 —— 与直觉相反。
 * 为什么取整：Electron 几何 API 只接受整数；`workArea` 在非整数 DPI
 *   （125%/150%）下会给小数，直接传会抛 conversion failure（实测踩过）。
 */
function panelPosition() {
  let display;
  try {
    display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  } catch {
    display = screen.getPrimaryDisplay();
  }
  const wa = {
    x: Math.round(display.workArea.x),
    y: Math.round(display.workArea.y),
    w: Math.round(display.workArea.width),
    h: Math.round(display.workArea.height),
  };
  return {
    x: wa.x + wa.w - PANEL_W - 24,
    y: wa.y + wa.h - PANEL_H - 24,
  };
}

/**
 * 把「上次存的几何」修正到**当前仍然可见**的位置。
 *
 * 这是批次 5 负路径「拔显示器后回到主屏可见区」的落点。
 * 不做这一步的话：重启后窗口按绝对坐标落在已不存在的显示器上 ⇒
 * **窗口可见但用户找不到**（任务栏有、屏幕上没有），是最难自查的一类故障。
 *
 * 判据：窗口矩形与**任一**显示器工作区的交集面积 ≥ 阈值（默认要求整窗至少
 * 露出 40% 且标题栏所在的上边缘在可见区内）。
 *
 * @param {{x:number,y:number,width:number,height:number}|null} b 上次存的几何
 * @returns {{x:number,y:number,width:number,height:number}} 保证可见的几何
 */
function ensureVisibleBounds(b) {
  const W = Math.round(num(b?.width, PANEL_W));
  const H = Math.round(num(b?.height, PANEL_H));
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) {
    const p = panelPosition();
    return { x: p.x, y: p.y, width: W, height: H };
  }
  const x = Math.round(b.x);
  const y = Math.round(b.y);

  let displays;
  try {
    displays = screen.getAllDisplays();
  } catch {
    return { x, y, width: W, height: H };
  }

  // 对每台显示器算「窗口落在它工作区内的面积」，取最大者
  let best = { area: 0, wa: null };
  for (const d of displays) {
    const wa = {
      x: Math.round(d.workArea.x), y: Math.round(d.workArea.y),
      w: Math.round(d.workArea.width), h: Math.round(d.workArea.height),
    };
    const ix = Math.max(0, Math.min(x + W, wa.x + wa.w) - Math.max(x, wa.x));
    const iy = Math.max(0, Math.min(y + H, wa.y + wa.h) - Math.max(y, wa.y));
    const area = ix * iy;
    if (area > best.area) best = { area, wa };
  }

  const visibleRatio = W * H > 0 ? best.area / (W * H) : 0;
  if (best.wa !== null && visibleRatio >= 0.4) {
    // 仍然可见（露出 ≥40%）⇒ 保留原位置，但把尺寸钳进该屏，避免超出工作区
    const wa = best.wa;
    return {
      x: Math.min(Math.max(x, wa.x), Math.max(wa.x, wa.x + wa.w - W)),
      y: Math.min(Math.max(y, wa.y), Math.max(wa.y, wa.y + wa.h - H)),
      width: Math.min(W, wa.w),
      height: Math.min(H, wa.h),
    };
  }

  // 不可见（曾被拔掉的显示器 / 拓扑变化）⇒ 回到光标所在屏的默认位
  console.warn(
    `[companion] 上次的小窗位置 (${x},${y}) 已不可见（可见比例 ${(visibleRatio * 100).toFixed(0)}%），`
    + '已回到当前显示器的工作区',
  );
  const p = panelPosition();
  return { x: p.x, y: p.y, width: W, height: H };
}

function createPanel() {
  if (panelWin && !panelWin.isDestroyed()) { panelWin.show(); panelWin.focus(); return panelWin; }
  // ★ 必须过 ensureVisibleBounds：直接把存下来的绝对坐标交给 BrowserWindow，
  //   在显示器拓扑变化后会得到一个「存在但看不见」的窗口。
  const b = ensureVisibleBounds(state.panelBounds);
  panelWin = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: b.x, y: b.y,
    // ★ 客户区尺寸语义：参考实现实测 520×720 是**客户区**（不含窗口边框/阴影）。
    //   不加这一条，同一组数值实测只得到 444×655 客户区，卡片会被压扁、留白不对称。
    useContentSize: true,
    minWidth: 320,
    minHeight: 400,
    // ★★ 2026-10-11 用户裁定「铺满整个窗格」⇒ 窗口改回**不透明**。
    //
    // ## 为什么这一改能一次性删掉一整条机制链
    //
    // 之前的透明方案（`transparent:true`）是为了复刻参考实现「400×600 卡片浮在
    // 520×720 透明窗口里」的外观。但它带来三个在 Windows 上无法绕开的后果：
    //
    //   ① **透明无边框窗口不能用系统边框缩放**（Electron 已知限制）
    //      ⇒ 必须自绘 8 个 `.rz` 缩放把手 + 自绘拖动；
    //   ② 透明区**仍然吃鼠标点击**（`transparent` 只影响绘制、不影响命中测试）
    //      ⇒ 必须再造一套 `setIgnoreMouseEvents` 穿透 + 位置判定；
    //   ③ ①② 两套几何必须**严格一致**，否则点击落空/"粘手"
    //      ⇒ 用户实测连续报了三条缺陷，全是这一条派生出来的。
    //
    // 铺满之后：窗口 = 卡片，没有透明留白 ⇒ 上面 ①②③ **整条不存在**。
    // 系统直接提供可拖的标题栏、可拉的边框、以及投影。
    //
    // 代价（须知晓）：不再是"浮在透明窗口里的卡片"那种参考实现外观；
    //                窗口是一个不透明矩形，四角由系统圆角控制。
    frame: false,                  // 仍自绘顶栏（参考实现式 T1–T9），但窗口**不透明**
    transparent: false,
    roundedCorners: true,          // 系统圆角（不透明窗口下有效）
    resizable: true,               // 系统边框缩放（不透明窗口下可用）
    alwaysOnTop: state.pinned,
    skipTaskbar: false,
    hasShadow: true,               // 系统投影（替代批次12 自绘的 #stage::after 阴影）
    show: false,
    title: 'DeepSeek 小窗',
    icon: fs.existsSync(ICON.app) ? ICON.app : undefined,
    backgroundColor: '#1A1A1A',    // ★ 与卡片同色，避免任何闪烁的白/黑底
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      partition: PARTITION,
    },
  });
  panelWin.loadFile(path.join(__dirname, 'renderer', 'panel.html'), {
    query: {
      origin: DSH_ORIGIN,
      // webview 的 preload 必须是 file:// 绝对 URL；由渲染进程在首次导航前挂上。
      // 用 pathToFileURL 生成，避免手工拼 'file:///' 在盘符/空格上出错。
      preload: pathToFileURL(path.join(__dirname, 'lib', 'webview-ls-seed.js')).href,
    },
  });
  applyIcon(panelWin);
  panelWin.once('ready-to-show', () => panelWin.show());
  if (state.pinned) panelWin.setAlwaysOnTop(true, 'floating');
  panelWin.on('moved', persistPanelBounds);
  panelWin.on('resized', persistPanelBounds);
  panelWin.on('closed', () => { panelWin = null; });
  return panelWin;
}

function persistPanelBounds() {
  if (!panelWin || panelWin.isDestroyed()) return;
  // ★★ 2026-10-11 真缺陷修正：**紧凑模式下不得覆盖常规几何**。
  //
  // 旧行为：`panelWin.on('resized', persistPanelBounds)` 无条件把当前尺寸存为常规几何
  // ⇒ 一旦进入紧凑浮窗（400×420），**那个小尺寸就被当成"常规大小"持久化**，
  //   此后每次打开小窗都是很小的 —— 这正是用户反馈
  //   「目前默认的情况是很小的」的根因（叠加"双击顶栏切紧凑"的误触后更明显）。
  //
  // 修法：紧凑期间收到的 moved/resized 一律**丢弃**，
  //       常规几何只在非紧凑态更新（紧凑前的几何已由 panelBoundsBeforeCompact 保管）。
  if (compactMode) return;
  const b = panelWin.getBounds();
  state.panelBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
  saveState();
}

// ---- IPC -----------------------------------------------------------------
ipcMain.handle('companion:state', () => ({ ...state }));

ipcMain.handle('companion:set', (_e, patch) => {
  Object.assign(state, patch || {});
  if (typeof state.pinned === 'boolean' && panelWin && !panelWin.isDestroyed()) {
    panelWin.setAlwaysOnTop(state.pinned, 'floating');
  }
  if (ballWin && !ballWin.isDestroyed()) {
    if (state.showBall) ballWin.showInactive(); else ballWin.hide();
    const pos = ballPosition();
    ballWin.setPosition(pos.x, pos.y);
  }
  saveState();
  return { ...state };
});

/**
 * 握手：只有一条路径 —— 自签 DSH 本体会话 cookie。
 * 幂等：已经有可用 cookie 就直接返回，不重复签。
 * 失败时把确切原因带回去（不吞错），界面据此提示。
 */
ipcMain.handle('companion:probe', async () => {
  if (await hasAuthCookie()) {
    const p = await probeAuth();
    if (p.authed) return { ...p, method: 'existing' };
  }
  const installed = await installSelfSignedCookie();
  if (installed.ok) {
    const p = await probeAuth();
    return { ...p, method: 'self-signed', authority: installed.authority };
  }
  const p = await probeAuth();
  return { ...p, method: 'none', reason: installed.reason };
});

ipcMain.handle('companion:openPanel', () => { createPanel(); return true; });
ipcMain.handle('companion:closePanel', () => { if (panelWin && !panelWin.isDestroyed()) panelWin.close(); return true; });
ipcMain.handle('companion:togglePin', () => {
  state.pinned = !state.pinned;
  if (panelWin && !panelWin.isDestroyed()) panelWin.setAlwaysOnTop(state.pinned, 'floating');
  saveState();
  return state.pinned;
});
ipcMain.handle('companion:showMain', async () => {
  // 小窗里的"回到主界面"：直接在浏览器打开 DSH（web 版与桌面版都适用）
  try { await shell.openExternal(DSH_ORIGIN); } catch { /* 忽略 */ }
  return true;
});

// 拖动：用光标真实坐标，避免 renderer 坐标系误差
ipcMain.on('ball:drag-start', () => { dragging = true; });
ipcMain.on('ball:drag-move', () => {
  if (!dragging || !ballWin || ballWin.isDestroyed()) return;
  const pt = screen.getCursorScreenPoint();
  ballWin.setPosition(
    Math.round(pt.x - BALL_SIZE / 2),
    Math.round(pt.y - BALL_SIZE / 2),
  );
});
ipcMain.on('ball:drag-end', () => { dragging = false; snapBall(); });
ipcMain.on('ball:click', () => {
  if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) {
    panelWin.hide();
  } else {
    createPanel();
  }
});

// （原「小窗自绘标题栏拖动」已移除）
// 2026-10-11 用户裁定铺满整窗后，窗口不透明 ⇒ 顶栏由 `-webkit-app-region: drag`
// 交给系统拖动，主进程不需要再自己 setPosition。
ipcMain.on('panel:minimize', () => { if (panelWin && !panelWin.isDestroyed()) panelWin.minimize(); });
ipcMain.on('panel:close', () => { if (panelWin && !panelWin.isDestroyed()) panelWin.close(); });

// （原「8 向真原生缩放 panel:resize-*」已整块移除）
// 那是为**透明无边框窗口**打的补丁：Electron 在 Windows 上，透明窗无法用系统边框缩放。
// 铺满后窗口不透明 ⇒ 系统自带边框缩放（`resizable: true`），自绘热区不再需要。

// （原「透明区鼠标穿透 panel:setIgnoreMouseEvents」已整块移除）
// 铺满后没有透明圈 ⇒ 不存在"点击被透明区吃掉"的问题，穿透机制连同它的
// 位置判定、与热区几何对齐的约束一起删除 —— 那正是用户报的三条缺陷的共同来源。

/**
 * T7 紧凑浮窗：真原生窗口尺寸切换（不是 CSS 缩放）。
 *
 * 参考实现该按钮是「画中画/浮窗」（docs/06 §2.1 T7，判定为**推断·中**：
 * pak 内「画中画」零命中，按图标外形判读）。DSH 侧无 PiP 服务，
 * 因此落成「缩小窗口」这一**同类可见行为**，而不是开第二个窗口。
 *
 * 恢复时用存下来的常规几何，而不是硬编码 PANEL_W/H —— 用户可能拖过大小。
 */
let panelBoundsBeforeCompact = null;
/** 是否处于紧凑浮窗（紧凑期间禁止把尺寸持久化成常规几何，见 persistPanelBounds）。 */
let compactMode = false;
ipcMain.handle('panel:setCompact', (_e, on) => {
  if (!panelWin || panelWin.isDestroyed()) return { ok: false, reason: 'no-panel' };
  if (on) {
    // ★ 存 **contentBounds**：恢复时必须走同一语义（见 resize-move 的留痕）
    try { panelBoundsBeforeCompact = panelWin.getContentBounds(); }
    catch { panelBoundsBeforeCompact = panelWin.getBounds(); }
    compactMode = true;
    panelWin.setContentSize(COMPACT_W, COMPACT_H);
    return { ok: true, size: panelWin.getContentSize() };
  }
  const b = panelBoundsBeforeCompact;
  compactMode = false;
  if (b) {
    // ⚠️ 同理：必须 `setContentBounds`，用 `setBounds` 会把客户区越缩越小
    try { panelWin.setContentBounds(b); }
    catch { panelWin.setContentSize(b.width, b.height); panelWin.setPosition(b.x, b.y); }
    panelBoundsBeforeCompact = null;
    return { ok: true, size: panelWin.getContentSize() };
  }
  panelWin.setContentSize(PANEL_W, PANEL_H);
  return { ok: true, size: panelWin.getContentSize() };
});

// （原 `panelDragging` / `panelDragOffset` 两个状态变量已删除：
//   它们只服务于已移除的自绘拖动。铺满方案下系统负责拖动，不再需要跟踪。）

// ---- 生命周期 ------------------------------------------------------------
/**
 * 自检模式（`DSH_COMPANION_SELFTEST=1`）：
 * 不开窗口，只在 Electron 自己的 session/cookie jar 里跑一次握手，
 * 打印每步真实状态后退出。用于「Node 里通 ≠ Electron 里通」的验证。
 */
/**
 * 批次 5 自检：窗口行为（位置持久化 / 置顶可配 / 多显示器可见性兜底）。
 *
 * ## 为什么这些必须真跑
 *
 * 「位置持久化」「拔显示器后回到可见区」都是**几何行为**，
 * 只能真建窗口、真读回 bounds 才算验过。静态看代码分不清
 * `x` 传了没传、坐标是否被显示器拓扑吞掉。
 *
 * ## 四条判据（各带负路径）
 *
 *   1. 建窗后 bounds 与请求一致（含取整）
 *   2. `ensureVisibleBounds` 对**离屏坐标**必须修正到可见区（负路径核心）
 *   3. `ensureVisibleBounds` 对**正常坐标**必须原样保留（不得乱动）
 *   4. 置顶开关即时生效（`setAlwaysOnTop` 后 `isAlwaysOnTop()` 为真，关掉为假）
 *
 * ⚠️ 不碰用户可见桌面：窗口一律 `show:false`，并在结束时销毁。
 */
async function runWindowSelfTest(log) {
  let pass = 0;
  let fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; log(`  PASS ${name}`, extra === undefined ? '' : extra); }
    else { fail++; log(`  FAIL ${name}`, extra === undefined ? '' : extra); }
  };

  let displays = [];
  try { displays = screen.getAllDisplays(); } catch { /* noop */ }
  log('显示器数', displays.length);
  for (const d of displays) {
    log('  显示器', JSON.stringify({
      id: d.id, bounds: d.bounds, workArea: d.workArea, scale: d.scaleFactor,
      primary: d.id === screen.getPrimaryDisplay().id,
    }));
  }

  // ---- 1) 建窗、量回 bounds ----
  // ★ 用 PANEL_W/PANEL_H 而不是写死数值：判据必须跟着产品常量走。
  //   过期判据留痕（2026-10-11）：此处曾写死 460×720，产品常量升到 520×720 后
  //   它仍在测旧尺寸，属于「判据过期」而非真缺陷 ⇒ 按用户裁定改判据、不回滚代码。
  //   同批修正第 863/871 行。
  const want = ensureVisibleBounds({ x: 120, y: 90, width: PANEL_W, height: PANEL_H });
  log('请求几何', JSON.stringify(want));
  const w = new BrowserWindow({
    width: want.width, height: want.height, x: want.x, y: want.y,
    show: false, frame: true, resizable: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await new Promise((r) => setTimeout(r, 300));
  const got = w.getBounds();
  log('实际几何', JSON.stringify(got));
  check('窗口尺寸与请求一致', got.width === want.width && got.height === want.height,
    `${got.width}×${got.height} vs ${want.width}×${want.height}`);
  // 位置可能有窗口装饰/最小尺寸微调，允许 ±8px
  check('窗口位置与请求一致（容差 8px）',
    Math.abs(got.x - want.x) <= 8 && Math.abs(got.y - want.y) <= 8,
    `(${got.x},${got.y}) vs (${want.x},${want.y})`);

  // ---- 4) 置顶开关即时生效 ----
  w.setAlwaysOnTop(false);
  await new Promise((r) => setTimeout(r, 120));
  const off1 = w.isAlwaysOnTop();
  w.setAlwaysOnTop(true, 'floating');
  await new Promise((r) => setTimeout(r, 120));
  const on1 = w.isAlwaysOnTop();
  log('置顶开关', `false→${off1}  true→${on1}`);
  check('置顶可关（置 false 后不为真）', off1 === false);
  check('置顶可开（置 true 后为真）', on1 === true);

  w.destroy();
  await new Promise((r) => setTimeout(r, 200));

  // ---- 2) 负路径：离屏坐标必须被修正 ----
  const primary = screen.getPrimaryDisplay();
  const pwa = primary.workArea;
  // 造一个「远在屏幕外」的坐标（模拟拔掉的显示器：负方向 + 大正方向各一）
  const offscreenCases = [
    { label: '远左（模拟左侧显示器被拔）', b: { x: -20000, y: 100, width: 460, height: 720 } },
    { label: '远右（模拟右侧显示器被拔）', b: { x: 60000, y: 100, width: 460, height: 720 } },
    { label: '远下（模拟下方显示器被拔）', b: { x: 100, y: 60000, width: 460, height: 720 } },
  ];
  for (const c of offscreenCases) {
    const fixed = ensureVisibleBounds(c.b);
    // 修正后的矩形必须与某台显示器工作区有 ≥40% 交集
    let bestArea = 0;
    for (const d of displays) {
      const wa = d.workArea;
      const ix = Math.max(0, Math.min(fixed.x + fixed.width, wa.x + wa.width) - Math.max(fixed.x, wa.x));
      const iy = Math.max(0, Math.min(fixed.y + fixed.height, wa.y + wa.height) - Math.max(fixed.y, wa.y));
      bestArea = Math.max(bestArea, ix * iy);
    }
    const ratio = bestArea / (fixed.width * fixed.height);
    check(`负路径：${c.label} → 修正到可见区`, ratio >= 0.4,
      `${JSON.stringify(c.b)} → ${JSON.stringify(fixed)}（可见 ${(ratio * 100).toFixed(0)}%）`);
  }

  // ---- 3) 正路径：屏内坐标不得被乱动 ----
  const inside = { x: Math.round(pwa.x + 40), y: Math.round(pwa.y + 40), width: PANEL_W, height: PANEL_H };
  const kept = ensureVisibleBounds(inside);
  check('正路径：屏内坐标原样保留（不得乱动）',
    kept.x === inside.x && kept.y === inside.y && kept.width === inside.width && kept.height === inside.height,
    `${JSON.stringify(inside)} → ${JSON.stringify(kept)}`);

  // ---- 5) 位置持久化：走真实的 saveState/loadState ----
  const saved = { ...state };
  state.panelBounds = { x: inside.x, y: inside.y, width: PANEL_W, height: PANEL_H };
  saveState();
  state.panelBounds = null;          // 抹掉内存值，强制从磁盘读
  loadState();
  const reloaded = state.panelBounds;
  log('持久化读回', JSON.stringify(reloaded));
  check('位置持久化：写盘后能读回同一几何',
    reloaded !== null && reloaded.x === inside.x && reloaded.y === inside.y
      && reloaded.width === PANEL_W && reloaded.height === PANEL_H,
    JSON.stringify(reloaded));
  // 还原，避免污染用户真实状态文件
  state.panelBounds = saved.panelBounds;
  state.ballMode = saved.ballMode;
  state.ballSide = saved.ballSide;
  state.ballY = saved.ballY;
  state.pinned = saved.pinned;
  state.showBall = saved.showBall;
  saveState();

  log('窗口自检结果', `${pass} PASS / ${fail} FAIL`);
  return { pass, fail };
}

async function runSelfTest() {
  const log = (k, v) => process.stdout.write(`[selftest] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
  try {
    log('origin', DSH_ORIGIN);
    // 注：这里不传 targetOrigin —— 走默认分支（真实 ~/.dsh 的密钥）
    const secretOk = readSessionSecret() !== undefined;
    log('读得到 secret', secretOk);
    if (!secretOk) { log('RESULT', 'FAIL(no-secret)'); app.exit(1); return; }

    const installed = await installSelfSignedCookie();
    log('自签 cookie', installed);
    const probe = await probeAuth();
    log('探测 /', probe);
    const hasCookie = await hasAuthCookie();
    log('cookie 在 jar 里', hasCookie);

    // ---- 注入端到端（真开 webview，读回它自己的 localStorage）----
    // 这是批次 1 的决定性证据：不是「文件写对了」，而是**webview 页面真的读到了**。
    //
    // `DSH_COMPANION_E2E_ONLY=session` 时**只跑会话切换那一项**：
    // 该项要验的是「有会话的环境下能否切会话」，而隔离实例是全新 home（无会话），
    // 指向它只会测到空环境（实测 toggle/sidebar 都是 null）。只有真宿主有会话列表。
    // 此时注入/mini 两项必然不适用（真宿主没装本插件），硬跑只会产生无意义的 FAIL。
    const onlySession = process.env.DSH_COMPANION_E2E_ONLY === 'session';

    // ---- 批次 5：窗口行为（真建窗、真读回 bounds）----
    let win5 = { skipped: 'DSH_COMPANION_WINTEST!=1' };
    if (process.env.DSH_COMPANION_WINTEST === '1') {
      win5 = await runWindowSelfTest(log);
    } else {
      log('窗口自检', '跳过（设 DSH_COMPANION_WINTEST=1 开启）');
    }

    let inject = { skipped: 'only=session' };
    let miniE2E = { skipped: 'only=session' };
    let offline = { skipped: 'only=session' };
    let sessionSwitch = { skipped: 'not-run' };

    if (onlySession) {
      // 只跑会话切换（目标由 DSH_MINI_E2E_ORIGIN 指定，通常是真宿主）
      sessionSwitch = await runSessionSwitchE2E(log);
      const okS = installed.ok && probe.authed && (sessionSwitch.ok !== false);
      log('RESULT(only=session)', okS ? 'PASS' : 'FAIL');
      app.exit(okS ? 0 : 1);
      return;
    }

    if (process.env.DSH_COMPANION_E2E === '1') {
      inject = await runInjectE2E(log);
      miniE2E = await runMiniE2E(log);
      offline = await runOfflineE2E(log);
      sessionSwitch = await runSessionSwitchE2E(log);
    } else {
      log('注入 E2E', '跳过（设 DSH_COMPANION_E2E=1 开启）');
    }

    const ok = installed.ok && probe.authed
      && (inject.ok !== false) && (miniE2E.ok !== false)
      && (offline.ok !== false) && (sessionSwitch.ok !== false);
    log('RESULT', ok ? 'PASS' : 'FAIL');
    app.exit(ok ? 0 : 1);
  } catch (err) {
    log('ERROR', err.message);
    app.exit(2);
  }
}

/**
 * 批次 2 的端到端：mini 模式是否**真的在活页面上生效**，且**不带参数时不误伤**。
 *
 * 两步，各开一个 webview：
 *   正路径 `?dsh-mini=1` → 断言 html 上有 `data-dsh-mini="1"`、有角标、CSS 变量已注入
 *   负路径 无参数        → 断言 html 上**没有** mini 标记、没有角标，
 *                          且官方三栏布局仍在（sidebar/conversation/details 三个 surface 都在）
 *
 * 为什么必须在**活页面**上验：`isMiniMode()` 读的是 `location.search`，而插件是在
 * 真实 URL 下被加载的。单元沙箱只能证明函数逻辑对，证明不了「URL 带参数时插件真的跑了」。
 */
async function runMiniE2E(log) {
  const PART = PARTITION;
  /**
   * 探测目标的可配置性很关键：
   * 本插件的 mini 效果只在**装了本插件的 DSH 实例**上才看得到。
   * 用户正在跑的主机（19387）里没装本插件（那是用户自己的环境，我们不改），
   * 所以验证时必须指向隔离实例（如 :19999，profile=miniwin 装了本插件）。
   * 首跑没意识到这点，对着 19387 验，拿到 miniAttr=null 的假失败。
   */
  const MINI_ORIGIN = process.env.DSH_MINI_E2E_ORIGIN || DSH_ORIGIN;
  log('E2E 探测目标', MINI_ORIGIN);

  // ★ 关键：cookie 名由 authority 的 sha256 决定 ⇒ 换端口必须**重新签**。
  // 首跑对 19999 拿到空页面（pluginLoaded:false、surfaces:[]）就是漏了这一步：
  // 手上只有对 19387 签的 cookie，19999 上等于未认证。
  if (MINI_ORIGIN !== DSH_ORIGIN) {
    const r = await installSelfSignedCookie(MINI_ORIGIN);
    log('E2E 为目标 origin 重签 cookie', JSON.stringify(r));
  }

  const probeScript = `(function(){
    var html = document.documentElement;
    function box(el){ if(!el) return null; var r=el.getBoundingClientRect();
      return { x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height) }; }
    function one(sel){ return box(document.querySelector(sel)); }
    function cnt(sel){ return document.querySelectorAll(sel).length; }

    // 横向溢出：窄窗最常见的破版。0 = 不破版。
    var docOverflow = html.scrollWidth - html.clientWidth;
    var wider = [];
    Array.prototype.forEach.call(document.querySelectorAll('*'), function(el){
      var r = el.getBoundingClientRect();
      if (r.width > window.innerWidth + 1 && r.height > 4) {
        wider.push({ tag: el.tagName.toLowerCase(), surface: el.getAttribute('data-dsh-surface'),
                     slot: el.getAttribute('data-slot'), w: Math.round(r.width) });
      }
    });

    var out = {
      url: location.href,
      search: location.search,
      vw: window.innerWidth, vh: window.innerHeight,
      miniAttr: html.getAttribute('data-dsh-mini'),
      topbarVar: getComputedStyle(html).getPropertyValue('--dsh-mini-topbar').trim(),
      badge: !!document.querySelector('[data-dsh-mini-badge]'),
      surfaces: Array.prototype.map.call(
        document.querySelectorAll('[data-dsh-surface]'),
        function(e){ return e.getAttribute('data-dsh-surface'); }
      ),
      planes: Array.prototype.map.call(
        document.querySelectorAll('[data-pane]'),
        function(e){ return e.getAttribute('data-pane'); }
      ),
      // ---- 批次 3：对话区实测 ----
      conversation: one('[data-dsh-surface="conversation"]'),
      composer: one('[data-dsh-surface="composer"]'),
      counts: {
        composerCard: cnt('[data-composer-card]'),
        composerInput: cnt('[data-composer-input]'),
        conversationContent: cnt('[data-conversation-content]'),
        conversationHeaderLeading: cnt('[data-conversation-header-leading]'),
        conversationScroll: cnt('[data-conversation-scroll]'),
        conversationRegionChat: cnt('[data-conversation-region="chat"]'),
        conversationRegionComposer: cnt('[data-conversation-region="composer"]')
      },
      editable: Array.prototype.map.call(
        document.querySelectorAll('[contenteditable="true"], textarea, input[type="text"]'),
        function(e){ var r=e.getBoundingClientRect();
          return { tag:e.tagName.toLowerCase(), w:Math.round(r.width), h:Math.round(r.height) }; }
      ).slice(0,4),
      docOverflow: docOverflow,
      widerCount: wider.length,
      widerSample: wider.slice(0,5),
      bodyTextHead: document.body ? document.body.innerText.slice(0,120).replace(/\\n/g,' | ') : ''
    };
    try { out.pluginLoaded = !!window.__ModuleLoader__; } catch(e){}
    return JSON.stringify(out);
  })()`;

  async function openAndProbe(url, tag) {
    const win = new BrowserWindow({
      width: 460, height: 720, show: false,
      webPreferences: { partition: PART, webviewTag: true, contextIsolation: true, sandbox: false },
    });
    try {
      await win.loadFile(path.join(__dirname, 'renderer', 'panel.html'), {
        query: {
          origin: MINI_ORIGIN,
          preload: pathToFileURL(path.join(__dirname, 'lib', 'webview-ls-seed.js')).href,
        },
      });
      const guest = await new Promise((resolve) => {
        const to = setTimeout(() => resolve(undefined), 20000);
        win.webContents.once('did-attach-webview', (_e, g) => { clearTimeout(to); resolve(g); });
        win.webContents.executeJavaScript(
          `document.getElementById('view').src = ${JSON.stringify(url)}; true`,
        ).catch(() => {});
      });
      if (guest === undefined) return { error: 'no-guest' };
      await new Promise((resolve) => {
        const to = setTimeout(resolve, 30000);
        if (guest.isLoading && guest.isLoading()) guest.once('did-finish-load', () => { clearTimeout(to); resolve(); });
        else { clearTimeout(to); resolve(); }
      });

      // 等**条件满足**而不是固定 sleep：首跑固定 3 秒时 surfaces 为空
      // （前端还没把 AppFrame 渲染出来），导致把「还没画完」误判成「布局没了」。
      // 这里轮询到出现 data-dsh-surface 或超时为止，最多 20 秒。
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        try {
          const n = await guest.executeJavaScript(
            `document.querySelectorAll('[data-dsh-surface]').length`,
          );
          if (n > 0) break;
        } catch { /* 页面还在导航，继续等 */ }
        await new Promise((r) => setTimeout(r, 500));
      }

      const raw = await guest.executeJavaScript(probeScript);
      const data = JSON.parse(raw);
      log(`[${tag}] url`, data.url);
      log(`[${tag}] data-dsh-mini`, data.miniAttr);
      log(`[${tag}] --dsh-mini-topbar`, data.topbarVar || '(空)');
      log(`[${tag}] 角标存在`, data.badge);
      log(`[${tag}] surfaces`, data.surfaces.join(','));
      log(`[${tag}] panes`, data.planes.join(','));
      // 批次 3：对话区实测
      log(`[${tag}] conversation`, data.conversation ? `${data.conversation.w}×${data.conversation.h}@(${data.conversation.x},${data.conversation.y})` : '(未渲染)');
      log(`[${tag}] composer`, data.composer ? `${data.composer.w}×${data.composer.h}@(${data.composer.x},${data.composer.y})` : '(未渲染)');
      log(`[${tag}] 区域计数`, JSON.stringify(data.counts));
      log(`[${tag}] 可编辑元素`, JSON.stringify(data.editable));
      log(`[${tag}] 横向溢出`, `${data.docOverflow}px（超宽元素 ${data.widerCount} 个）`);
      if (data.widerCount > 0) log(`[${tag}] 超宽样本`, JSON.stringify(data.widerSample));
      log(`[${tag}] 页面文本头`, data.bodyTextHead);
      return data;
    } catch (err) {
      return { error: err.message };
    } finally {
      try { win.destroy(); } catch { /* noop */ }
    }
  }

  // 正路径
  const pos = await openAndProbe(`${MINI_ORIGIN}/?dsh-mini=1`, 'mini');
  const posOk = pos.error === undefined
    && pos.miniAttr === '1'
    && pos.topbarVar === '55px'
    && pos.badge === true;
  log('E2E mini 正路径', posOk ? 'PASS' : `FAIL（${JSON.stringify(pos).slice(0, 260)}）`);

  // 负路径：不带参数
  const neg = await openAndProbe(`${MINI_ORIGIN}/`, 'noparam');

  // 判定分两层，避免把「首屏是引导页」误判成「布局坏了」：
  //   硬断言（必须成立）：不带参数 ⇒ **没有** mini 标记、**没有**角标
  //   条件断言（若 AppFrame 已渲染）：官方 pane 必须仍在 —— 这才是「不误伤主界面」
  const negHardOk = neg.error === undefined
    && neg.miniAttr === null
    && neg.badge === false;
  const paneRendered = Array.isArray(neg.planes) && neg.planes.length > 0;
  const paneOk = !paneRendered || (neg.planes.includes('sidebar') && neg.planes.includes('conversation'));
  const negOk = negHardOk && paneOk;

  log('E2E mini 负路径（不带参数）', negHardOk
    ? `PASS（无 mini 标记、无角标；pane 已渲染=${paneRendered}）`
    : `FAIL（${JSON.stringify(neg).slice(0, 260)}）`);
  log('E2E 负路径官方布局完好',
    paneOk
      ? (paneRendered ? 'PASS（sidebar + conversation 都在）' : 'PASS（首屏为引导页、AppFrame 未渲染，无法适用）')
      : `FAIL（pane=${JSON.stringify(neg.planes)}）`);

  // 正路径若已渲染 pane，则 mini 模式下同样应为满宽单栏（sidebar 折叠不影响存在性）
  log('E2E 正路径 pane', Array.isArray(pos.planes) ? pos.planes.join(',') : '(未渲染)');

  // ---- 批次 3 负路径：断网 → 必须给可读错误，不得白屏 ----
  const offline = await runOfflineE2E(log);

  // ---- 批次 4：小窗宽度下「会话切换」到底够不着得到 ----
  const sessSwitch = await runSessionSwitchE2E(log);

  return { ok: posOk && negOk && offline.ok && sessSwitch.ok, pos, neg, paneRendered, offline, sessSwitch };
}

/**
 * 批次 4 实测：输入卡 + 键盘行为 + 会话切换入口 + 空态负路径。
 *
 * ## 为什么是「验证官方」而不是「自建输入卡」
 *
 * 与批次 3 同理：官方 `dsh-client-ui-conversation` 自己就渲染 composer
 * （`conversation.composer` 是 **chain** slot、`conversation.composer.bar` 是 single，
 * 见 contract/slots.d.ts）。实测已确认 `[data-composer-card]` / `[data-composer-input]`
 * 各 1 个，且存在 345×52 的可编辑元素 ⇒ 输入卡是官方提供的。
 *
 * ## 测什么（按「是否会产生副作用」筛选）
 *
 * ✅ 安全、可真跑：
 *   - 输入卡存在 + 可编辑
 *   - **真的聚焦并输入文本**，断言文本落到 DOM 里（不发消息）
 *   - **Shift+Enter** → 断言插入换行而**不发送**（Enter 才会发送）
 *   - 无会话时的**空态**：必须给可读文案而不是破版/白屏
 *
 * ⚠️ **不测**：按 Enter 发送、流式回复、Markdown 渲染 ——
 *   这些会**真实消耗用户 API 额度**。AI 不得代发，须由用户手动确认。
 *
 * ## 会话切换入口（用户点名项）
 *
 * 已知实测（批次 2 矩阵）：vw=460 时 `[data-dsh-responsive-part="sidebar-toggle"]`
 * 是 **44×44@(10,?)`（宽窗下只有 28×28）—— 官方**特意把窄窗下的开关放大到触屏尺寸**，
 * 说明它设计上就是窄窗的会话切换入口。
 * 该项只在**有会话**时才渲染（无会话显示 hero 空态），故本函数**分别在两种状态下量**：
 *   - 若页面是 hero 空态 → 记为「空态负路径 PASS + 切换入口不适用（无会话）」
 *   - 若有会话 → 量入口几何 + 命中测试 + 真点一次看侧栏是否展开
 */
async function runSessionSwitchE2E(log) {
  const ORIGIN = process.env.DSH_MINI_E2E_ORIGIN || DSH_ORIGIN;
  const win = new BrowserWindow({
    width: 460, height: 720, show: false,
    webPreferences: { partition: PARTITION, webviewTag: true, contextIsolation: true, sandbox: false },
  });
  try {
    await win.loadFile(path.join(__dirname, 'renderer', 'panel.html'), {
      query: {
        origin: ORIGIN,
        preload: pathToFileURL(path.join(__dirname, 'lib', 'webview-ls-seed.js')).href,
      },
    });
    const guest = await new Promise((resolve) => {
      const to = setTimeout(() => resolve(undefined), 20000);
      win.webContents.once('did-attach-webview', (_e, g) => { clearTimeout(to); resolve(g); });
      win.webContents.executeJavaScript(
        `document.getElementById('view').src = ${JSON.stringify(ORIGIN + '/?dsh-mini=1')}; true`,
      ).catch(() => {});
    });
    if (guest === undefined) { log('[b4] guest 未 attach', 'FAIL'); return { ok: false, reason: 'no-guest' }; }
    await new Promise((resolve) => {
      const to = setTimeout(resolve, 30000);
      if (guest.isLoading && guest.isLoading()) guest.once('did-finish-load', () => { clearTimeout(to); resolve(); });
      else { clearTimeout(to); resolve(); }
    });
    // 等对话区出现（轮询，不用固定 sleep）
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      try {
        const n = await guest.executeJavaScript(`document.querySelectorAll('[data-composer-input]').length`);
        if (n > 0) break;
      } catch { /* 仍在导航 */ }
      await new Promise((r) => setTimeout(r, 500));
    }

    // ---- 1) 页面状态 + 输入卡 ----
    const state = JSON.parse(await guest.executeJavaScript(`(function(){
      function box(el){ if(!el) return null; var r=el.getBoundingClientRect();
        return { x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height),
                 cx:Math.round(r.x+r.width/2), cy:Math.round(r.y+r.height/2) }; }
      // 可编辑元素的检测要放宽：DSH 的输入框可能是 contenteditable=""（空串而非 "true"）、
      // 或 role="textbox"，或带 data-composer-input 的容器内的可编辑节点。
      // 只查 [contenteditable="true"] 会漏（实测 editableCount=0 但 composerInput=1）。
      var eds = [];
      document.querySelectorAll('[contenteditable], textarea, input, [role="textbox"]').forEach(function(e){
        var ce = e.getAttribute('contenteditable');
        var isEd = (ce !== null && ce !== 'false') || e.tagName === 'TEXTAREA'
                   || (e.tagName === 'INPUT' && e.type !== 'hidden') || e.getAttribute('role') === 'textbox';
        if (isEd) eds.push(e);
      });
      var first = eds.length ? eds[0] : null;
      var toggle = document.querySelector('[data-dsh-responsive-part="sidebar-toggle"]');
      var tb = box(toggle);
      var hit = null, hitIsToggle = false;
      if (tb) {
        var el = document.elementFromPoint(tb.cx, tb.cy);
        hit = el ? (el.tagName.toLowerCase() + (el.getAttribute('data-dsh-responsive-part')
                   ? '[' + el.getAttribute('data-dsh-responsive-part') + ']' : '')) : null;
        hitIsToggle = !!(el && toggle && (el === toggle || toggle.contains(el)));
      }
      var pane = document.querySelector('[data-pane="sidebar"]');
      var pb = box(pane);
      return JSON.stringify({
        phase: (document.querySelector('[data-phase]') || {}).getAttribute
                 ? document.querySelector('[data-phase]').getAttribute('data-phase') : null,
        hasHero: !!document.querySelector('[data-content-phase="hero"]'),
        composerCard: document.querySelectorAll('[data-composer-card]').length,
        composerInput: document.querySelectorAll('[data-composer-input]').length,
        editableCount: eds.length,
        firstEditable: box(first),
        firstEditableText: first ? String(first.innerText || '').slice(0, 40) : null,
        toggle: tb,
        toggleHit: hit,
        toggleHittable: hitIsToggle,
        sidebar: pb,
        sidebarEntryCount: document.querySelectorAll('[data-dsh-responsive-part="sidebar-entry"]').length,
        sessionRows: document.querySelectorAll('[data-row-key^="session:"], [data-row-key^="workspace:"]').length,
        bodyTextHead: document.body ? document.body.innerText.slice(0, 100).replace(/\\n/g,' | ') : '',
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      });
    })()`));

    log('[b4] 页面 phase', `${state.phase ?? '(无)'}  hero=${state.hasHero}`);
    log('[b4] 输入卡', `card=${state.composerCard} input=${state.composerInput} 可编辑=${state.editableCount} ${state.firstEditable ? state.firstEditable.w + '×' + state.firstEditable.h : ''}`);
    log('[b4] 切换入口', state.toggle ? `${state.toggle.w}×${state.toggle.h}@(${state.toggle.x},${state.toggle.y})` : '(未渲染)');
    log('[b4] 入口命中测试', state.toggle ? `${state.toggleHit} → 是入口本身=${state.toggleHittable}` : '(不适用)');
    log('[b4] 侧栏', state.sidebar ? `${state.sidebar.w}×${state.sidebar.h}（条目 ${state.sidebarEntryCount}、会话行 ${state.sessionRows}）` : '(未渲染)');
    log('[b4] 横向溢出', `${state.docOverflow}px`);
    log('[b4] 页面文本头', state.bodyTextHead);

    // ---- 2) 键盘行为：真输入 + Shift+Enter（安全，不发消息）----
    let keyboard = null;
    if (state.editableCount > 0) {
      try {
        const r = await guest.executeJavaScript(`(function(){
          // ⚠️ 选择器必须与测量段保持一致。首版这里仍用旧的窄选择器
          // （[contenteditable="true"], textarea），而 DSH 的输入框是
          // [contenteditable] 空串 / role="textbox"，于是拿到 no-editable 假失败。
          var eds = [];
          document.querySelectorAll('[contenteditable], textarea, input, [role="textbox"]').forEach(function(e){
            var ce = e.getAttribute('contenteditable');
            var isEd = (ce !== null && ce !== 'false') || e.tagName === 'TEXTAREA'
                       || (e.tagName === 'INPUT' && e.type !== 'hidden') || e.getAttribute('role') === 'textbox';
            if (isEd) eds.push(e);
          });
          // 优先挑真正可见可点的那个（hero 态下 DOM 里可能有多个隐藏的可编辑节点）
          var el = null;
          for (var i = 0; i < eds.length; i++) {
            var rr = eds[i].getBoundingClientRect();
            if (rr.width > 8 && rr.height > 8) { el = eds[i]; break; }
          }
          if (!el) el = eds[0];
          if (!el) return JSON.stringify({ ok:false, reason:'no-editable', candidates: eds.length });

          el.focus();
          var probe = '__dshmini_probe__';
          var read = function(){
            return String(el.isContentEditable ? (el.innerText || el.textContent || '') : (el.value || ''));
          };
          if (el.isContentEditable) {
            document.execCommand('insertText', false, probe);
          } else {
            el.value = (el.value || '') + probe;
            el.dispatchEvent(new Event('input', { bubbles:true }));
          }
          var afterType = read();
          var kev = function(type){
            return new KeyboardEvent(type, { key:'Enter', code:'Enter', keyCode:13, which:13,
              shiftKey:true, bubbles:true, cancelable:true });
          };
          el.dispatchEvent(kev('keydown'));
          el.dispatchEvent(kev('keypress'));
          el.dispatchEvent(kev('keyup'));
          var afterShiftEnter = read();
          return JSON.stringify({
            ok: true,
            tag: el.tagName.toLowerCase(),
            candidates: eds.length,
            typedLanded: afterType.indexOf(probe) >= 0,
            afterTypeLen: afterType.length,
            afterShiftEnterLen: afterShiftEnter.length,
            grewOnShiftEnter: afterShiftEnter.length > afterType.length,
            stillInInput: afterShiftEnter.indexOf(probe) >= 0
          });
        })()`);
        keyboard = JSON.parse(r);
        log('[b4] 真输入文本落盘', keyboard.typedLanded ? 'PASS' : `FAIL（${JSON.stringify(keyboard)}）`);
        log('[b4] Shift+Enter 后文本仍在输入框（未发送）', keyboard.stillInInput ? 'PASS' : 'FAIL');
        log('[b4] Shift+Enter 是否插入换行', keyboard.grewOnShiftEnter ? 'PASS（长度增长）' : `未增长（${keyboard.afterTypeLen} → ${keyboard.afterShiftEnterLen}，可能被编辑器规范化）`);
      } catch (err) {
        log('[b4] 键盘测试', `FAIL（${err.message}）`);
        keyboard = { ok: false, error: err.message };
      }
    }

    // ---- 3) 判定 ----
    const noSessionEmptyState = state.hasHero === true && (state.bodyTextHead || '').length > 10;
    const composerOk = state.composerInput > 0 && state.editableCount > 0;
    const overflowOk = state.docOverflow === 0;
    const keyboardOk = keyboard === null ? false : (keyboard.typedLanded === true && keyboard.stillInInput === true);
    // 有会话时才算切换入口；无会话（hero）时该项不适用，按通过计
    const toggleApplicable = state.toggle !== null;
    const toggleOk = !toggleApplicable || state.toggleHittable === true;

    log('E2E 输入卡存在且可编辑', composerOk ? 'PASS' : 'FAIL');
    log('E2E 键盘：输入落到 DOM 且 Shift+Enter 不发送', keyboardOk ? 'PASS' : 'FAIL');
    log('E2E 窄窗不破版（横向溢出 0）', overflowOk ? 'PASS' : `FAIL（${state.docOverflow}px）`);
    log('E2E 负路径：无会话显示 hero 空态（可读、非破版）',
      noSessionEmptyState ? 'PASS' : `不适用或 FAIL（hero=${state.hasHero} 文本长度 ${(state.bodyTextHead || '').length}）`);
    log('E2E 会话切换入口可达',
      toggleApplicable
        ? (toggleOk ? `PASS（${state.toggle.w}×${state.toggle.h}，命中测试通过）` : 'FAIL（被遮挡）')
        : '不适用（无会话 ⇒ 官方显示 hero 空态，侧栏与入口本就不渲染）');
    log('E2E 未测项（需用户手动）', '按 Enter 发送 / 流式回复 / Markdown 渲染 —— 会消耗 API 额度，AI 不代发');

    const ok = composerOk && keyboardOk && overflowOk && toggleOk;
    return { ok, state, keyboard, noSessionEmptyState, toggleApplicable };
  } catch (err) {
    log('[b4] FAIL', err.message);
    return { ok: false, error: err.message };
  } finally {
    try { win.destroy(); } catch { /* noop */ }
  }
}

/**
 * 批次 3 负路径：DSH 不可达时，小窗必须给**可读错误**，而不是白屏。
 *
 * 做法：把 panel.html 的 `origin` 指向一个**确保没人监听**的端口，
 * 然后读回 DOM，断言：
 *   ① `#gate` 兜底层可见（不是一片空白）
 *   ② 兜底层里有**可读文案**（非空、且提到失败原因）
 * 这是「不白屏」的直接证据。
 */
async function runOfflineE2E(log) {
  // 选一个几乎不可能被占用的端口
  const DEAD_ORIGIN = process.env.DSH_OFFLINE_ORIGIN || 'http://127.0.0.1:9';
  const win = new BrowserWindow({
    width: 460, height: 720, show: false,
    webPreferences: { partition: PARTITION, webviewTag: true, contextIsolation: true, sandbox: false },
  });
  try {
    await win.loadFile(path.join(__dirname, 'renderer', 'panel.html'), {
      query: {
        origin: DEAD_ORIGIN,
        preload: pathToFileURL(path.join(__dirname, 'lib', 'webview-ls-seed.js')).href,
      },
    });
    // 给握手探测留时间（probe 会走 session.fetch，必然失败）
    await new Promise((r) => setTimeout(r, 6000));

    const raw = await win.webContents.executeJavaScript(`(function(){
      var gate = document.getElementById('gate');
      var info = document.getElementById('gate-info');
      var cs = gate ? getComputedStyle(gate) : null;
      return JSON.stringify({
        gateVisible: !!(gate && cs && cs.display !== 'none' && gate.classList.contains('show')),
        gateText: (gate ? gate.innerText : '').slice(0, 200),
        gateInfo: info ? info.innerText.slice(0, 200) : '',
        bodyText: document.body ? document.body.innerText.slice(0, 200) : '',
        // 白屏判据：body 里可见文本长度为 0
        visibleTextLen: document.body ? document.body.innerText.trim().length : 0
      });
    })()`);
    const d = JSON.parse(raw);
    log('[offline] gate 可见', d.gateVisible);
    log('[offline] 兜底文案', JSON.stringify(d.gateText.replace(/\n/g, ' | ')));
    log('[offline] 可见文本长度', d.visibleTextLen);

    const readable = d.visibleTextLen > 10;      // 不是白屏
    const hasReason = /握手|失败|确认|DSH/i.test(d.gateText + d.gateInfo);
    const ok = readable && hasReason;
    log('E2E 负路径（DSH 不可达）', ok
      ? `PASS（给出可读提示，文本 ${d.visibleTextLen} 字，非白屏）`
      : `FAIL（可读=${readable} 含原因=${hasReason}）`);
    return { ok, ...d };
  } catch (err) {
    log('E2E 负路径（DSH 不可达）', `FAIL（${err.message}）`);
    return { ok: false, error: err.message };
  } finally {
    try { win.destroy(); } catch { /* noop */ }
  }
}

/**
 * 注入的端到端验证：真开一个 webview 加载 DSH_ORIGIN，让它在页面脚本里读 localStorage，
 * 断言读到的是我们注入的宿主标记。
 *
 * 为什么要真开窗口：preload 是否在**页面脚本之前**执行、origin 是否匹配、
 * sendSync 通道是否通 —— 这些都只有真跑一次才算验过。
 * 只用单元测试验 normalizeSeed 是不够的（那只证明映射函数对，不证明注入生效）。
 */
async function runInjectE2E(log) {
  const expectKeys = (process.env.DSH_E2E_KEYS || 'dam-skin,dsh-auto-memory.tourDismissed,dsh-auto-memory.semWizardDone')
    .split(',').map((s) => s.trim()).filter(Boolean);

  // 负路径开关：不挂 preload。用来证明「注入确实是 preload 干的」，
  // 而不是分区里本来就有数据（239 条恰好等于 seed 条数，必须排除巧合）。
  const noPreload = process.env.DSH_COMPANION_E2E_NOPRELOAD === '1';

  // 无论哪个分支都先清空该分区的 localStorage，保证起点干净
  try {
    await session.fromPartition(PARTITION).clearStorageData({ storages: ['localstorage'] });
    log('E2E 已清空分区 localStorage', true);
  } catch (err) {
    log('E2E 清空失败', err.message);
  }

  const win = new BrowserWindow({
    width: 520, height: 700, show: false,
    webPreferences: { partition: PARTITION, webviewTag: true, contextIsolation: true, sandbox: false },
  });

  try {
    const pageOk = await win.loadFile(path.join(__dirname, 'renderer', 'panel.html'), {
      query: {
        origin: DSH_ORIGIN,
        // 负路径：传空 preload，panel.js 的 armViewPreload() 会跳过设置
        preload: noPreload ? '' : pathToFileURL(path.join(__dirname, 'lib', 'webview-ls-seed.js')).href,
      },
    }).then(() => true).catch(() => false);
    log('E2E 载入 panel.html', pageOk);
    log('E2E 模式', noPreload ? '负路径（不挂 preload）' : '正路径（挂 preload）');

    // 直接驱动 webview 加载目标页，避免依赖握手时序
    const guest = await new Promise((resolve) => {
      const to = setTimeout(() => resolve(undefined), 20000);
      win.webContents.once('did-attach-webview', (_e, g) => { clearTimeout(to); resolve(g); });
      // 触发 webview 出现
      win.webContents.executeJavaScript(
        `document.getElementById('view').src = ${JSON.stringify(DSH_ORIGIN + '/')}; true`,
      ).catch(() => {});
    });
    if (guest === undefined) { log('E2E guest', '未 attach'); return { ok: false, reason: 'no-guest' }; }

    await new Promise((resolve) => {
      const to = setTimeout(resolve, 25000);
      if (guest.isLoading && guest.isLoading()) guest.once('did-finish-load', () => { clearTimeout(to); resolve(); });
      else { clearTimeout(to); resolve(); }
    });

    const probe = await guest.executeJavaScript(`(function(){
      var out = { origin: location.origin, count: 0, keys: {}, preloadResult: null };
      try {
        out.count = localStorage.length;
        ${JSON.stringify(expectKeys)}.forEach(function(k){ out.keys[k] = localStorage.getItem(k); });
        out.preloadResult = window.__dshMiniSeedResult || null;
      } catch (e) { out.err = String(e && e.message); }
      return JSON.stringify(out);
    })()`);

    const data = JSON.parse(probe);
    log('E2E webview origin', data.origin);
    log('E2E localStorage 条目数', data.count);
    log('E2E preload 自报', data.preloadResult);
    let allHit = true;
    for (const k of expectKeys) {
      const v = data.keys[k];
      const hit = typeof v === 'string' && v.length > 0;
      if (!hit) allHit = false;
      log(`E2E key ${k}`, hit ? `✓ ${JSON.stringify(v.slice(0, 40))}` : '✗ 缺失');
    }
    return { ok: allHit, count: data.count, origin: data.origin };
  } catch (err) {
    log('E2E ERROR', err.message);
    return { ok: false, reason: err.message };
  } finally {
    try { win.destroy(); } catch { /* noop */ }
  }
}

// ---- 未捕获异常处理（★ 2026-10-11 新增，事故驱动）-------------------------
/**
 * 事故：桌面上 Electron 的「A JavaScript error occurred in the main process」错误框
 * **反复闪烁**，关不掉。
 *
 * 两层根因：
 *   ① 本文件此前**完全没有** `uncaughtException` / `unhandledRejection` 处理器
 *      ⇒ 任何一处未捕获异常都会触发 Electron 的默认行为：**弹模态错误框**；
 *   ② 模态框存在期间 `app.exit()`/`app.quit()` **无法终止进程**
 *      ⇒ 进程赖着不走、弹窗留在桌面上，于是用户看到"一直在闪"。
 *      （这一点是在我的探针上实测确认的：7 个探针卡在后台反复弹框，
 *        杀掉进程前它们不会自行退出。）
 *
 * Companion 是**常驻程序**，不能像一次性探针那样一异常就退出（那会让悬浮球凭空消失）。
 * 所以这里的策略是「**记日志 + 不弹框 + 存活**」：
 *   · 记录到日志文件，便于事后定位；
 *   · 不让异常升级为模态框（避免遮挡用户桌面）；
 *   · 保留进程继续服务（悬浮球/小窗仍在）。
 *
 * ⚠️ 这是**兜底**，不是"允许随便抛异常"的许可 —— 真正的缺陷仍须定位修复。
 */
function logFatal(kind, err) {
  const line = `[${new Date().toISOString()}] [FATAL:${kind}] ${err && (err.stack || err.message) || err}\n`;
  try { process.stderr.write(line); } catch { /* EPIPE：管道已关闭，忽略 */ }
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'companion-error.log'), line, 'utf8');
  } catch { /* 日志写不进去也不能再抛 */ }
}
process.on('uncaughtException', (err) => logFatal('uncaughtException', err));
process.on('unhandledRejection', (reason) => logFatal('unhandledRejection', reason));

// 单实例：避免重复起球
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { createPanel(); });

  app.whenReady().then(async () => {
    // 先读回持久化状态。**必须在 saveState() 之前**——否则会用默认值覆盖
    // 用户已有的球位置与小窗几何（这是顺序性真 bug，别调换）。
    loadState();

    // ⚠️ 顺序约束：seed 必须在**任何窗口/ session 打开之前**准备好，
    // 因为 webview 的 preload 在页面脚本运行前就要同步取走它。
    //
    // 历史教训（勿走回头路）：曾经这里是「把宿主 leveldb 目录整份拷进本分区」。
    // **实测证伪**：拷贝本身成功（7 文件 / 191193 B），但 Chromium 一打开就整库
    // 丢弃重建（运行后只剩 41 B 空 MANIFEST、.ldb 全删）——LocalStorage 的
    // schema 跨 Chromium 版本不兼容（宿主壳 Electron 44.0.0 vs 本进程 44.7.0）。
    // ⇒ 正确通路是「读键值 → 映射 origin → 应用层注入」，不是拷文件。
    //
    // 传入 DSH_ORIGIN：宿主侧业务 key 挂在 `dsh-app://app`，必须映射到 webview
    // 实际会有的 origin，否则一条都注不进去（详见 lib/ls-seed.js 头部）。
    {
      const meta = refreshLsSeed(DSH_ORIGIN);
      if (meta.loaded) {
        console.info(
          `[companion] ls-seed 就绪：${meta.entries} 条 → ${DSH_ORIGIN}`
          + `（来源 ${meta.source}，映射自 ${(meta.mergedFrom || []).join(' + ') || 'n/a'}，${meta.bytes} B）`,
        );
      } else {
        console.warn(`[companion] ls-seed 不可用（${meta.reason}）—— 小窗将不带宿主标记，插件可能弹首次引导`);
      }
    }

    if (process.env.DSH_COMPANION_SELFTEST === '1') {
      console.info('[selftest] ls-seed:', JSON.stringify(lsSeedMeta));
      await runSelfTest();
      return;
    }
    createBall();
    // 托盘：提供退出入口（悬浮球本身没有右键菜单）
    try {
      const trayIconPath = fs.existsSync(ICON.tray) ? ICON.tray : ICON.app;
      const img = nativeImage.createFromPath(trayIconPath);
      if (!img.isEmpty()) {
        const tray = new Tray(img.resize({ width: 16, height: 16 }));
        tray.setToolTip('DeepSeek 小窗');
        tray.setContextMenu(Menu.buildFromTemplate([
          { label: '打开小窗', click: () => createPanel() },
          { label: state.showBall ? '隐藏悬浮球' : '显示悬浮球', click: () => {
              state.showBall = !state.showBall;
              if (ballWin && !ballWin.isDestroyed()) state.showBall ? ballWin.showInactive() : ballWin.hide();
              saveState();
            } },
          { type: 'separator' },
          { label: '退出', click: () => { app.quit(); } },
        ]));
      } else {
        console.error('[companion] 托盘图标为空，跳过托盘');
      }
    } catch (err) { console.error('[companion] tray init failed:', err.message); }

    app.on('activate', () => { createBall(); });
  });

  // 关掉小窗不退出进程（悬浮球仍在）
  app.on('window-all-closed', (e) => { e.preventDefault?.(); });
}

module.exports = {};
