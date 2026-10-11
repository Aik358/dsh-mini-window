# dsh-companion

`dsh-mini-window` 的**可选**配套进程：一个独立于 DSH 的 Electron 小窗。

- **悬浮球** —— 屏幕右侧中部，透明底，可拖动，松手自动吸附屏幕边缘
- **小窗** —— 无边框浮窗，默认置顶，窗口尺寸可拖拽，位置自动记住

它**不依赖 DSH 客户端是桌面版还是 Web 版** —— 只通过 HTTP 与 DSH Host 通信。

> 这是独立进程，不属于 DSH 插件契约的一部分，因此**不随 npm 包发布**，只在本仓库里。

---

## 为什么要单独一个进程

DSH 插件只能改**页面内**的东西。而「悬浮球 + 独立浮窗」需要真实的操作系统窗口
（无边框、置顶、可拖动、任务栏托盘）—— 这些必须由独立进程持有。

所以拆成两层：

| 层 | 负责 |
| --- | --- |
| `plugin/`（DSH 插件） | 小窗模式下的页面版面（`?dsh-mini=1`） |
| `companion/`（本目录） | 操作系统窗口：悬浮球、浮窗、托盘、置顶、位置记忆 |

小窗里加载的**就是 DSH 官方界面**，因此对话区、输入卡、Markdown 渲染全部复用官方实现，
本进程不重写任何业务 UI。

---

## 运行

```bash
npm install
npm start
```

前置条件：本机已安装 DSH，且 DSH 正在运行（默认 `http://127.0.0.1:19387`）。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_COMPANION_ORIGIN` | `http://127.0.0.1:19387` | DSH 地址 |
| `DSH_COMPANION_SELFTEST` | — | 设为 `1` 只跑自检、不开窗口 |

自检模式用于验证「认证链路通不通」，不打开任何窗口：

```bash
DSH_COMPANION_SELFTEST=1 npm start
```

---

## 它是怎么连上 DSH 的

小窗需要在**页面脚本运行之前**注入一层 preload，才能让 DSH 前端认为"是老用户"
（否则会反复弹首次使用引导）。链路是：

1. **自签会话 cookie** —— 从 `~/.dsh/.credentials.yaml` 读取 DSH 的本地会话密钥，
   按官方格式签一个会话 cookie 注入 webview 分区。**不经过任何网络跳转**。
2. **存储映射** —— DSH 前端跑在自定义协议下，与 `http://127.0.0.1:19387` 是
   **两个不同的存储区**。照 origin 原样匹配一条都注不进去。
   因此读取宿主存储后，把 key **映射到 webview 的实际 origin**，
   经 `ipcRenderer.sendSync` 在页面脚本运行前写入。

> 两条走过的死路（已留证，勿重犯）：
> ① 直接拷存储文件 → Chromium 一打开就**整库丢弃重建**（schema 跨版本不兼容）
> ② 命令行传参 → `<webview>` 是独立进程，**宿主的 `additionalArguments` 不透传**

---

## 目录结构

```
main.js                 主进程（认证 / 注入 / 窗口 / 托盘）
preload.js              渲染进程桥
lib/ls-seed.js          存储映射
lib/webview-ls-seed.js  webview preload（页面脚本运行前注入）
renderer/               悬浮球 + 小窗外壳
assets/                 图标
tests/smoke/            存储映射与 preload 可行性测试
```

---

## 测试

```bash
node tests/smoke/ls-seed.test.cjs
```

---

## 已知边界

- 小窗里**发送消息 / 流式回复 / Markdown 渲染**复用官方实现，未额外改造。
- 托盘图标提供退出菜单；悬浮球本身没有右键菜单（避免误触）。
- 多显示器：窗口位置会在显示器布局变化后自动修正回可见区域。

---

## 图标

`assets/` 与 `renderer/whale.svg` 的图标取自 **DSH 内置前端资源**，
仅用于标识「本进程是 DSH 的配套组件」，**不暗示官方背书**。
出处与替换说明见 [`assets/README.md`](assets/README.md)。

---

## License

MIT
