<div align="center">

# @a9i5k4/dsh-mini-window

**A compact mini-window mode for DeepSeek Harness (DSH).**
**给 DeepSeek Harness（DSH）的小窗模式插件。**

`?dsh-mini=1` — compact single-column conversation view.
`?dsh-mini=1` —— 紧凑单栏对话视图。

**Pure client plugin · zero runtime dependencies · no build step · zero impact when off.**
**纯客户端插件 · 零运行时依赖 · 免构建 · 不带参数时对主界面零影响。**

[English](#english) · [中文](#中文)

</div>

---

## English

### What it is

Open the DSH GUI with `?dsh-mini=1` and the three-column layout collapses into a compact
single-column view styled as a floating card.

This package is **the plugin only**. The optional standalone mini-window process
(floating ball + frameless window) lives in `companion/` of the GitHub repository and is
**not published to npm** — it depends on Electron and runs as a separate process, which is
outside the DSH plugin contract.

### Features

| Feature | Description |
| --- | --- |
| **Mini-window mode** | Open `/?dsh-mini=1` for a compact single-column view |
| **Top-bar controls** | Minimize / pin-on-top / sidebar toggle / compact float / more menu (80%–150% UI zoom) |
| **Does not fight the official layout** | DSH is already responsive at narrow viewports; this plugin deliberately does not reimplement it |
| **Verifiable zero-impact** | With no `?dsh-mini=1` every rule is inert |

### Install

```bash
# as a DSH plugin (recommended)
dsh plugin --profile <your-profile> add @a9i5k4/dsh-mini-window

# or with pnpm directly
pnpm add @a9i5k4/dsh-mini-window
```

Restart the DSH host after installing. Then open:

```
http://127.0.0.1:19387/?dsh-mini=1
```

- **With** `?dsh-mini=1` → mini-window mode
- **Without** → official three-column layout, zero impact

### What it changes

In mini-window mode:

| Element | Specification |
| --- | --- |
| Canvas | Transparent (shows the window background) |
| Content card | 100% of the window, 20px radius, `#1A1A1A` |
| Top bar | 55px, drawn by the host (minimize / pin / sidebar / compact / more) |
| Composer | Bottom-docked, 16px radius, `#232528`, 16px from card sides, 17px from bottom |
| Conversation header | Yields 55px so the official tab row is not covered |

The top bar is drawn by the host side (`companion/`); this plugin handles the rest of the layout.

### Design decisions

**1. No custom responsive CSS**

DSH's front end is already responsive. Measured: at narrow viewports the official UI collapses
the sidebar into an overlay and gives the conversation full width (`elementFromPoint` hit the
sidebar **0/9** times across the left strip). A second set of collapse rules would only fight
the official mechanism — so it is deliberately not done.

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

### Development

```bash
# Runtime guard: actually executes the factory and verifies DSH can load the plugin
node tests/smoke/client-factory-guard.cjs

# Syntax check
node --check lib/client.js
```

When installed as a local link (`dsh plugin add "link:<path>/plugin"`), a **page refresh** is
enough — no host restart.

### Compatibility

- **Platform**: `web` (DSH desktop and web share the same front end)
- **Peer dependency**: `@deepseek-ai/cordis`
- **No third-party plugins required** — self-contained, loads in any DSH environment

### License

MIT

---

## 中文

### 这是什么

用 `?dsh-mini=1` 打开 DSH 界面，三栏布局会收成一个紧凑的单栏视图，外观是一张悬浮卡片。

本包**只含插件本体**。可选的独立小窗进程（悬浮球 + 无边框浮窗）在 GitHub 仓库的
`companion/` 目录，**不随 npm 包发布** —— 它依赖 Electron 且是独立进程，
不属于 DSH 插件契约的一部分。

### 特性

| 能力 | 说明 |
| --- | --- |
| **小窗模式** | 访问 `/?dsh-mini=1` 进入紧凑单栏视图 |
| **顶栏控件** | 最小化 / 置顶 / 侧栏开关 / 紧凑浮窗 / 更多菜单（80%–150% 界面缩放） |
| **不抢官方布局** | 窄视口下 DSH 官方已是响应式；本插件**刻意不重复实现** |
| **可验证的零影响** | 不带 `?dsh-mini=1` 时所有规则都不生效 |

### 安装

```bash
# 作为 DSH 插件安装（推荐）
dsh plugin --profile <你的 profile> add @a9i5k4/dsh-mini-window

# 或直接用 pnpm 装
pnpm add @a9i5k4/dsh-mini-window
```

安装后**需要重启 DSH 宿主**才生效。然后打开：

```
http://127.0.0.1:19387/?dsh-mini=1
```

- **带** `?dsh-mini=1` → 小窗模式
- **不带** → 保持官方三栏布局，零影响

### 它改了什么

小窗模式下：

| 元素 | 规格 |
| --- | --- |
| 画布 | 透明（透出窗口底色） |
| 内容卡片 | 占满窗口，圆角 20px，底色 `#1A1A1A` |
| 顶栏 | 55px，由宿主侧自绘（最小化 / 置顶 / 侧栏 / 紧凑浮窗 / 更多） |
| 输入卡 | 贴底，圆角 16px，底色 `#232528`，距卡片左右 16 / 距底 17 |
| 对话头 | 让位 55px，避免盖住官方页签行 |

顶栏由宿主侧（`companion/`）绘制；插件侧负责其余全部版面。

### 设计取舍

**1. 不用自己写响应式 CSS**

DSH 官方前端**自带响应式**。实测：窄视口下官方已把侧栏折叠成浮层、对话区满宽
（`elementFromPoint` 左侧窄带 9 个采样点 **0/9 命中侧栏**）。再叠一套收缩 CSS
只会与官方机制互相覆盖，因此**明确不做**。

**2. 全部规则挂在 `html[data-dsh-mini]` 下**

不带参数时该属性不存在 ⇒ **零生效**。这让「零影响」这句话**可验证**：
去掉参数，主界面必须与未安装时完全一致。

**3. 规格常量单一真相源**

`lib/mini-spec.cjs` 集中定义几何与配色，样式表与应用侧共用同一份，
避免同一数值在多处各写一遍而漂移。

**4. 免构建**

`lib/client.js` 是手写 classic script，经官方 `__ModuleLoader__.load({ id, factory })` 注册。
改完刷新页面即可，不需要打包步骤。

### 开发

```bash
# 运行时守卫：真执行 factory，验证插件能被 DSH 正确加载
node tests/smoke/client-factory-guard.cjs

# 语法检查
node --check lib/client.js
```

以本地链接方式安装时（`dsh plugin add "link:<路径>/plugin"`），改完**刷新页面**即生效，无需重启宿主。

### 兼容性

- **平台**：`web`（DSH 桌面端与 Web 端共用同一前端）
- **peer 依赖**：`@deepseek-ai/cordis`
- **不依赖任何第三方生态插件** —— 交付物自持，任何 DSH 环境都能加载

### License

MIT
