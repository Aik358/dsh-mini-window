# DSH 小窗模式实现方案

> 依赖：`docs/02-DSH实现方案.md` 的实测结论
> 目标：在 **不修改 DSH 安装目录、不修改现有插件、不重启宿主** 的前提下，让 DSH 拥有与参考实现等价的「小窗」形态

---

## 0. 设计目标（从参考实现实测反推）

| # | 目标 | 参考实现对应证据 |
| --- | --- | --- |
| G1 | 主窗一键变小，位置贴屏幕角落 | 520×720 @(1441,437) |
| G2 | 小窗不进任务栏、不进 ALT+TAB | exStyle `0x00200080` 多出 `WS_EX_TOOLWINDOW` |
| G3 | 可选置顶，浮在别的窗口之上 | 浮动条 exStyle `0x00200088` 含 `WS_EX_TOPMOST` |
| G4 | 无边框 + 自绘控制条（3 个圆点） | `Chrome_WidgetWin_1` + 无系统边框 |
| G5 | 还原后回到原尺寸原位置 | — |
| G6 | 前端切换紧凑布局（不是缩小版放大） | 小窗宽度 = UI 最小可用宽度 |

**非目标**：不做画中画视频窗（参考实现的 `pip_main.exe` 子系统）、不做独立第二窗口。

---

## 1. 三条路线对比

### 路线 A —— 外挂 FFI 窗口控制器（推荐先做）

```
node src/mini-window.cjs mini --apply
  └─ koffi → user32!SetWindowPos / SetWindowLongPtrW
       └─ 直接操作 DSH 主窗 hwnd
```

| 维度 | 评价 |
| --- | --- |
| 侵入性 | **零**。不碰 `app.asar`、不碰 profile、不注册插件 |
| 生效速度 | **即时**。改完立即可见，无需重启宿主 |
| 前提 | 仅需 `koffi`（**DSH 依赖树里本来就有**：`~\.dsh\profiles\node_modules\koffi`，3.1.1） |
| 风险 | 宿主若在之后调用 `setMinimumSize`/`setSize` 会覆盖（实验证明 DSH 只在 `enterWorkspace` 时调，日常不调） |
| 缺点 | 不是"产品功能"，没有 UI 按钮，得手动跑命令 |

**适合**：先验证效果、确认审美与交互是否合意。已在本目录跑通（见 `docs/03` §5）。

### 路线 B —— DSH 插件（产品化）

```
src/dsh-plugin-mini-window/
├─ lib/index.js      host 侧：注册 HTTP 路由 /api/mini-window/{state,mini,restore}
├─ lib/client.js     client 侧：注入悬浮按钮 + 键盘快捷键
└─ package.json      dsh.client.platform = "web"
```

| 维度 | 评价 |
| --- | --- |
| 侵入性 | 低。标准插件安装路径，可随时 `remove` |
| 生效速度 | 需用户手动重启宿主（**硬约束：Agent 不得代为重启**） |
| 前提 | profile 的 `cordis.patch.yml` + node_modules symlink |
| 风险 | 需处理 DSH 客户端 UI 的 DOM 插槽兼容性 |
| 优点 | 有 UI、可持久化设置、能与插件记忆体系联动 |

**适合**：验证通过后正式落地。

### 路线 C —— 改 `app.asar` 主进程

| 维度 | 评价 |
| --- | --- |
| 侵入性 | **高**。改的是应用安装目录 |
| 生效速度 | 需完全重启桌面应用 |
| 风险 | 应用更新会覆盖；asar 重打包易损；禁用第三方插件后的恢复流程会失效 |
| 结论 | **不推荐** |

### 决策

```
先走 A 验证效果  →  效果满意后走 B 产品化  →  永不走 C
```

理由：A 的成本是 10 分钟，B 的成本是半天到一天；先用 A 把"到底要不要小窗、小窗该多大、该贴哪"这几个**审美与交互问题**收敛掉，避免在 B 上返工。

---

## 2. 路线 A：完整实现

代码已落地：`src/mini-window.cjs`（可直接跑）。

### 2.1 核心原理

Electron 窗口在 Win32 层面就是一个带类的顶层窗口。因此有两条互斥的实现路径：

| 路径 | 手段 | 能否保持 Electron 内部状态一致 |
| --- | --- | --- |
| **A1. Win32 直改**（本方案） | `SetWindowPos` / `SetWindowLongPtrW` | ⚠️ Electron 的 `getBounds()` 会读到新值（消息驱动同步），但 `maximize()` 等状态机会略有不一致 |
| **A2. 走 Electron API** | 需在 Electron 进程内执行 `win.setBounds()` | ✅ 完全一致 |

**A1 的可行性判据**：Electron 的窗口几何最终是 `WM_WINDOWPOSCHANGING/CHANGED` 驱动的，用 `SetWindowPos` 改完，Electron 侧监听 `resize`/`move` 的事件**会照常触发**，前端因此能正确响应（这是 G6 成立的前提）。本目录未做 Electron 侧事件验证（需要 devtools），列为待验证项。

### 2.2 关键调用

```js
// 1) 缩小并贴角
SetWindowPos(hwnd, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE);

// 2) 去掉任务栏图标（G2）—— 补 WS_EX_TOOLWINDOW
//    ⚠️ 实测更正：不要写 (ex & ~WS_EX_APPWINDOW)，因为普通主窗本来就没有 APPWINDOW 位，
//    那个按位与是空操作；唯一起作用的是补上 TOOLWINDOW。
const ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW);
SetWindowPos(hwnd, null, 0,0,0,0, SWP_NOMOVE|SWP_NOSIZE|SWP_FRAMECHANGED|SWP_NOACTIVATE); // ← FRAMECHANGED 强制重建非客户区，否则不生效

// 3) 还原：读 mini-state.json 的 before 几何
SetWindowPos(hwnd, HWND_NOTOPMOST, bx, by, bw, bh, SWP_NOACTIVATE);
//    并清掉之前补的 TOOLWINDOW
SetWindowLongPtrW(hwnd, GWL_EXSTYLE, beforeEx & ~WS_EX_TOOLWINDOW);
```

**踩坑提示**：只改 `exStyle` 不跟一次带 `SWP_FRAMECHANGED` 的 `SetWindowPos`，任务栏图标**不会消失**。这是 Win32 的经典陷阱。

### 2.3 定位主窗口（实测踩过的坑）

```
❌ 错误做法：Get-NetTCPConnection -LocalPort 19387 → OwningProcess → pid 29980 → 找不到窗口
✅ 正确做法：按 标题含 "DeepSeek Harness" + class=Chrome_WidgetWin_1 + 宽高>=500 定位
```

原因：**Host（node 子进程，pid 29980）与 Electron 主进程（pid 30012）是两个进程**。窗口归后者。见 `docs/01` §7。

`mini-window.cjs` 已内置正确判据，**不传 `--pid` 也能自动找到**。

### 2.4 命令清单

```powershell
$N = "~\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$M = "src\mini-window.cjs"

& $N $M list                    # 读取当前状态（只读）
& $N $M mini                    # 预演：进入小窗
& $N $M mini    --apply         # 执行
& $N $M peek    --apply         # 边缘吸附 + 隐藏任务栏图标（不缩尺寸）
& $N $M restore --apply         # 还原

# 参数
& $N $M mini --apply --w 480 --h 700 --anchor right-top --pad 16 --no-top
```

**默认 dry-run**：所有改动类命令必须显式 `--apply`。这是刻意设计，理由见 README「设计纪律」。

---

## 3. 路线 B：DSH 插件骨架

目录：`src/dsh-plugin-mini-window/`

### 3.1 架构

```
┌─────────────────────────────────────────────────────┐
│  浏览器（DSH Web UI，或 Electron 内的同一页面）        │
│    client.js 注入：                                  │
│      • 悬浮按钮（右下角，点击切换小窗）                │
│      • html[data-dsh-mini] 属性切换 → 触发紧凑 CSS     │
└───────────────────┬─────────────────────────────────┘
                    │  fetch('/api/mini-window/...')
┌───────────────────▼─────────────────────────────────┐
│  Host（dsh-desktop-host，node 侧）                    │
│    lib/index.js 注册 HTTP 路由：                      │
│      • 读：返回当前窗口几何                           │
│      • 写：koffi → user32 施加变更                    │
└─────────────────────────────────────────────────────┘
```

**为什么把窗口操作放 Host 而不是 client？**
浏览器渲染进程里**拿不到 hwnd**（`contextIsolation:true` + `sandbox:true`，且无 Electron bridge 暴露窗口 API）。Host 是 node 进程，可以直接调 `koffi`——这正好是 `dsh-host-directory-picker-native` 已经在用的范式（见 `docs/03` §6）。

### 3.2 与 DSH 现有约定的对齐

| 约定 | 落实方式 |
| --- | --- |
| 不得擅自操控用户桌面 | 插件默认**关闭**；首次启用需用户在设置面板显式打开 |
| 开关必须解耦 | `小窗` / `置顶` / `隐藏任务栏图标` 三个开关**独立**，互不联动 |
| 开关即时回显 | client 侧乐观更新 + 服务端回读校验，失败回滚标签 |
| 宿主只能用户手动重启 | 插件**不尝试**重启；安装后提示用户自行重启 |

---

## 4. 前端紧凑布局（G6）

`src/mini-mode.css`。核心思路：**用根属性做状态开关，而不是用媒体查询**。

```css
/* 之所以不用媒体查询：窗口变小时 @media 也能触发，但无法区分
   「用户手动拖小了窗口」与「进入了小窗态」——而这两种情况
   的布局意图完全不同（前者用户是想要小窗口大字，后者是要紧凑） */
html[data-dsh-mini] { /* ... */ }
```

状态由 client.js 设置：`document.documentElement.dataset.dshMini = ''`。

**待办**：DSH 的具体 DOM 类名需要实际打开 devtools 抓取后回填。当前 CSS 用的是 DSH 已确证的根属性约定（`data-ds-theme-source`、`data-platform`、`data-fullscreen` 这几个已在 `preload-app.cjs` 里出现），遵循同一模式。

---

## 5. 实施顺序（建议）

```
第 1 步  跑通路线 A 的 list / mini(预演)          ← 已完成，见 docs/03 §5
第 2 步  用户确认参数：宽度、锚点、是否置顶        ← 需要用户拍板
第 3 步  mini --apply 实测，肉眼验收              ← 需要用户在场
第 4 步  抓 devtools 拿 DSH DOM 结构，回填 CSS    ← 待做
第 5 步  照路线 B 做成插件，用户手动重启后验收     ← 待做
```

**第 2 步需要用户决策的参数**（都属于"审美与习惯"，不该由实现方拍板）：

| 参数 | 建议默认 | 备选 |
| --- | --- | --- |
| 小窗尺寸 | 420×620 | 480×700 / 520×720（对齐参考实现） |
| 锚点 | 右下 | 右上 / 左下 / 左上 |
| 置顶 | 开 | 关 |
| 隐藏任务栏图标 | 关（先不激进） | 开 |

---

## 6. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 窗口被改乱、找不到 | `restore` 命令；极端情况 `mini-state.json` 里有 `before` 几何可手工恢复 |
| 置顶后点不到别的窗口 | `--no-top` 参数；或直接 `restore` |
| exStyle 改坏导致窗口消失 | 只做**位增删**（`|` 补 `TOOLWINDOW`，`& ~` 清 `TOOLWINDOW`），不整体覆写；`style` 字段从不改动 |
| 宿主更新后 hwnd 变化 | 命令每次重新枚举定位，不缓存 hwnd |
| 与宿主内部状态不一致 | 已列为本方案待验证项；`restore` 用记录值而非推导值可规避 |

**完整回滚**：本目录对系统**零写入**（除 `src/mini-state.json` 这个自建状态文件）。删掉整个 `.` 即完全复原。
