# 路线重选：把 380MB 的 Electron 方案换掉

> 日期：2026-10-11
> 触发：用户指出「80MB 是不是太多了」+ 提出三个方向：①借 DSH 桌面端自己的 Electron 壳 ②用浏览器做 ③研究浏览器能否置顶
> 性质：**只读调查 + 方案**（本轮未改任何代码）

---

## 0. 先核准体积：用户说少了，实际更多

| 项 | 实测 |
| --- | --- |
| **用户下载量** | **151.0 MB**（`electron-v44.7.0-win32-x64.zip`） |
| **装完占盘** | **380.6 MB** |
| ├ `node_modules` | 380.43 MB |
| ├ ├ `electron` | **368.77 MB** ← 就是它 |
| └ **我们自己的源码** | **0.21 MB** |

**用 0.21 MB 的代码，让用户下 151 MB、占 380 MB。** 用户的判断完全正确。

---

## 1. 用户的三个方向，逐一核实

### 方向 ① 借 DSH 桌面端自己的 Electron 壳 —— **可行，但只解决一半**

**事实**：DSH 桌面壳**就是 Electron**（`G:\dsh_desktop\version` = `44.0.0`）。
Electron 的标准行为是 `electron.exe <app目录>` → 读该目录 `package.json` 的 `main` 启动。
`companion/package.json` 的 `main` = `main.js` ⇒ **理论上可以零下载启动**：

```powershell
& "G:\dsh_desktop\DeepSeek Harness.exe" "E:\dsh-mini-window-lab\companion"
```

**能省掉**：151 MB 下载 + 368 MB 磁盘。

**但两个硬伤**：

| 问题 | 说明 |
| --- | --- |
| **只对「装了桌面端」的用户有效** | 用 `dsh` CLI + 浏览器的用户没有这个 exe ⇒ 还是不通用 |
| **依赖他人的安装路径** | 要去找 `DeepSeek Harness.exe` 在哪（注册表/常见路径），且版本未必兼容；Electron fuse 可能禁止这种用法（需实测） |

⇒ **是好补充，不该是主路线。**

### 方向 ② 用浏览器做 —— **可行，这正是主路线**

DSH 本身就有 **web 形态**（`dsh web`，CLI 起服务；用户提到 3080 端口）。
插件作用于 web 前端 ⇒ **浏览器里天然能跑**，零下载。

### 方向 ③ 浏览器能不能置顶 —— **能，而且有专门的 API** ★

这是本轮最关键的发现。

**`Document Picture-in-Picture API`（文档画中画）**：

| 能力 | 说明 |
| --- | --- |
| 把**任意 DOM** 搬进一个**操作系统级小窗口** | 不限于 `<video>` —— 这是与老视频 PiP 的本质区别 |
| **该窗口 always-on-top** | 系统级置顶，可拖到屏幕任意位置、可缩放 |
| 不依赖 Electron | 纯浏览器 API |
| 门槛 | Chrome 116+ / Electron 30+ |

**本机可用性 —— 两级实测（不是凭版本号推断）**：

**① 二进制符号级**：在本机 DSH 桌面壳的二进制里搜索该 API 的实现符号：

```
documentPictureInPicture         ✓ 找到（偏移 232373664）
requestPictureInPicture          ✓ 找到（偏移 232331848）
pictureInPictureEnabled          ✓ 找到（偏移 229755480）
```

**② 渲染进程运行时级**（`probe/pip-renderer.cjs`，真执行、两种 webPreferences 各测一次）：

```
【默认配置】typeof documentPictureInPicture      = object
            documentPictureInPicture.requestWindow = function   ← 可调用
            isSecureContext                        = true
            Chromium                               = 152.0.7977.130
【隔离配置】typeof                              = object（一致）
★ 结论: 本机 Electron 暴露 Document PiP 且 requestWindow 可调用
```

⇒ **API 已编译进本机 Electron，且在渲染进程里真的可用。**
（本机 Chromium **152**，远高于该 API 的 116 门槛。）

**反面对照（说明为什么必须是这个 API）**：

| 方案 | 能否置顶 |
| --- | --- |
| `window.open()` | ❌ 浏览器**不提供**置顶控制 |
| Window Management API | ❌ 只能读屏幕信息 |
| **Document PiP** | ✅ **能** |

---

## 2. 新方案：三层降级（成本从 0 到 151MB）

| 层 | 做法 | 用户成本 | 置顶？ | 能拖出浏览器？ |
| --- | --- | --- | --- | --- |
| **L1 纯 DOM 悬浮球** | `position:fixed` 的球，点开小窗视图 | **0** | ❌（在页面内） | ❌ |
| **L2 Document PiP 小窗** ★ | 球点一下 → `documentPictureInPicture.requestWindow()` 弹出**真·系统置顶小窗** | **0** | ✅ | ✅ |
| **L3 借桌面壳 / 自带 Electron** | 需要「DSH 关了球还在」等场景 | 0（借壳）或 151MB（自带） | ✅ | ✅ |

**推荐：L1 + L2 为主，L3 降级为可选增强。**

理由：
- **L1+L2 覆盖了用户要的全部**（球、小窗、置顶、可拖出浏览器）且**零下载**；
- L2 是**真·操作系统窗口**，不是模拟 —— 与 Electron 方案体验同级；
- L3 只剩「DSH/浏览器关了球还在」这一个差异，不值得让全体用户付 151MB。

---

## 3. L2 能做什么（对照现状）

| 能力 | Electron 版（现在） | L2 Document PiP |
| --- | --- | --- |
| 真·独立窗口 | ✅ | ✅ |
| 系统置顶 | ✅（`alwaysOnTop`） | ✅（PiP 窗口天然置顶） |
| 拖到屏幕任意位置 | ✅ | ✅（窗口管理器负责） |
| 无边框自绘顶栏 | ✅ | ✅（自己画） |
| 记住位置 | ✅（写 state 文件） | ⚠️ 窗口位置由系统管，**只能记大小** |
| 托盘图标 | ✅ | ❌ 无 |
| DSH 关了还在 | ✅ | ❌（依赖页面存活） |
| 跨平台 | 需各自二进制 | ✅ **全平台**（有 Chromium 即可） |
| 用户下载 | 151 MB | **0** |

**诚实说明代价**：L2 失去「托盘」与「DSH 关了还在」，并**不能记忆窗口位置**（系统管）。
但换来 151MB → 0，且跨平台。

---

## 4. 实施要点（L1 + L2）

### 4.1 悬浮球（L1）

```js
// 与 @linxin666/dsh-desktop-launcher 同构（已实测该插件就是这么做的）
const style = document.createElement('style');
style.textContent = `#dsh-mini-ball{position:fixed;right:20px;bottom:20px;z-index:9999;...}`;
document.head.appendChild(style);
document.body.appendChild(ballEl);
```

- 拖动 + 吸附边缘：直接复用现有 `companion/renderer/ball.js`（本身就是标准 DOM 代码）
- 位置记忆：`localStorage`（已在 DSHM/ArkWeb 侧确认可用；本机 Electron 亦然）

### 4.2 弹出置顶小窗（L2）

```js
const pip = await documentPictureInPicture.requestWindow({ width: 420, height: 640 });
// 把 DSH 的对话区 DOM 搬进去（或直接搬整个 AppFrame 的目标子树）
pip.document.body.append(...myElements);
// 样式需一并复制过去
```

**需要验证的点**（实施时用探针实测，不猜）：
1. PiP 窗口里能否**正常跑 DSH 的 React 组件**（搬 DOM 后事件/状态是否跟随）；
2. 登录态/网络请求在 PiP 窗口里是否可用（同源，应当可用）；
3. 窄宽度（420px）下官方响应式是否给出满宽对话区（本项目已实测 ≤760 会满宽）。

**风险提示**：搬 DOM 到另一个 document 会让 React 的合成事件失效（两个 document）。
**更稳的做法**：PiP 窗口里**加载 DSH 的 URL**（`?dsh-mini=1`），即"开一个小窗，里面是完整应用"，
而不是"把当前页面的 DOM 搬过去"。这样零兼容风险 —— 代价是多一次页面加载。

### 4.3 降级链

```
优先 L2（Document PiP 可用时）
  ↓ 不可用（老浏览器 / API 被禁）
退到 L1（页面内悬浮球 + 小窗视图）
  ↓ 用户还想要桌面常驻
可选装 L3（借桌面壳或自带 Electron）
```

---

## 5. 诚实边界

| 结论 | 证据等级 |
| --- | --- |
| 下载 151MB / 占盘 380.6MB / 源码仅 0.21MB | **实测** |
| DSH 桌面壳是 Electron 44 / Chromium 152 | **实测**（version 文件 + 渲染进程上报 UA） |
| **渲染进程里 Document PiP 可用（requestWindow 是函数）** | **实测**（`probe/pip-renderer.cjs`，两种配置各测一次，exit 0） |
| 二进制内含该 API 实现符号 | **实测**（在 exe 里找到 `documentPictureInPicture`，偏移 232373664） |
| 借壳启动（`DSH.exe <companion目录>`）理论可行 | **推断** —— 未实测（Electron fuse 可能拦，需真跑一次） |
| Document PiP 窗口**系统置顶** | **外部事实**（该 API 的设计用途），**本机未实测弹出窗口**（弹窗需用户同意） |
| L2 能替代 Electron 版全部能力 | **不能** —— 无托盘、DSH 关了即消失、**不能记忆窗口位置** |
| `window.open` 能否置顶 | **确认不能**（浏览器不提供该控制） |
