<div align="center">

# dsh-mini-window

**A mini-window mode for DeepSeek Harness (DSH) — install it and a floating ball pops out a real, always-on-top browser window.**
**给 DeepSeek Harness（DSH）的小窗模式插件 —— 装上就有一个悬浮球，点一下弹出真正的置顶浏览器小窗。**

**Zero download · no Electron · no third-party plugins · zero impact when off.**
**零额外下载 · 不需要 Electron · 不依赖任何第三方插件 · 不带参数时对主界面零影响。**

[English](#english) · [中文](#中文)

</div>

---

## English

### What it is

`dsh-mini-window` gives DSH a **mini window**. Install the plugin and a **floating ball** appears
in the page; click it and DSH opens in a **separate, always-on-top browser window** at 520×720 —
a real OS window you can move and pin over other apps.

The same layout is also reachable in-page with `?dsh-mini=1`, where the three-column UI collapses
into a compact single-column view styled as a floating card.

When `?dsh-mini=1` is absent, the attribute `html[data-dsh-mini]` never exists, so **every rule
is inert** and the official layout is untouched.

### Features

| Feature | Description |
| --- | --- |
| **Standalone mini window** | A real browser window in **app mode**: no address bar, no tab strip, exactly 520×720. Driven via `--app=`, so **nothing is downloaded** |
| **Pin on top** | Toggle always-on-top from the top bar — a real Win32 `SetWindowPos`, with the state read back to confirm |
| **Floating ball** | Appears automatically (draggable, snaps to the nearest edge, remembers its position). **Pure DOM.** |
| **Mini-window mode** | Open `/?dsh-mini=1` for the same compact single-column layout in-page |
| **Top-bar controls** | Minimize / pin-on-top / sidebar toggle / compact float / more menu (includes 80%–150% UI zoom) |
| **Does not fight the official layout** | At narrow viewports DSH already collapses the sidebar into an overlay; this plugin **deliberately does not reimplement** responsive behavior |
| **Verifiable zero-impact** | With no `?dsh-mini=1` **none of the mini CSS applies** |

### What you get after installing

| | |
| --- | --- |
| `dsh plugin --profile <p> add @a9i5k4/dsh-mini-window` | Floating ball **+ 520×720 always-on-top browser mini window** |
| Extra download | **0 bytes** — it drives the Chrome/Edge you already have |
| Requirement | **Chrome or Edge installed** (Chrome preferred, Edge as fallback) |
| Not included | Tray icon. Close the mini window and click the ball again to reopen |

### Install

```bash
# npm (recommended)
dsh plugin --profile <your-profile> add @a9i5k4/dsh-mini-window

# or with pnpm directly
pnpm add @a9i5k4/dsh-mini-window

# or from GitHub
dsh plugin --profile <your-profile> add github:Aik358/dsh-mini-window
```

**Restart the DSH host** after installing (the plugin roster is assembled at startup).

Then either:

- **Click the floating ball** in the page → the 520×720 always-on-top window pops out, or
- open `http://127.0.0.1:19387/?dsh-mini=1` for the in-page mini layout.

- **With** `?dsh-mini=1` → mini-window mode
- **Without** → official three-column layout, zero impact

### Requirements

Chrome or Edge must be installed. If neither is found the plugin reports an **explicit error**
instead of silently doing nothing. Override the path if needed:

```powershell
$env:DSH_MINI_BROWSER = "D:\path\to\chrome.exe"
```

If `DSH_MINI_BROWSER` is set but points to a missing file, the plugin **fails explicitly** rather
than falling back to the default browser, so a misconfiguration is never silently ignored.

### Design decisions

**1. Why the browser, not Electron**

The earliest design shipped a separate Electron process. That costs **~235 MB of downloads** and
is not part of the DSH plugin contract. Since a browser window is just an OS window, the plugin
instead drives **Chrome/Edge in app mode**:

```
chrome.exe --app=<handoff-url> --window-size=520,720 --user-data-dir=<isolated profile>
```

- App mode gives an independent window **with no address bar**.
- The plugin runs a one-shot loopback service that sets a session cookie and redirects to DSH,
  so the mini window starts **already authenticated**.
- Cookies **ignore the port**, so the handoff service and DSH can use different ports.
- The isolated profile lives under `~/.dsh/dsh-mini-window-browser` — **your own browser profile
  is never touched.**

**Trade-off, stated honestly:** app mode keeps the **system title bar** (unlike Electron's
`frame:false`). Removing it entirely would mean shipping Electron again, contradicting the
zero-download goal.

**2. Why not write custom responsive CSS**

DSH's front end is already responsive. Measured:

| Viewport width | Sidebar | Conversation |
| --- | --- | --- |
| ≥1024 | 280px expanded | @x=280 |
| 920–760 | auto-collapsed to 56px rail | @x=56 |
| ≤760 | overlay, `pointer-events:none` | full width @x=0 |

`elementFromPoint` hit the sidebar **0/9** times across the left strip — the official UI already
gives the conversation full width. A second set of collapse rules would only fight the official
mechanism, producing random symptoms. So it is deliberately not done.

**3. All rules scoped under `html[data-dsh-mini]`**

Without the parameter the attribute is absent ⇒ **nothing applies**. This is what makes the
"zero-impact" claim verifiable rather than aspirational.

**4. Single source of truth for the spec**

`plugin/lib/mini-spec.cjs` holds geometry and colors. The stylesheet and the app side share one
copy, so a number is never written in two places and left to drift.

**5. No build step**

`lib/client.js` is a hand-written classic script registered via the official
`__ModuleLoader__.load({ id, factory })`. Verified against the real bundle — edit and refresh,
no bundling.

**6. Never bubble up**

The host decides whether startup succeeded by whether an entry activated. Any uncaught exception
makes the **entire app fail to open** — so every host-side path is wrapped in `try/catch` and
degrades instead of throwing.

**7. Verify window operations by reading state back**

`SetWindowPos` is asynchronous across processes: reading `WS_EX_TOPMOST` immediately after
setting it returns the **old** value. The plugin waits before reading back, and iterates **all**
candidate windows rather than guessing one — otherwise a stale read looks exactly like a
"the pin button does nothing" bug.

### Project layout

```
plugin/                       ← the publishable DSH plugin
  package.json                ← dsh.client declaration (platform / inject)
  lib/client.js               ← browser entry (hand-written, no build)
  lib/index.js                ← host entry
  lib/host-routes.js          ← host routes (/dsh-mini-window/*)
  lib/browser-window.js       ← browser app-mode window (launch / fit / pin)
  lib/host-window.js          ← Electron window path (fallback)
  lib/ls-extract.cjs          ← zero-dependency Chromium localStorage extractor
  lib/mini-spec.cjs           ← single source of truth for the spec
  cordis.patch.yml            ← host-side mount
  tests/smoke/                ← runtime guard

companion/                    ← legacy standalone Electron mini window (not published to npm)
  main.js                     ← main process (auth / injection / window / tray)
  preload.js
  renderer/                   ← floating ball + window shell
```

> `companion/` is the **earlier** Electron approach. The shipped mini window no longer needs it;
> it is kept in the repository for reference and costs ~151 MB if you build it.
>
> `evidence/` and `probe/` hold local development-time instrumentation. They depend on this
> machine's DSH host and screenshots, are excluded via `.gitignore`, and are not distributed.

### Development

```bash
# Runtime guard: actually executes the factory and verifies DSH can load the plugin
node plugin/tests/smoke/client-factory-guard.cjs

# Syntax check
node --check plugin/lib/client.js
```

When installed as a local link (`link:<path>/plugin`), a **page refresh** is enough for client
changes — but **host-side** changes (`lib/index.js`, `lib/host-routes.js`, `lib/browser-window.js`)
require a host restart.

### Compatibility

- **Platform**: `web` (DSH desktop and web share the same front end)
- **Browser**: Chrome preferred, Edge as fallback
- **Peer dependency**: `@deepseek-ai/cordis`
- **Runtime dependencies**: none (Node built-ins only)
- **No third-party plugins required** — self-contained, loads in any DSH environment

### License

MIT

---

## 中文

### 这是什么

`dsh-mini-window` 给 DSH 加了一个**小窗**。装上插件后，页面里会出现一个**悬浮球**；
点它，DSH 就会在一个**独立的、可置顶的浏览器窗口**里打开，尺寸 520×720 ——
是一个真正的操作系统窗口，可以拖动，也可以钉在其他应用最上层。

同一套版面也能在页面内触发：带 `?dsh-mini=1` 打开时，三栏布局会收成一个紧凑的单栏视图，
外观是一张悬浮卡片。

不带 `?dsh-mini=1` 时，`html[data-dsh-mini]` 这个属性根本不存在，所以**所有规则都不生效**，
官方布局完全不受影响。

### 特性

| 能力 | 说明 |
| --- | --- |
| **独立小窗** | 真正的浏览器**应用模式**窗口：无地址栏、无标签栏，尺寸恰好 520×720。用 `--app=` 驱动，**不下载任何东西** |
| **置顶** | 顶栏的图钉可切换「钉在最上层」—— 真正的 Win32 `SetWindowPos`，**并回读状态确认** |
| **悬浮球** | 自动出现（可拖动、松手吸附最近的边、记住位置）。**纯 DOM。** |
| **小窗模式** | 打开 `/?dsh-mini=1` 在页面内得到同一套紧凑单栏版面 |
| **顶栏控件** | 最小化 / 置顶 / 侧栏开关 / 紧凑浮窗 / 更多菜单（含 80%–150% 界面缩放） |
| **不抢官方布局** | 窄视口下 DSH 官方已把侧栏折叠成浮层；本插件**刻意不重复实现**响应式 |
| **可验证的零影响** | 不带 `?dsh-mini=1` 时小窗相关规则**一条都不生效** |

### 装完你会得到什么

| | |
| --- | --- |
| `dsh plugin --profile <p> add @a9i5k4/dsh-mini-window` | 悬浮球 **+ 520×720 可置顶的浏览器小窗** |
| 额外下载 | **0 字节** —— 它驱动你已经装好的 Chrome / Edge |
| 前提 | **装了 Chrome 或 Edge**（优先 Chrome，退 Edge） |
| 不含 | 托盘图标。小窗关掉后再点球即可重开 |

### 安装

```bash
# npm（推荐）
dsh plugin --profile <你的 profile> add @a9i5k4/dsh-mini-window

# 或直接用 pnpm 装
pnpm add @a9i5k4/dsh-mini-window

# 或从 GitHub
dsh plugin --profile <你的 profile> add github:Aik358/dsh-mini-window
```

安装后**需要重启 DSH 宿主**（插件清单在启动时装配）。

然后二选一：

- **点页面里的悬浮球** → 弹出 520×720 置顶小窗；
- 或打开 `http://127.0.0.1:19387/?dsh-mini=1` 用页面内的小窗版面。

- **带** `?dsh-mini=1` → 小窗模式
- **不带** → 保持官方三栏布局，零影响

### 前提条件

必须装了 Chrome 或 Edge。两个都没有时插件会**明确报错**，而不是静默什么都不做。
需要时可覆盖浏览器路径：

```powershell
$env:DSH_MINI_BROWSER = "D:\路径\到\chrome.exe"
```

如果 `DSH_MINI_BROWSER` 指向的文件不存在，插件会**明确失败**而不是回退到默认浏览器，
避免配置写错却被静默忽略。

### 设计取舍

**1. 为什么用浏览器，不用 Electron**

最早的设计是另起一个 Electron 进程。那要**多下载约 235 MB**，而且不属于 DSH 插件契约。
既然浏览器窗口本来就是普通的系统窗口，插件改为直接驱动 **Chrome/Edge 的应用模式**：

```
chrome.exe --app=<交接地址> --window-size=520,720 --user-data-dir=<独立 profile>
```

- 应用模式给出的是**没有地址栏**的独立窗口。
- 插件临时起一个只监听回环的一次性服务，签发会话 cookie 后跳转到 DSH
  ⇒ 小窗一开出来**就已经是登录态**。
- **cookie 不区分端口**，所以交接服务与 DSH 可以用不同端口。
- 独立 profile 落在 `~/.dsh/dsh-mini-window-browser`，**绝不碰你自己的浏览器数据。**

**说清楚代价**：应用模式**保留系统标题栏**（不像 Electron 的 `frame:false`）。
要彻底去掉它就得重新引入 Electron，与「零下载」的目标冲突。

**2. 为什么不用自己写响应式 CSS**

DSH 官方前端**自带响应式**，实测：

| 视口宽 | 侧栏 | 对话区 |
| --- | --- | --- |
| ≥1024 | 280px 展开 | @x=280 |
| 920–760 | 自动折叠成 56px 轨道 | @x=56 |
| ≤760 | 浮层，`pointer-events:none` | 满宽 @x=0 |

`elementFromPoint` 在左侧窄带 9 个采样点 **0/9 命中侧栏** —— 官方已让对话区满宽。
再叠一套收缩 CSS 只会与官方机制互相覆盖（症状随机），因此**明确不做**。

**3. 全部规则挂在 `html[data-dsh-mini]` 下**

不带参数时该属性不存在 ⇒ **零生效**。这是「零影响」这句话**可验证**而不是口号的前提。

**4. 规格常量单一真相源**

`plugin/lib/mini-spec.cjs` 集中定义几何与配色，样式表与应用侧共用同一份，
避免同一数值在多处各写一遍而漂移。

**5. 免构建**

`lib/client.js` 是手写 classic script，经官方 `__ModuleLoader__.load({ id, factory })` 注册。
已用真实 bundle 验证 —— 改完刷新页面即可，不需要打包步骤。

**6. 绝不冒泡**

宿主以「entry 是否 activate」判定启动成败。任何未捕获异常都会导致**整个应用打不开** ——
因此宿主侧每条路径都有 `try/catch` 兜底，宁可降级也不抛。

**7. 窗口操作必须回读验证**

`SetWindowPos` 是跨进程异步的：设置完**立即**回读 `WS_EX_TOPMOST` 会读到**旧值**。
插件设置后会等一拍再读，并且遍历**全部**候选窗口而不是猜一个 ——
否则「读到旧值」和「图钉点了没反应」在现象上完全一样，无法区分。

### 目录结构

```
plugin/                       ← 要发布的 DSH 插件
  package.json                ← dsh.client 声明（platform / inject）
  lib/client.js               ← 浏览器侧入口（手写，免构建）
  lib/index.js                ← host 侧入口
  lib/host-routes.js          ← host 路由（/dsh-mini-window/*）
  lib/browser-window.js       ← 浏览器应用模式窗口（启动 / 校正尺寸 / 置顶）
  lib/host-window.js          ← Electron 窗口路径（兜底）
  lib/ls-extract.cjs          ← 零依赖的 Chromium localStorage 提取器
  lib/mini-spec.cjs           ← 规格常量单一真相源
  cordis.patch.yml            ← host 侧挂载
  tests/smoke/                ← 运行时守卫

companion/                    ← 早期的独立 Electron 小窗（不随 npm 包发布）
  main.js                     ← 主进程（认证 / 注入 / 窗口 / 托盘）
  preload.js
  renderer/                   ← 悬浮球 + 小窗外壳
```

> `companion/` 是**更早的** Electron 方案。现在发布的小窗已经不需要它，
> 保留在仓库里供参考；自己构建它要花约 151 MB 下载。
>
> `evidence/` 与 `probe/` 是**本机开发期**的实测数据与工具，依赖本机 DSH 宿主与截图，
> 已通过 `.gitignore` 排除，不随仓库分发。

### 开发

```bash
# 运行时守卫：真执行 factory，验证插件能被 DSH 正确加载
node plugin/tests/smoke/client-factory-guard.cjs

# 语法检查
node --check plugin/lib/client.js
```

以本地链接方式安装时（`link:<path>/plugin`），**前端**改动刷新页面即生效；
但 **host 侧**改动（`lib/index.js`、`lib/host-routes.js`、`lib/browser-window.js`）需要重启宿主。

### 兼容性

- **平台**：`web`（DSH 桌面端与 Web 端共用同一前端）
- **浏览器**：优先 Chrome，退 Edge
- **peer 依赖**：`@deepseek-ai/cordis`
- **运行时依赖**：无（只用 Node 内置模块）
- **不依赖任何第三方生态插件** —— 交付物自持，任何 DSH 环境都能加载

### License

MIT
