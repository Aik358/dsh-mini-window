<div align="center">

# dsh-mini-window → **@a9i5k4/dsh-mini-window**

**⚠️ This package has moved. / 本包已迁移。**

**New location: [`@a9i5k4/dsh-mini-window`](https://www.npmjs.com/package/@a9i5k4/dsh-mini-window)**
**新位置：[`@a9i5k4/dsh-mini-window`](https://www.npmjs.com/package/@a9i5k4/dsh-mini-window)**

</div>

---

## English

### Why

This package was published once under the unscoped name `dsh-mini-window`, before the plugin was
renamed to follow the same convention as the author's other DSH plugins, which all live under the
`@a9i5k4` scope.

**Please install the scoped package instead:**

```bash
dsh plugin --profile <your-profile> add @a9i5k4/dsh-mini-window

# or with pnpm directly
pnpm add @a9i5k4/dsh-mini-window
```

### What is it

A compact mini-window mode for DeepSeek Harness (DSH). Open the GUI with `?dsh-mini=1` and the
three-column layout collapses into a compact single-column view. Pure client plugin, zero runtime
dependencies, no build step, and no impact on the main UI when the parameter is absent.

### Migrating

Replace the unscoped dependency with the scoped one:

```diff
- dsh-mini-window
+ @a9i5k4/dsh-mini-window
```

Nothing else changes — same plugin, same feature, same repository.

- **New package**: <https://www.npmjs.com/package/@a9i5k4/dsh-mini-window>
- **Repository**: <https://github.com/Aik358/dsh-mini-window>

---

## 中文

### 为什么迁移

本包最初以**无作用域**的名字 `dsh-mini-window` 发布过一次；之后插件改名，以与作者其它 DSH 插件
保持同一约定 —— 它们都挂在 `@a9i5k4` 作用域下。

**请改用带作用域的包：**

```bash
dsh plugin --profile <你的 profile> add @a9i5k4/dsh-mini-window

# 或直接用 pnpm 装
pnpm add @a9i5k4/dsh-mini-window
```

### 它是什么

给 DeepSeek Harness（DSH）的一个紧凑小窗模式。用 `?dsh-mini=1` 打开界面，三栏布局会收成
紧凑的单栏视图。纯客户端插件、零运行时依赖、免构建；不带参数时对主界面零影响。

### 怎么迁移

把无作用域的依赖换成带作用域的即可：

```diff
- dsh-mini-window
+ @a9i5k4/dsh-mini-window
```

其余都不用动 —— 同一个插件、同一套功能、同一个仓库。

- **新包地址**：<https://www.npmjs.com/package/@a9i5k4/dsh-mini-window>
- **仓库地址**：<https://github.com/Aik358/dsh-mini-window>

---

## License

MIT
