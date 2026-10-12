<div align="center">

# @a9i5k4/dsh-mini-window

**A mini-window mode for DeepSeek Harness (DSH) — install it and a floating ball pops out a real, always-on-top browser window.**
**给 DeepSeek Harness（DSH）的小窗模式插件 —— 装上就有一个悬浮球，点一下弹出真正的置顶浏览器小窗。**

**Zero download · no Electron · no third-party plugins · zero impact when off.**
**零额外下载 · 不需要 Electron · 不依赖任何第三方插件 · 不带参数时对主界面零影响。**

[English](#english) · [中文](#中文)

</div>

---

## English

### What it does

Install the plugin, and a **floating ball** appears in the DSH page. Click it and DSH opens in a
**separate, always-on-top browser window** at 520×720 — a real OS window you can move, resize,
and pin over other apps.

It uses **the browser you already have** (Chrome, falling back to Edge). Nothing is downloaded
beyond this package.

### What you get after installing

| | |
| --- | --- |
| **Floating ball** | Appears automatically in the DSH page (draggable, snaps to the nearest edge, remembers its position) |
| **Click the ball** | Opens a **520×720 always-on-top browser window** with the DSH mini layout |
| **Extra download** | **0 bytes** — it drives Chrome/Edge via `--app=`, no Electron runtime |
| **Requirements** | A DSH profile, and **Chrome or Edge installed** |
| **Not included** | Tray icon. If you close the mini window, click the ball again to reopen |

### Features

| Feature | Description |
| --- | --- |
| **Standalone mini window** | A real browser window in **app mode**: no address bar, no tab strip, exactly 520×720 |
| **Pin on top** | Toggle always-on-top (`SetWindowPos`) — click the pin in the top bar |
| **Mini-window mode** | The same layout is also reachable in-page: open `/?dsh-mini=1` |
| **Top-bar controls** | Minimize / pin on top / sidebar toggle / compact float / more menu (80%–150% UI zoom) |
| **Doesn't fight the official layout** | DSH is already responsive at narrow viewports; this plugin deliberately does not reimplement it |
| **Verifiable zero-impact** | Without `?dsh-mini=1` **none of the mini CSS applies** |

### Install

```bash
# as a DSH plugin (recommended)
dsh plugin --profile <your-profile> add @a9i5k4/dsh-mini-window

# or with pnpm directly
pnpm add @a9i5k4/dsh-mini-window
```

**Restart the DSH host** after installing (the plugin roster is assembled at startup).

Then either:

- **Click the floating ball** in the page → pop out the 520×720 always-on-top window, or
- open `http://127.0.0.1:19387/?dsh-mini=1` directly for the in-page mini layout.

Without `?dsh-mini=1` the official three-column layout is untouched.

### Requirements

- **Chrome or Edge must be installed.** Chrome is preferred; Edge is used as a fallback.
  If neither is found the plugin reports an explicit error instead of silently doing nothing.
- Override the browser path if needed:

  ```powershell
  $env:DSH_MINI_BROWSER = "D:\path\to\chrome.exe"
  ```

  If `DSH_MINI_BROWSER` is set but points to a missing file, the plugin **fails explicitly**
  rather than falling back (so a misconfiguration is never silently ignored).

### What it changes

In mini-window mode:

| Element | Specification |
| --- | --- |
| Window (client area) | **520×720** — corrected after launch, DPI-independent |
| Canvas | Transparent (shows the window background) |
| Content card | 100% of the window, 20px radius, `#1A1A1A` |
| Top bar | 55px (minimize / pin / sidebar / compact / more) |
| Composer | Bottom-docked, 16px radius, `#232528`, 16px from card sides, 17px from bottom |
| Conversation header | Uses the **native** DSH padding — the plugin no longer adds any |

### Design decisions

**1. The browser, not Electron**

The original design shipped a separate Electron process. That costs **~235 MB of downloads**
and is not part of the DSH plugin contract. Since a browser window is just an OS window, the
plugin drives **Chrome/Edge in app mode** instead:

```
chrome.exe --app=<handoff-url> --window-size=520,720 --user-data-dir=<isolated profile>
```

- App mode gives an independent window **with no address bar**.
- The plugin runs a one-shot loopback service that sets a session cookie and redirects to DSH,
  so the mini window starts already authenticated.
- Cookies **ignore the port**, so the handoff service and DSH can use different ports.
- The isolated profile lives under `~/.dsh/dsh-mini-window-browser` — **your own browser
  profile is never touched.**

**Trade-off, stated honestly:** app mode keeps the **system title bar** (unlike Electron's
`frame:false`). Removing it entirely would require shipping Electron again, which contradicts
the zero-download goal.

**2. All rules scoped under `html[data-dsh-mini]`**

Without the parameter the attribute is absent ⇒ **nothing applies**. This makes the
"zero-impact" claim verifiable: remove the parameter and the main UI must look exactly as if
the plugin were not installed.

**3. Single source of truth for the spec**

`lib/mini-spec.cjs` holds geometry and colors; the stylesheet and the app side share one copy,
so a number is never written in two places and left to drift.

**4. No build step**

`lib/client.js` is a hand-written classic script registered via the official
`__ModuleLoader__.load({ id, factory })`. Edit and refresh — no bundling.

**5. Never bubble up**

The host decides whether startup succeeded by whether an entry activated. Any uncaught
exception makes the **entire app fail to open** — so every host-side path is wrapped in
`try/catch` and degrades instead of throwing.

### Development

```bash
# Runtime guard: actually executes the factory and verifies DSH can load the plugin
node tests/smoke/client-factory-guard.cjs

# Syntax check
node --check lib/client.js
```

When installed as a local link (`dsh plugin add "link:<path>/plugin"`), a **page refresh** is
enough for client changes — but **host-side** changes (`lib/index.js`, `lib/host-routes.js`,
`lib/browser-window.js`) require a host restart.

### Compatibility

- **Platform**: `web` (DSH desktop and web share the same front end)
- **Browser**: Chrome preferred, Edge as fallback
- **Peer dependency**: `@deepseek-ai/cordis`
- **No third-party plugins required** — self-contained, loads in any DSH environment
- **Runtime dependencies**: none (Node built-ins only)

### License

MIT

---

## 中文

### 这是什么

装上插件后，DSH 页面里会出现一个**悬浮球**。点它，DSH 就会在一个**独立的、可置顶的浏览器窗口**里
打开，尺寸 520×720 —— 是一个真正的操作系统窗口，可以拖动、可以钉在其他应用最上层。

它用的是**你已经装好的浏览器**（优先 Chrome，退而用 Edge），除了这个包本身**不下载任何东西**。

### 装完你会看到什么

| | |
| --- | --- |
| **悬浮球** | 自动出现在 DSH 页面里（可拖动、松手吸附到最近的边、记住位置） |
| **点一下球** | 弹出 **520×720 的置顶浏览器小窗**，里面是 DSH 的小窗版面 |
| **额外下载** | **0 字节** —— 它用 `--app=` 驱动 Chrome/Edge，不装 Electron 运行时 |
| **前提** | 一个 DSH profile，以及**装了 Chrome 或 Edge** |
| **不含** | 托盘图标。小窗关掉后再点球即可重开 |

### 特性

| 能力 | 说明 |
| --- | --- |
| **独立小窗** | 真正的浏览器**应用模式**窗口：无地址栏、无标签栏，尺寸恰好 520×720 |
| **置顶** | 顶栏的图钉可切换「钉在最上层」（`SetWindowPos`） |
| **小窗模式** | 同一套版面也能在页面内触发：打开 `/?dsh-mini=1` |
| **顶栏控件** | 最小化 / 置顶 / 侧栏开关 / 紧凑浮窗 / 更多菜单（80%–150% 界面缩放） |
| **不抢官方布局** | 窄视口下 DSH 官方已是响应式；本插件**刻意不重复实现** |
| **可验证的零影响** | 不带 `?dsh-mini=1` 时小窗相关规则**一条都不生效** |

### 安装

```bash
# 作为 DSH 插件安装（推荐）
dsh plugin --profile <你的 profile> add @a9i5k4/dsh-mini-window

# 或直接用 pnpm 装
pnpm add @a9i5k4/dsh-mini-window
```

安装后**需要重启 DSH 宿主**（插件清单在启动时装配）。

然后二选一：

- **点页面里的悬浮球** → 弹出 520×720 置顶小窗；
- 或直接打开 `http://127.0.0.1:19387/?dsh-mini=1` 用页面内的小窗版面。

不带 `?dsh-mini=1` 时，官方三栏布局完全不受影响。

### 前提条件

- **必须装了 Chrome 或 Edge。** 优先 Chrome，找不到才退 Edge。
  两个都没有时插件会**明确报错**，而不是静默什么都不做。
- 需要时可覆盖浏览器路径：

  ```powershell
  $env:DSH_MINI_BROWSER = "D:\路径\到\chrome.exe"
  ```

  如果 `DSH_MINI_BROWSER` 指向的文件不存在，插件会**明确失败**而不是回退到默认浏览器
  （避免配置写错却被静默忽略）。

### 它改了什么

小窗模式下：

| 元素 | 规格 |
| --- | --- |
| 窗口（客户区） | **520×720** —— 启动后按实测差值校正，**与 DPI 无关** |
| 画布 | 透明（透出窗口底色） |
| 内容卡片 | 占满窗口，圆角 20px，底色 `#1A1A1A` |
| 顶栏 | 55px（最小化 / 置顶 / 侧栏 / 紧凑浮窗 / 更多） |
| 输入卡 | 贴底，圆角 16px，底色 `#232528`，距卡片左右 16 / 距底 17 |
| 对话头 | 使用 DSH **原生**内边距 —— 插件**不再**额外加让位 |

### 设计取舍

**1. 用浏览器，不用 Electron**

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

**2. 全部规则挂在 `html[data-dsh-mini]` 下**

不带参数时该属性不存在 ⇒ **零生效**。这让「零影响」这句话**可验证**：
去掉参数，主界面必须与未安装时完全一致。

**3. 规格常量单一真相源**

`lib/mini-spec.cjs` 集中定义几何与配色，样式表与应用侧共用同一份，
避免同一数值在多处各写一遍而漂移。

**4. 免构建**

`lib/client.js` 是手写 classic script，经官方 `__ModuleLoader__.load({ id, factory })` 注册。
改完刷新页面即可，不需要打包步骤。

**5. 绝不冒泡**

宿主以「entry 是否 activate」判定启动成败。任何未捕获异常都会导致
**整个应用打不开** —— 因此宿主侧每条路径都有 `try/catch` 兜底，宁可降级也不抛。

### 开发

```bash
# 运行时守卫：真执行 factory，验证插件能被 DSH 正确加载
node tests/smoke/client-factory-guard.cjs

# 语法检查
node --check lib/client.js
```

以本地链接方式安装时（`dsh plugin add "link:<路径>/plugin"`），**前端**改动刷新页面即生效；
但 **host 侧**改动（`lib/index.js`、`lib/host-routes.js`、`lib/browser-window.js`）需要重启宿主。

### 兼容性

- **平台**：`web`（DSH 桌面端与 Web 端共用同一前端）
- **浏览器**：优先 Chrome，退 Edge
- **peer 依赖**：`@deepseek-ai/cordis`
- **不依赖任何第三方生态插件** —— 交付物自持，任何 DSH 环境都能加载
- **运行时依赖**：无（只用 Node 内置模块）

### License

MIT
