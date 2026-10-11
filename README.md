<div align="center">

# dsh-mini-window

**A compact mini-window mode for DeepSeek Harness (DSH).**
**给 DeepSeek Harness（DSH）的小窗模式插件。**

`?dsh-mini=1` — compact single-column conversation view, plus an optional standalone mini-window process.
`?dsh-mini=1` —— 紧凑单栏对话视图，另附可选的独立小窗进程。

**Pure client plugin · zero runtime dependencies · no build step · zero impact when off.**
**纯客户端插件 · 零运行时依赖 · 免构建 · 不带参数时对主界面零影响。**

[English](#english) · [中文](#中文)

</div>

---

## English

### What it is

`dsh-mini-window` adds a **mini-window mode** to DSH. Open the GUI with `?dsh-mini=1` and the
three-column layout collapses into a compact single-column view, styled as a floating card.

It is a **client-side plugin only** — no host services, no build step, no third-party plugins
required. When the `?dsh-mini=1` parameter is absent, the attribute `html[data-dsh-mini]` never
exists, so **every rule is inert** and the official layout is untouched.

### Features

| Feature | Description |
| --- | --- |
| **Mini-window mode** | Open `/?dsh-mini=1` for a compact single-column view: canvas + rounded card + 55px custom top bar + bottom-docked composer |
| **Top-bar controls** | Minimize / pin-on-top / sidebar toggle / compact float / more menu (includes 80%–150% UI zoom) |
| **Standalone mini window** | Optional. A separate Electron process: floating ball + frameless window, draggable size, remembered position |
| **Does not fight the official layout** | At narrow viewports DSH already collapses the sidebar into an overlay; this plugin **deliberately does not reimplement** responsive behavior |
| **Verifiable zero-impact** | With no `?dsh-mini=1`, all rules are scoped under `html[data-dsh-mini]` and never apply |

### Install

```bash
# npm (recommended)
dsh plugin --profile <your-profile> add @a9i5k4/dsh-mini-window

# or with pnpm directly
pnpm add @a9i5k4/dsh-mini-window

# or from GitHub
dsh plugin --profile <your-profile> add github:Aik358/dsh-mini-window
```

Restart the DSH host after installing. Then open:

```
http://127.0.0.1:19387/?dsh-mini=1
```

- **With** `?dsh-mini=1` → mini-window mode
- **Without** → official three-column layout, zero impact

### Optional: standalone mini window

```bash
cd companion
npm install
npm start
```

You get a **floating ball** (right edge, draggable, snaps to screen edge on release) and a
**frameless mini window** (520×720 content area, always-on-top by default, position remembered).

The window loads the official DSH UI, so the conversation area, composer and Markdown rendering
are all the official implementation.

> Requires Node.js and a installed DSH. `companion/` depends on `electron` only.

### Design decisions

**1. Why not write custom responsive CSS**

DSH's front end is already responsive. Measured:

| Viewport width | Sidebar | Conversation |
| --- | --- | --- |
| ≥1024 | 280px expanded | @x=280 |
| 920–760 | auto-collapsed to 56px rail | @x=56 |
| ≤760 | overlay, `pointer-events:none` | full width @x=0 |

`elementFromPoint` hit the sidebar **0/9** times across the left strip — the official UI already
gives the conversation full width. A second set of collapse rules would only fight the official
mechanism, producing random symptoms. So it is deliberately not done.

**2. All rules scoped under `html[data-dsh-mini]`**

Without the parameter the attribute is absent ⇒ **nothing applies**. This is what makes the
"zero-impact" claim verifiable rather than aspirational.

**3. Single source of truth for the spec**

`plugin/lib/mini-spec.cjs` holds geometry and colors (card 400×600, top bar 55, composer 98,
`#1A1A1A` / `#232528`, …). The stylesheet and the app side share one copy, so a number is never
written in two places and left to drift.

**4. No build step**

`lib/client.js` is a hand-written classic script registered via the official
`__ModuleLoader__.load({ id, factory })`. Verified against the real bundle — edit and refresh,
no bundling.

### Project layout

```
plugin/                       ← the publishable DSH plugin
  package.json                ← dsh.client declaration (platform / inject)
  lib/client.js               ← browser entry (hand-written, no build)
  lib/index.js                ← host entry
  lib/mini-spec.cjs           ← single source of truth for the spec
  cordis.patch.yml            ← host-side mount
  tests/smoke/                ← runtime guard

companion/                    ← optional standalone mini window (not published to npm)
  main.js                     ← main process (auth / injection / window / tray)
  preload.js
  lib/ls-seed.js              ← storage mapping
  lib/webview-ls-seed.js      ← webview preload (before page scripts run)
  renderer/                   ← floating ball + window shell
  tests/smoke/                ← storage-mapping and preload feasibility tests
```

> `evidence/` and `probe/` hold local development-time instrumentation. They depend on this
> machine's DSH host and screenshots, are excluded via `.gitignore`, and are not distributed.

### Development

```bash
# Runtime guard: actually executes the factory and verifies DSH can load the plugin
node plugin/tests/smoke/client-factory-guard.cjs

# Syntax check
node --check plugin/lib/client.js
```

When installed as a local link (`link:<path>/plugin`), a **page refresh** is enough — no host restart.

### Compatibility

- **Platform**: `web` (DSH desktop and web share the same front end)
- **Peer dependency**: `@deepseek-ai/cordis`
- **No third-party plugins required** — self-contained, loads in any DSH environment

### License

MIT

---

## 中文

### 这是什么

`dsh-mini-window` 给 DSH 加了一个**小窗模式**。用 `?dsh-mini=1` 打开界面，三栏布局会收成
一个紧凑的单栏视图，外观是一张悬浮卡片。

它**只做客户端插件** —— 不需要宿主服务、不需要构建、不依赖任何第三方插件。
不带 `?dsh-mini=1` 时，`html[data-dsh-mini]` 这个属性根本不存在，所以**所有规则都不生效**，
官方布局完全不受影响。

### 特性

| 能力 | 说明 |
| --- | --- |
| **小窗模式** | 访问 `/?dsh-mini=1` 进入紧凑单栏视图：画布 + 圆角卡片 + 55px 自绘顶栏 + 贴底输入卡 |
| **顶栏控件** | 最小化 / 置顶 / 侧栏开关 / 紧凑浮窗 / 更多菜单（含 80%–150% 界面缩放） |
| **独立小窗进程** | 可选。独立 Electron 进程：悬浮球 + 无边框浮窗，尺寸可拖拽，位置自动记住 |
| **不抢官方布局** | 窄视口下 DSH 官方已把侧栏折叠成浮层；本插件**刻意不重复实现**响应式 |
| **可验证的零影响** | 不带 `?dsh-mini=1` 时所有规则都挂在 `html[data-dsh-mini]` 下，永不生效 |

### 安装

```bash
# npm（推荐）
dsh plugin --profile <你的 profile> add @a9i5k4/dsh-mini-window

# 或直接用 pnpm 装
pnpm add @a9i5k4/dsh-mini-window

# 或从 GitHub
dsh plugin --profile <你的 profile> add github:Aik358/dsh-mini-window
```

安装后**需要重启 DSH 宿主**才生效。然后打开：

```
http://127.0.0.1:19387/?dsh-mini=1
```

- **带** `?dsh-mini=1` → 小窗模式
- **不带** → 保持官方三栏布局，零影响

### 可选：独立小窗进程

```bash
cd companion
npm install
npm start
```

会得到：**悬浮球**（屏幕右侧，可拖动，松手自动吸附边缘）+ **无边框小窗**
（520×720 客户区，默认置顶，位置自动记住）。

小窗加载的就是 DSH 官方界面，所以对话区、输入卡、Markdown 渲染全部复用官方实现。

> 需要本机已安装 Node.js 与 DSH。`companion/` 只依赖 `electron` 一个包。

### 设计取舍

**1. 为什么不用自己写响应式 CSS**

DSH 官方前端**自带响应式**，实测：

| 视口宽 | 侧栏 | 对话区 |
| --- | --- | --- |
| ≥1024 | 280px 展开 | @x=280 |
| 920–760 | 自动折叠成 56px 轨道 | @x=56 |
| ≤760 | 浮层，`pointer-events:none` | 满宽 @x=0 |

`elementFromPoint` 在左侧窄带 9 个采样点 **0/9 命中侧栏** —— 官方已让对话区满宽。
再叠一套收缩 CSS 只会与官方机制互相覆盖（症状随机），因此**明确不做**。

**2. 全部规则挂在 `html[data-dsh-mini]` 下**

不带参数时该属性不存在 ⇒ **零生效**。这是「零影响」这句话**可验证**而不是口号的前提。

**3. 规格常量单一真相源**

`plugin/lib/mini-spec.cjs` 集中定义几何与配色（卡片 400×600、顶栏 55、输入卡 98、
`#1A1A1A` / `#232528` 等），样式表与应用侧共用同一份，避免同一数值在多处各写一遍而漂移。

**4. 免构建**

`lib/client.js` 是手写 classic script，经官方 `__ModuleLoader__.load({ id, factory })` 注册。
已用真实 bundle 验证 —— 改完刷新页面即可，不需要打包步骤。

### 目录结构

```
plugin/                       ← 要发布的 DSH 插件
  package.json                ← dsh.client 声明（platform / inject）
  lib/client.js               ← 浏览器侧入口（手写，免构建）
  lib/index.js                ← host 侧入口
  lib/mini-spec.cjs           ← 规格常量单一真相源
  cordis.patch.yml            ← host 侧挂载
  tests/smoke/                ← 运行时守卫

companion/                    ← 可选的独立小窗进程（不随 npm 包发布）
  main.js                     ← 主进程（认证 / 注入 / 窗口 / 托盘）
  preload.js
  lib/ls-seed.js              ← 存储映射
  lib/webview-ls-seed.js      ← webview preload（页面脚本运行前注入）
  renderer/                   ← 悬浮球 + 小窗外壳
  tests/smoke/                ← 存储映射与 preload 可行性测试
```

> `evidence/` 与 `probe/` 是**本机开发期**的实测数据与工具，依赖本机 DSH 宿主与截图，
> 已通过 `.gitignore` 排除，不随仓库分发。

### 开发

```bash
# 运行时守卫：真执行 factory，验证插件能被 DSH 正确加载
node plugin/tests/smoke/client-factory-guard.cjs

# 语法检查
node --check plugin/lib/client.js
```

以本地链接方式安装时（`link:<path>/plugin`），改完**刷新页面**即可生效，无需重启宿主。

### 兼容性

- **平台**：`web`（DSH 桌面端与 Web 端共用同一前端）
- **peer 依赖**：`@deepseek-ai/cordis`
- **不依赖任何第三方生态插件** —— 交付物自持，任何 DSH 环境都能加载

### License

MIT
