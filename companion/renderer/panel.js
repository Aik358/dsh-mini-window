/**
 * 小窗外壳逻辑 —— 参考实现形态（T1–T9 顶栏 + 卡片 + 贴底输入卡）
 *
 * 职责：
 *   ① 顶栏控件（最小化 / 置顶 / 侧栏 / 模型名 / 紧凑浮窗 / 更多 / 右栏）
 *   ② 用 webview 承载 DSH 官方界面（**不自己实现聊天界面**，见 docs/02）
 *   ③ 握手失败时给出可操作提示
 *
 * ## 架构决策（已实测，勿改）
 *
 * 顶栏由**宿主页 DOM 覆盖**在 `<webview>` 之上，而不是画在 guest 里。
 * 判据（`probe/overlay-zorder.cjs`）：宿主页注入 400×55 纯红块后
 * `webContents.capturePage()` 抓到红色像素 **22000/22000 = 100%**
 * ⇒ DOM 能被真实合成到 webview 之上。
 *
 * 这样做的好处：最小化/置顶/紧凑浮窗保持**真原生 Electron 能力**，
 * 不必往 guest 注入 IPC 桥（少一层安全面，也不会被 DSH 前端重构打断）。
 * 代价：T3/T4/T8/T9 这类「官方能力」必须**转发到 guest 里的真控件**，
 * 故本文件通过 `view.executeJavaScript` 代理（见 forwardToOfficial）。
 *
 * ⚠️ 所有 guest 内选择器都来自实测契约（`probe/official-controls.cjs`），
 *    不得使用 `[class*="..."]` 之类的猜测选择器。
 */
'use strict';

const view = document.getElementById('view');
const gate = document.getElementById('gate');
const statusDot = document.getElementById('status');
const gateInfo = document.getElementById('gate-info');
const menu = document.getElementById('menu');

const params = new URLSearchParams(location.search);
const ORIGIN = params.get('origin') || 'http://127.0.0.1:19387';
/** 主进程传来的 webview preload 的 file:// 绝对 URL（见 main.js）。 */
const VIEW_PRELOAD = params.get('preload') || '';
/**
 * 小窗模式的 URL 参数。带它就触发插件侧的紧凑视图（对齐参考实现用 URL 判据切小窗）。
 * 默认开启：小窗本来就该是小窗模式。
 */
const MINI_PARAM = params.get('mini') || 'dsh-mini=1';

/**
 * 首次导航前把 preload 挂到 webview 上。
 *
 * 两条硬约束（实测）：
 *   1. webview 的 `preload` 必须是 **file:// 绝对 URL**，相对路径不可靠；
 *   2. 必须在**首次 src 赋值之前**设好，否则首次导航用不上它
 *      （而首次导航恰恰是小窗真正加载 DSH 界面的那一次，最需要注入）。
 */
function armViewPreload() {
  if (VIEW_PRELOAD === '') return;
  try {
    view.setAttribute('preload', VIEW_PRELOAD);
  } catch (err) {
    console.warn('[panel] 设置 webview preload 失败:', err && err.message);
  }
}
armViewPreload();

/**
 * 安全拿 companion 桥。
 *
 * ⚠️ 2026-10-11 实测教训：宿主页的 `window.companion` 由**主进程 BrowserWindow 的
 * `webPreferences.preload`** 注入（不是 `loadFile` 的 query 参数 —— 那个是给
 * `<webview>` 用的）。任何**没走 createPanel()** 的窗口（例如探针自己 new 的
 * BrowserWindow）都拿不到它，于是：
 *
 *     TypeError: Cannot read properties of undefined (reading 'togglePin')
 *
 * 这类错误会让**整个点击处理器中断**（症状：按钮点了没反应，且控制台才有线索）。
 * ⇒ 所有用到桥的地方都必须先判空，**缺失时降级而不是抛错**。
 */
function bridge() {
  return (typeof window !== 'undefined' && window.companion) ? window.companion : null;
}

let pinned = true;
let compact = false;

// ---- 通用：激活态（★ 修复「按下去看不出激活/未激活」）--------------------
/**
 * 设置按钮的激活态。
 *
 * 用户实测反馈：「置顶一类的按钮按下去之后，激活和未激活状态并没有一个高亮的显示进行区分」。
 * 修复方式：**同时**写 class 与 `aria-pressed` —— 样式表里两者都认
 * （`.tb.active` 与 `.tb[aria-pressed="true"]`），任一处生效即可见；
 * `aria-pressed` 还顺带让无障碍工具能读到状态。
 *
 * ⚠️ 此前的写法只 `classList.toggle('active')`，而样式表里 `.tb.active`
 * 只有 `opacity:1; color:#F6F6F6` —— 在深色底上**几乎看不出差别**，
 * 这就是"没有高亮"的真因。现在激活态有：底色 + 内描边 + 纯白字。
 */
function setActive(el, on) {
  if (!el) return;
  el.classList.toggle('active', !!on);
  el.setAttribute('aria-pressed', on ? 'true' : 'false');
}

// ---- 字体/界面缩放（★ 新增：用户反馈「字体还有点大，不知道有没有设置的地方」）----
/**
 * 界面缩放档位。
 *
 * 为什么用 **webview 的 zoomFactor** 而不是改 CSS 字号：
 *   guest 里是 DSH 官方界面，改它的 CSS 字号会破坏官方排版；
 *   zoomFactor 是 Electron 官方的整页缩放，视觉一致且不动 DOM。
 * 档位与浏览器一致（0.8 / 0.9 / 1.0 / 1.1 / 1.25 / 1.5），默认 1.0。
 */
const ZOOM_STEPS = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5];
const ZOOM_KEY = 'mini.zoomFactor';
let zoomIdx = ZOOM_STEPS.indexOf(1.0);

function applyZoom() {
  const z = ZOOM_STEPS[zoomIdx];
  // webview 未就绪时 setZoomFactor 尚不存在 —— 判类型而不是 try/catch（实测报 is not a function）
  if (typeof view.setZoomFactor !== 'function') return;
  try { view.setZoomFactor(z); } catch (err) { console.warn('[panel] setZoomFactor 失败', err); }
  const label = document.getElementById('zoom-val');
  if (label) label.textContent = Math.round(z * 100) + '%';
  const out = document.getElementById('zoom-out');
  const inb = document.getElementById('zoom-in');
  if (out) out.disabled = zoomIdx === 0;
  if (inb) inb.disabled = zoomIdx === ZOOM_STEPS.length - 1;
  try { localStorage.setItem(ZOOM_KEY, String(z)); } catch { /* 忽略 */ }
  enforceZoom();
}

/**
 * ★ 强制把 webview 缩放对齐到「用户档位」——**不信任 Chromium 的 per-origin 记忆**。
 *
 * 实测问题（evidence/batch11-zoom-clean.log）：
 *   `localStorage['mini.zoomFactor']` = `"1"`，但 `devicePixelRatio` = **1.1**。
 * ⇒ Chromium 会**独立于我们的 localStorage** 按 origin 记住缩放
 *   （用户 Ctrl+滚轮、或我们调过 API 都会写进它自己的表）。
 *   结果就是「档位显示 100%，实际却是 110%」，两者不一致。
 *
 * 修法：每次设置/加载后都**主动压回去并读回校验**，不一致就再压一次。
 */
function enforceZoom() {
  if (typeof view.setZoomFactor !== 'function') return;
  const target = ZOOM_STEPS[zoomIdx];
  try {
    view.setZoomFactor(target);
    if (typeof view.getZoomFactor === 'function') {
      const cur = view.getZoomFactor();
      if (Math.abs(cur - target) > 0.001) view.setZoomFactor(target);
    }
  } catch (err) { console.warn('[panel] enforceZoom 失败', err); }
}

document.getElementById('zoom-out').addEventListener('click', (e) => {
  e.stopPropagation();
  if (zoomIdx > 0) { zoomIdx--; applyZoom(); }
});
document.getElementById('zoom-in').addEventListener('click', (e) => {
  e.stopPropagation();
  if (zoomIdx < ZOOM_STEPS.length - 1) { zoomIdx++; applyZoom(); }
});

// ---- 顶栏按钮 ------------------------------------------------------------
document.getElementById('t1').addEventListener('click', () => { const b = bridge(); if (b) b.panel.minimize(); });
document.getElementById('t2').addEventListener('click', async (ev) => {
  // ★ 必须**先**把元素取出来：`ev.currentTarget` 在 await 之后会变成 null
  //   （DOM 规范：事件派发结束后 currentTarget 置空）。
  //   实测报错：`Cannot set properties of null (setting 'title')` —— panel.js:142。
  const el = ev.currentTarget;
  const b = bridge();
  if (!b) { console.warn('[panel] companion 桥不可用，置顶开关无效'); return; }
  try {
    pinned = await b.togglePin();
  } catch (err) {
    console.warn('[panel] togglePin 失败：', err && err.message);
    return;
  }
  setActive(el, pinned);
  el.title = pinned ? '已置顶（点击取消）' : '置顶';
  try { b.set({ pinned }); } catch { /* 忽略 */ }
});

/**
 * 把动作转发给 guest 里**官方自己的真控件**。
 *
 * ## ★ 2026-10-11 重要修复：为什么以前「点了没反应」
 *
 * 真因不在转发，而在**插件 CSS 把目标自己隐藏了**：
 * 插件的 MINI_CSS 曾经写 `[data-pane="sidebar"]{display:none}` ——
 * 于是转发点击虽然成功（官方状态机确实切了），但**侧栏容器永不显示**，
 * 用户看到的就是"按一下，什么也没发生"。
 * 该 CSS 已删除（改为只收敛视觉 rail、不动 display）。
 *
 * 另外这里**加了结果校验**：不只报 "clicked"，还要读回目标在点击后的**真实宽度**，
 * 把「点到了但没变化」和「点到了且真的展开了」区分开 —— 避免再次出现"假成功"。
 */
async function forwardToOfficial(sel, verifySel) {
  try {
    return await view.executeJavaScript(`(function(){
      var el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return { ok:false, reason:'not-found' };
      var r0 = el.getBoundingClientRect();
      el.click();
      return { ok:true, beforeW: Math.round(r0.width) };
    })()`);
  } catch (err) {
    return { ok: false, reason: (err && err.message) || 'execute-failed' };
  }
}

/** 读回某个选择器当前的真实宽度（用于判定「到底有没有真的展开」）。 */
async function measureSel(sel) {
  try {
    return await view.executeJavaScript(`(function(){
      var el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      var r = el.getBoundingClientRect();
      var cs = getComputedStyle(el);
      return { w: Math.round(r.width), h: Math.round(r.height),
               display: cs.display, x: Math.round(r.x) };
    })()`);
  } catch {
    return null;
  }
}

document.getElementById('t3').addEventListener('click', async (ev) => {
  // ★ 先取元素：await 之后 `ev.currentTarget` 会变 null（同 t2 的实测教训）
  const el = ev.currentTarget;
  const before = await measureSel('[data-pane="sidebar"]');
  const r = await forwardToOfficial('[data-dsh-responsive-part="sidebar-toggle"]');
  // 等官方状态机与布局稳定后再读回（实测切换是同步的，给 260ms 余量）
  await new Promise((res) => setTimeout(res, 260));
  const after = await measureSel('[data-pane="sidebar"]');
  const opened = !!(before && after && after.w > before.w + 40);
  setActive(el, opened);
  el.title = opened ? '收起侧栏' : '打开侧栏';
  if (!r.ok) {
    console.warn('[panel] 侧栏开关未找到：', r.reason);
    el.title = '侧栏不可用';
  } else if (!opened) {
    console.warn('[panel] 已点击侧栏开关但宽度未变化：', JSON.stringify({ before, after }));
  }
});

document.getElementById('t9').addEventListener('click', async () => {
  await forwardToOfficial('[data-sidebar-right-expand="true"]');
});

const t8 = document.getElementById('t8');
t8.addEventListener('click', (e) => {
  e.stopPropagation();
  const show = !menu.classList.contains('show');
  menu.classList.toggle('show', show);
  setActive(t8, show);
});
document.addEventListener('click', (e) => {
  if (!menu.classList.contains('show')) return;
  if (e.target.closest('#menu') || e.target.closest('#t8')) return;
  menu.classList.remove('show');
  setActive(t8, false);
});

document.getElementById('m-reload').addEventListener('click', () => { menu.classList.remove('show'); setActive(t8, false); loadApp(); });
document.getElementById('m-close').addEventListener('click', () => { menu.classList.remove('show'); setActive(t8, false); const b = bridge(); if (b) b.panel.close(); });
document.getElementById('m-main').addEventListener('click', () => { menu.classList.remove('show'); setActive(t8, false); const b = bridge(); if (b) b.showMain(); });

// ---- T7 紧凑浮窗：切换窗口尺寸（真原生） --------------------------------
document.getElementById('t7').addEventListener('click', async (ev) => {
  // ★ 同上：先取元素，再把异步放在后面
  const el = ev.currentTarget;
  compact = !compact;
  setActive(el, compact);
  el.title = compact ? '恢复常规小窗' : '紧凑浮窗';
  const b = bridge();
  try { if (b) await b.panel.setCompact(compact); } catch (err) {
    console.warn('[panel] 切换紧凑模式失败', err);
  }
});


// ---- 顶栏对齐：铺满方案下**不再需要同步** --------------------------------
/**
 * ★ 2026-10-11 用户裁定「铺满整个窗格」后，这里**整块同步逻辑已删除**。
 *
 * ## 为什么能删
 *
 * 旧实现要每 1.2s 从 guest 读卡片的 `getBoundingClientRect()` 来摆正顶栏，
 * 是因为卡片**不铺满**窗口：卡片居中、还有 60/30/90 的留白，
 * 而侧栏开合还会把卡片挤窄 ⇒ 顶栏必须跟着卡片实测几何走，否则"脱节"。
 *
 * 铺满之后：卡片 = 窗口，`#topbar` 用 `left:0; right:0; top:0` 就永远贴合，
 * **没有任何需要同步的量**。此前那三层真因（横向写死 left、纵向 top:0、侧栏挤窄）
 * 也随之全部不适用 —— 它们都是"卡片 ≠ 窗口"的产物。
 *
 * 保留函数壳是为了兼容外部调用点（did-finish-load 等）不必改动；
 * 它现在只有一个职责：确保顶栏宽度与窗口一致（极端情况下兜底）。
 */
function syncTopbarToCard() {
  const tb = document.getElementById('topbar');
  if (!tb) return;
  tb.style.left = '0';
  tb.style.right = '0';
  tb.style.top = '0';
  tb.style.width = '';
  tb.style.transform = 'none';
  const menu = document.getElementById('menu');
  if (menu) menu.style.left = '50%';
}

// guest 每次加载完成后同步一次；并周期性兜底（官方内部布局变化宿主侧观察不到）
view.addEventListener('did-finish-load', () => { setTimeout(syncTopbarToCard, 300); });
setInterval(syncTopbarToCard, 1200);
window.addEventListener('resize', () => { syncTopbarToCard(); });

// ---- T4 模型名：从 guest 的官方控件读，不自己造数据 ----------------------
/**
 * 读官方模型名。
 *
 * 实测（`probe/official-controls.cjs`）：hero 态下官方**没有**渲染
 * `conversation.input.model` 的 DOM（该 slot 是 session 作用域，hero 无会话）。
 * 因此这里**如实回退**：读不到就把 T4 隐藏，而不是编一个假名字。
 * 这是诚实边界，不是缺陷 —— 参考实现截图里的 "Akd" 需要真实会话才有对应物。
 */
async function readModelLabel() {
  try {
    const label = await view.executeJavaScript(`(function(){
      var el = document.querySelector('[data-slot="conversation.input.model"]');
      if (!el) return '';
      var t = String(el.innerText || '').replace(/\\s+/g, ' ').trim();
      return t.slice(0, 24);
    })()`);
    return label || '';
  } catch {
    return '';
  }
}


// ---- 拖动：**交给系统标题栏**（`-webkit-app-region: drag`）---------------
/**
 * ★ 2026-10-11 用户裁定「铺满整个窗格」后，这里**整块自绘拖动逻辑已删除**。
 *
 * ## 为什么能删
 *
 * 旧实现要自己实现拖动，是因为窗口是 `frame:false` + `transparent:true`：
 *   · 无边框 ⇒ 没有系统标题栏可拖；
 *   · 透明窗在 Windows 上**不能用系统边框缩放** ⇒ 连拖动都得自己算，
 *     还得自绘 8 个 `.rz` 缩放把手；
 *   · 这两者又必须与「透明区穿透」判定保持几何一致 ——
 *     一旦不一致就出现用户报的「得找一段空白才能拖」「粘手」。
 *
 * 铺满之后窗口变为**不透明**（`transparent:false`），于是：
 *   · CSS 里 `#topbar { -webkit-app-region: drag }` 让系统直接把顶栏当标题栏拖；
 *   · 系统自带边框缩放与阴影（`resizable:true` + `hasShadow:true`）。
 *
 * ⇒ 自绘拖动、自绘缩放把手、穿透判定、热区自检**全部不再需要**，
 *   连同它们的缺陷整条消失。这就是用户要的"更方便、更简单"。
 *
 * 保留 `topbar` 变量供下面的双击逻辑使用。
 */
const topbar = document.getElementById('topbar');


// 双击顶栏空白处 = 在「常规 / 紧凑」之间切换（参考实现式习惯，可选）
// ---- 双击顶栏 = 退出紧凑模式（★ 不再切换紧凑！）--------------------------
/**
 * ★★ 2026-10-11 真缺陷修正 —— 这是「默认的情况是很小的」的**真凶**。
 *
 * 旧实现：`topbar` 双击 → `document.getElementById('t7').click()` → 切紧凑浮窗（400×420）。
 *
 * 为什么它是缺陷：**双击标题栏是"最大化/还原"的通用肌肉记忆**，用户随手双击就掉进
 * 紧凑模式；更糟的是 `main.js` 的 `panelWin.on('resized', persistPanelBounds)`
 * 会把 400×420 **当作常规几何存进 state** ⇒ **此后每次打开小窗都是很小的**，
 * 而且用户根本不知道是自己双击造成的。
 *
 * 现在：双击**只用于"退出紧凑"**（还原语义，与通用习惯一致）；
 * 常规态下双击**不做任何事**（不缩小）。进入紧凑仍然只能通过 T7 显式点击。
 */
topbar.addEventListener('dblclick', (e) => {
  if (e.target.closest('button')) return;
  if (!compact) return;                  // 常规态双击：不动作（不再缩小）
  document.getElementById('t7').click(); // 紧凑态双击：还原
});

// ---- 加载界面 ------------------------------------------------------------
let loaded = false;

/**
 * 加载官方界面。
 *
 * 入口就是 DSH 本体的根路径 `/` —— 我们已经在主进程里自签了合法的会话 cookie，
 * 所以这里能直接 200 拿到官方 UI。
 *
 * 历史教训（别再改回去）：
 *   · 用 `/pair-app` 或 `/pair-accept` 是**错的** —— 那是某第三方插件的路由，
 *     Companion 不依赖任何插件，那些路径在别人机器上根本不存在。
 *   · 也不要在主进程里用 `redirect:'manual'` 手动跟重定向：Electron 会抛
 *     `Redirect was cancelled`（Node 原生 fetch 才返回 303）。
 */
async function loadApp() {
  gate.classList.add('show');
  gateInfo.textContent = '正在握手…';

  const b = bridge();
  if (!b) { gate.classList.add('show'); gateInfo.textContent = '宿主桥不可用（请从桌面伴生程序打开小窗）'; return; }
  const st = await b.probe();
  if (!st.authed) {
    statusDot.classList.add('show');
    statusDot.classList.remove('ok');
    statusDot.title = '未连接';
    gate.classList.add('show');
    const why = st.reason ? `（${st.reason}）` : '';
    gateInfo.textContent = `握手未完成 ${why}。请确认 DSH 正在运行。`;
    return;
  }

  statusDot.classList.remove('show');
  gate.classList.remove('show');
  // 带 ?dsh-mini=1 加载：插件侧据此切紧凑视图（对齐参考实现用 URL 判据切小窗）。
  view.src = `${ORIGIN}/?${MINI_PARAM}`;
  loaded = true;
}

document.getElementById('retry').addEventListener('click', loadApp);

// webview 加载成功后收起兜底页，并同步顶栏的**动态**控件
view.addEventListener('did-finish-load', async () => {
  gate.classList.remove('show');
  // ★ 缩放要在**多个时机**反复压，不能只压一次。
  //
  // 实测（evidence/batch12-scale.log）：单次 applyZoom 之后，guest 视口仍是
  // **473×655**（= 520 / 1.1），说明 Chromium 的 per-origin 缩放表
  // 是在导航**完成之后**才应用到页面上的 —— 早压会被它盖回去。
  // 故：立即压一次 + 三段延迟重试。
  applyZoom();
  setTimeout(enforceZoom, 300);
  setTimeout(enforceZoom, 1200);
  setTimeout(enforceZoom, 2500);
  syncTopbarToCard();
  const label = await readModelLabel();
  const t4 = document.getElementById('t4');
  if (label) {
    document.getElementById('t4-label').textContent = label;
    t4.hidden = false;
  } else {
    t4.hidden = true;          // 读不到就隐藏，不编造
  }
});

// webview 加载失败时回落到握手页（-3 = ABORTED，属正常中断，忽略）
view.addEventListener('did-fail-load', (e) => {
  if (e.errorCode === -3) return;
  if (!loaded) return;
  gate.classList.add('show');
  gateInfo.textContent = `加载失败：${e.errorDescription || e.errorCode}`;
});

/**
 * 顶层初始化。
 *
 * ⚠️ 本文件是**普通脚本**（`<script src>`，非 `type="module"`），
 * 因此 **顶层 `await` 是非法的** —— 写下去会让整个脚本解析失败
 * （`Uncaught SyntaxError: await is only valid in async functions and the
 * top level bodies of modules`），后果是 loadApp() 根本不执行、小窗永远空白。
 * 这是实测踩到的坑：静态语法检查（--check）在 .cjs 语境下不报，
 * 只有真跑浏览器才暴露。所以初始化一律走 async 包装函数。
 */
async function init() {
  // 读初始置顶状态（IPC 不可用也不得让初始化中断）
  try {
    const b = bridge();
    if (!b) throw new Error('no-bridge');
    const s = await b.getState();
    pinned = !!s.pinned;
    const t2 = document.getElementById('t2');
    setActive(t2, pinned);                       // ★ 用 setActive 统一写 class + aria-pressed
    t2.title = pinned ? '已置顶（点击取消）' : '置顶';
  } catch (err) {
    console.warn('[panel] getState 不可用，沿用默认值', err);
  }
  // ★ 恢复上次的界面缩放（用户偏好，存 localStorage）
  try {
    const saved = parseFloat(localStorage.getItem(ZOOM_KEY) || '');
    if (Number.isFinite(saved)) {
      const i = ZOOM_STEPS.indexOf(saved);
      if (i >= 0) zoomIdx = i;
    }
  } catch { /* 忽略 */ }
  applyZoom();
  await loadApp();
}

init();
