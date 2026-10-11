# dsh-mini-window

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）加一个**小窗模式**：
访问 `/?dsh-mini=1` 即进入紧凑单栏视图。

**纯客户端插件，零运行时依赖，免构建。** 不带参数时对 DSH 主界面**零影响**。

> 本包只含插件本体。可选的独立小窗进程（悬浮球 + 无边框浮窗）在仓库的 `companion/` 目录，
> 不随 npm 包发布 —— 它依赖 Electron，且是独立进程，不属于 DSH 插件契约的一部分。

---

## 安装

```bash
dsh plugin --profile <你的 profile> add dsh-mini-window
```

安装后**需要重启 DSH 宿主**才生效。然后访问：

```
http://127.0.0.1:19387/?dsh-mini=1
```

- **带** `?dsh-mini=1` → 小窗模式
- **不带** → 保持官方三栏布局，零影响

---

## 它做了什么

小窗模式下：

| 元素 | 规格 |
| --- | --- |
| 画布 | 透明（透出窗口底色） |
| 内容卡片 | 100% 自适应窗口，圆角 20px，底色 `#1A1A1A` |
| 顶栏 | 55px，由宿主自绘（最小化 / 置顶 / 侧栏 / 紧凑浮窗 / 更多） |
| 输入卡 | 贴底，圆角 16px，底色 `#232528`，距卡片左右 16 / 距底 17 |
| 对话头 | 让位 55px，避免被顶栏压住官方页签行 |

顶栏由宿主侧（`companion/`）覆盖绘制；插件侧负责其余全部版面。

---

## 设计取舍

### 不重复实现响应式

DSH 官方前端**自带响应式**。实测窄视口下官方已把侧栏折叠成浮层、对话区满宽
（`elementFromPoint` 左侧窄带 9 个采样点 0/9 命中侧栏）。
再叠一套收缩 CSS 只会与官方机制互相覆盖，因此**明确不做**。

### 全部规则挂在 `html[data-dsh-mini]` 下

不带 `?dsh-mini=1` 时该属性不存在 ⇒ 所有规则零生效。
这是「负路径可验证」的前提：删掉参数，主界面必须与未安装时一致。

### 规格常量单一真相源

`lib/mini-spec.cjs` 集中定义几何与配色，样式表与宿主侧共用同一份，
避免同一数值在多处各写一遍而漂移。

### 免构建

`lib/client.js` 是手写 classic script，经官方 `__ModuleLoader__.load({ id, factory })` 注册。
改完刷新页面即可，不需要打包步骤。

---

## 开发

```bash
# 运行时守卫：真执行 factory，验证插件能被 DSH 正确加载
node tests/smoke/client-factory-guard.cjs

# 语法检查
node --check lib/client.js
```

以本地链接方式安装时（`dsh plugin add "link:<路径>/plugin"`），改完**刷新页面**即生效，无需重启宿主。

---

## 兼容性

- **平台**：`web`（DSH 桌面端与 Web 端共用同一前端）
- **peer 依赖**：`@deepseek-ai/cordis`
- **不依赖任何第三方生态插件** —— 交付物自持，任何 DSH 环境都能加载

---

## License

MIT
