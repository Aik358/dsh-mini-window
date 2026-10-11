# dsh-mini-window

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）加一个**小窗模式** ——
`?dsh-mini=1` 触发紧凑单栏视图，另附一个可选的独立小窗进程（悬浮球 + 浮窗）。

**纯客户端插件，零运行时依赖，免构建。** 不带参数时对 DSH 主界面**零影响**。

---

## 特性

| 能力 | 说明 |
| --- | --- |
| **小窗模式** | 访问 `/?dsh-mini=1` 即进入紧凑单栏视图：黑画布 + 400×600 圆角卡片 + 55px 自绘顶栏 + 贴底输入卡 |
| **顶栏控件** | 最小化 / 置顶 / 侧栏开关 / 紧凑浮窗 / 更多菜单（含 80%–150% 界面缩放） |
| **独立小窗进程** | 可选。Electron 独立进程，悬浮球 + 无边框浮窗，窗口尺寸可拖拽，位置自动记住 |
| **不抢官方布局** | 窄视口下 DSH 官方已把侧栏折叠成浮层，本插件**不重复实现**响应式，避免与官方机制互相覆盖 |
| **零影响负路径** | 不带 `?dsh-mini=1` 时所有样式规则都不生效（全部挂在 `html[data-dsh-mini]` 下） |

---

## 安装

### 方式一：npm（推荐）

```bash
dsh plugin --profile <你的 profile> add dsh-mini-window
```

### 方式二：GitHub

```bash
dsh plugin --profile <你的 profile> add github:Aik358/dsh-mini-window
```

### 方式三：本地目录

```bash
git clone https://github.com/Aik358/dsh-mini-window.git
dsh plugin --profile <你的 profile> add "link:<克隆下来的路径>/plugin"
```

安装后**需要重启 DSH 宿主**才生效。

然后浏览器访问：

```
http://127.0.0.1:19387/?dsh-mini=1
```

- **带** `?dsh-mini=1` → 小窗模式
- **不带** → 保持官方三栏布局，零影响

---

## 可选：独立小窗进程

```bash
cd companion
npm install
npm start
```

会得到：

- **悬浮球** —— 屏幕右侧中部，透明底，可拖动，松手自动吸附屏幕边缘
- **小窗** —— 520×720 客户区，无边框，默认置顶，位置自动记住

小窗加载的就是 DSH 官方界面，所以对话区、输入卡、Markdown 渲染全部复用官方实现。

> 需要本机已安装 Node.js 与 DSH。`companion/` 只依赖 `electron` 一个包。

---

## 技术要点

### 1. 为什么不用自己写响应式 CSS

DSH 官方前端**自带响应式**，实测：

| 视口宽 | 侧栏 | 对话区 |
| --- | --- | --- |
| ≥1024 | 280px 展开 | @x=280 |
| 920–760 | 自动折叠成 56px 轨道 | @x=56 |
| ≤760 | 浮层，`pointer-events:none` | 满宽 @x=0 |

`elementFromPoint` 在左侧窄带 9 个采样点 **0/9 命中侧栏** —— 官方已让对话区满宽。
再叠一套收缩 CSS 只会与官方机制互相覆盖（症状随机），因此**明确不做**。

### 2. 样式全部挂在 `html[data-dsh-mini]` 下

所有规则都是 `html[data-dsh-mini] ...` 前缀。不带参数时该属性不存在
⇒ **对主界面零生效**，这是「负路径」可验证的前提。

### 3. 规格常量单一真相源

`plugin/lib/mini-spec.cjs` 集中定义几何与配色（卡片 400×600、顶栏 55、
输入卡 98、`#1A1A1A` / `#232528` 等），样式表与应用侧共用同一份，
避免同一个数值在多处各写一遍而漂移。

### 4. 免构建

`lib/client.js` 是手写 classic script，经官方 `__ModuleLoader__.load({ id, factory })`
注册。已用真实 bundle 验证官方接受这种形态 —— 改完刷新页面即可，不需要打包步骤。

---

## 目录结构

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

> `evidence/` 与 `probe/` 是**本机开发期**的 UI 实测数据与回归工具，
> 依赖本机 DSH 宿主与截图，已通过 `.gitignore` 排除，不随仓库分发。

---

## 开发

```bash
# 运行时守卫（真执行 factory，验证插件能被 DSH 正确加载）
node plugin/tests/smoke/client-factory-guard.cjs

# 语法检查
node --check plugin/lib/client.js
```

插件安装为本地链接时（`link:<path>/plugin`），改完**刷新页面**即可生效，无需重启宿主。

---

## 兼容性

- **平台**：`web`（DSH 桌面端与 Web 端共用同一前端）
- **peer 依赖**：`@deepseek-ai/cordis`
- **不依赖任何第三方生态插件** —— 交付物自持，任何 DSH 环境都能加载

---

## License

MIT
