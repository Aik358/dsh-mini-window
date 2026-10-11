# 图标来源说明

本目录下的图标来自 **DSH（DeepSeek Harness）内置前端资源**：

| 文件 | 来源 |
| --- | --- |
| `whale-*.png` | 由 `renderer/whale.svg` 栅格化生成（托盘与窗口图标） |
| `whale-black-256.png` / `whale-white-256.png` | 由同一矢量生成的黑/白变体 |
| `app-icon.png` | 应用图标（同源） |

`renderer/whale.svg` 取自 DSH 内置前端的官方矢量图形（`dsh-web-frontend/dist/favicon.svg`）。

## 使用声明

这些图标**仅用于标识「本进程是 DSH 的配套组件」**，不用于暗示官方背书。
DeepSeek / DSH 的名称与图形标识归其权利人所有；
若权利人要求，可替换为任意中性图标 —— 代码对图标路径的引用集中在
`main.js` 的 `ICON` 常量与 `renderer/ball.html` 的内联 SVG，替换成本很低。
