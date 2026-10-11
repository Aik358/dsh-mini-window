# 旧包迁移存档

此目录记录**已废弃的旧包名** `dsh-mini-window`（无作用域）的迁移处置。

## 处置方式

使用 `npm deprecate`，而**不是**发新版本 —— 理由：

| 方案 | 后果 |
| --- | --- |
| 发 0.1.1 空壳包 | 已装 0.1.0 且能用的用户一旦升级就会拿到空包，**插件直接坏掉** |
| `npm deprecate`（已采用） | 安装/升级时显示迁移提示，**不改包内容**，已装用户不受影响 |

执行命令：

```bash
npm deprecate dsh-mini-window "Moved to @a9i5k4/dsh-mini-window — please install that instead. 已迁移至 @a9i5k4/dsh-mini-window。"
```

作用对象为该包**全部版本**（含 npm CLI staged publish 自动产生的 `0.0.0-stage` 占位版本）。

## 为什么改名

原以无作用域名 `dsh-mini-window` 发布；后为与作者其它 DSH 插件统一（均在 `@a9i5k4` 作用域下），
包名与运行时 id 一并改为 `@a9i5k4/dsh-mini-window`。

**契约依据**（本机 4/4 实证）：DSH 客户端插件的注册 id 必须等于包名 ——
`dsh-auto-memory`、`dsh-literature`、`dsh-memory-fitting`、`dsh-client-ui-git-graph` 四者
`package.json` 的 `name` 与 `client.js` 的 `__ModuleLoader__.load({ id })` 完全一致。

## 本目录的 README.md

若将来确需为旧包发一个版本（例如迁移提示必须出现在包内），可直接用它作为包 README。
`package.json` 亦已备好（0.1.1，标注 deprecated）。
