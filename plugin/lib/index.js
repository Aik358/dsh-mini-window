/**
 * dsh-mini-window —— host 侧入口。
 *
 * 批次 0 阶段这个文件只做一件事：证明包被 Host 正确加载。
 * 后续批次（批次 2+）会在这里注册 host 侧服务（例如 mini 模式的能力开关）。
 *
 * 契约来源（读到原文，非推测）：
 *   - @deepseek-ai/dsh-client-ui-theme/lib/index.js 等官方包均为 `export function apply(ctx)`
 *   - profile 通过 package.json 的 `dsh.bundle.patch` 指向本包的 cordis.patch.yml
 */

/** Host 侧不依赖任何服务即可加载（批次 0 保持零 inject，避免因缺服务永久 pending）。 */
export const name = 'dsh-mini-window';

export function apply(ctx) {
  ctx.logger?.info?.('[dsh-mini-window] host 侧已加载');
}
