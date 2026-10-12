/**
 * dsh-mini-window —— 浏览器侧入口。
 *
 * ## 注册格式（照抄官方最小插件的原文，已验证可加载）
 *
 *   window.__ModuleLoader__.load({
 *     id: "<包名>",
 *     factory: (require) => { ... return module.exports }
 *   })
 *
 * - factory 收到**同步 require**，解析「平台种子表 → 已记忆记录 → 启动图 row → 已注册 factory」
 * - 模块主体副作用必须落在 factory 闭包内
 * - 导出 `apply(ctx)` 与 `inject`（客户端服务名数组）
 *
 * **免构建已实证**：本文件是手写的 classic script，不经 tsdown。
 * 浏览器侧契约只要求「一个注册了指定 id 的 factory」，已用真实 bundle 验证
 * （见 evidence/batch0-plugin-load-verified.md）。
 *
 * ## ★ 落点：shell.overlay，绝不是 root
 *
 * `dsh-client-ui-renderer/lib/types/client/registry.d.ts` 对 `root` 有明文警告：
 *   「DO NOT register here. This is a single slot, so a second entry does not sit
 *     beside the frame — it shadows it, and a dynamically registered entry is
 *     assigned a lower priority than the shipped one, which makes it the winner:
 *     the page would render your component alone, with every seat the frame
 *     declares gone. For a surface of your own that floats over the whole app,
 *     register into `shell.overlay` instead.」
 * ⇒ 注册到 root 会**遮蔽整个 AppFrame**，页面只剩本组件。浮层类 UI 的正确落点是
 *   `shell.overlay`（list slot：可叠加、默认 click-through）。
 *
 * ## 本批次（批次 2）做什么
 *
 * 只做「mini 模式的可视标记 + 规格注入」，**不抢官方布局**。
 * 理由（实测，见 evidence/batch2-official-responsive-verified.md）：
 *   - ≤1024px 官方侧栏自动折叠为 56px 轨道
 *   - ≤760px  官方对话区满宽、details 归零、轨道变 click-through 浮层
 *   ⇒ 目标宽度 460 下，「隐藏控制栏 / 隐藏右栏」**官方自带**。
 *     再写一套收缩 CSS 会与官方机制互相覆盖（症状随机），本插件明确不这么做。
 */

window.__ModuleLoader__.load({
	// ★ 运行时 id = **完整包名**（与 @a9i5k4/dsh-auto-memory 同一口径）。
	//   它同时是 profile roster 的依赖键与浏览器侧注册 id，三处必须一致：
	//     package.json 的 name / client.js 的 id / cordis.patch.yml 的 name。
	id: '@a9i5k4/dsh-mini-window',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		let react_jsx_runtime = require('react/jsx-runtime');

		// ---- 规格常量（与 lib/mini-spec.cjs 保持一致；浏览器侧不能 require 它，故内联）----
		/** mini 触发参数（对齐参考实现用 URL 判据切小窗的做法）。 */
		const MINI_PARAM = 'dsh-mini';
		const MINI_VALUE = '1';
		/**
		 * host 侧小窗路由前缀。
		 *
		 * 必须与 `lib/host-routes.js` 的 `ROUTE_PREFIX` **完全一致**
		 * —— 守卫里有断言守这条（改一处不改另一处会静默失联，属"半修"）。
		 */
		const HOST_ROUTE_PREFIX = '/dsh-mini-window';

		/**
		 * 关闭悬浮球的 URL 参数（`?dsh-ball=0`）。
		 *
		 * 球默认在**任何页面**都挂载（见 apply 里的说明）；这个参数是给用户的
		 * 逃生开关：不想看到球时加 `?dsh-ball=0` 即可（也便于排查时排除球的干扰）。
		 */
		const BALL_PARAM = 'dsh-ball';
		/** 调试角标的开关参数：默认**不显示**（参考实现版面里没有角标）。 */
		const DEBUG_PARAM = 'dsh-mini-debug';
		/** 参考实现实测规格：内容卡片 400×600；顶栏 55 / 输入卡 98；配色 #1A1A1A / #232528。 */
		const SPEC = {
			panel: '#1A1A1A',
			composer: '#232528',
			divider: '#313131',
			topbar: 55,
			shadow: '0 12px 40px rgba(0,0,0,.45)',
		};

		/**
		 * 是否处于小窗模式：URL 带 `?dsh-mini=1`。
		 *
		 * 健壮性：**动态读全局**而非模块作用域的 `window`，整段包在 try 里。
		 * URL/location 在 about:blank、被 sandbox 的 iframe、测试沙箱下都可能抛错。
		 * 取不到时**保守返回 false**：宁可不开小窗，也不能让主界面崩掉。
		 */
		function isMiniMode() {
			try {
				const g = typeof globalThis !== 'undefined' ? globalThis : undefined;
				const loc = g && g.location ? g.location : (typeof window !== 'undefined' ? window.location : undefined);
				const search = loc && loc.search;
				if (typeof search !== 'string') return false;
				return new URLSearchParams(search).get(MINI_PARAM) === MINI_VALUE;
			} catch {
				return false;
			}
		}

		/**
		 * 是否显示调试角标：URL 带 `?dsh-mini-debug=1`。
		 *
		 * 与 `isMiniMode()` 同源写法的健壮性：动态读全局、整段包 try、取不到时保守返回 false。
		 */
		function isMiniDebug() {
			try {
				const g = typeof globalThis !== 'undefined' ? globalThis : undefined;
				const loc = g && g.location ? g.location : (typeof window !== 'undefined' ? window.location : undefined);
				const search = loc && loc.search;
				if (typeof search !== 'string') return false;
				return new URLSearchParams(search).get(DEBUG_PARAM) === MINI_VALUE;
			} catch {
				return false;
			}
		}

		/**
		 * ★ mini 模式的**样式表** —— 复刻参考小窗前端（2026-10-11 补写）。
		 *
		 * ## 为什么之前"改都没改"
		 *
		 * 本插件此前只做两件事：给 `<html>` 打 `data-dsh-mini="1"`、设 4 个 `--dsh-mini-*` 变量。
		 * 但**没有任何 CSS 选择器命中那个属性、也没有任何元素消费那些变量** ——
		 * 实测定量证据（`evidence/batch8-mini-visual-diff.log`）：同视口 460×720 下，
		 * mini 与不带参数的 8 项关键计算样式**差异 0/8**，注入的 247 个 `<style>` 里
		 * **含 `dsh-mini` 的为 0 个**。即：mini 模式对视觉**零影响**，小窗只是「DSH 前端装进小窗」。
		 *
		 * ## 目标规格（逐像素实测，见 plugin/lib/mini-spec.cjs）
		 *
		 *   画布底色 `#000000`；内容卡片 **400×600**、圆角 12px、底色 `#1A1A1A`
		 *   顶栏 **55px**（由 Companion 宿主自绘，本插件负责其余）
		 *   分隔线 1px `#313131`
		 *   对话区 429px
		 *   输入卡 **368×98**、圆角 16px、底色 `#232528`，距卡片左/右 16、距底 17
		 *
		 * ## 选择器来自**真实 DOM 契约**（不是占位）
		 *
		 * `evidence/batch9-dom-contract.json` 实测：`data-dsh-region` **零命中**（旧方案的占位契约），
		 * 真实契约族是 `data-dsh-surface` / `data-dsh-part` / `data-pane` /
		 * `data-dsh-responsive-part` / `data-composer-*` / `data-conversation-*`。
		 * 本样式表**只使用实测存在的选择器**。
		 *
		 * ## 纪律
		 *
		 *   · 全部规则挂在 `html[data-dsh-mini]` 下 ⇒ 不带参数时**零影响**（不误伤主界面）
		 *   · 只做「颜色 / 尺寸 / 布局落位」与「隐藏 DSH 原生 chrome」，不改任何业务行为
		 *   · 隐藏类规则逐条对照实测到的 `data-*` 属性，不做猜测性选择器
		 */
		const MINI_CSS = [
			// ---- ① 画布：**透明**，不是黑色（2026-10-11 修正）----
			//
			// ⚠️ 这里曾写 `#000` —— 那是**误读参考实现规格**的结果。
			//   `docs/06` 原文两处：
			//     · 「400×600 的内容卡片，居中放在 520×720 的无边框**透明窗口**里」
			//     · 「窗口画布（**透明区被合成后的底色**）#000000」
			//   那圈黑是**截图时透明区与背景合成的结果**，不是参考实现真涂了黑。
			//   我把它当成"要涂的颜色"，于是窗口外围成了一圈真黑边（用户实测反馈
			//   「还是不行，你看这外边的一圈黑框」）。
			//   ⇒ 现在窗口与页面都用真透明，让桌面透出来。
			'html[data-dsh-mini],html[data-dsh-mini] body{' +
				'background:var(--dsh-mini-canvas,transparent)!important}',

			// ---- ② 内容卡片：400×600、圆角 12px、底色 #1A1A1A（参考实现实测规格）----
			// 参考实现：窗口 520×720 里的内容卡片 400×600，留白 左60/右60/上30/下90。
			// 小窗窗口 460×720 ⇒ 卡片 400 宽、左右各留 30；上 30 / 下 90 与参考实现同。
			// 卡片 = `conversation` surface（实测它就是承载对话与输入卡的那一层）。
			//
			// ⚠️ **不能硬编码压色**：实测卡片内承托内容的是 `.Dc7zOa_root`（`data-phase=hero`），
			// 它的底色来自 DSH 官方 token `--dsw-alias-bg-base`（暗色 = #151517）。
			// 直接写死 #1A1A1A 会（a）被它盖住、(b）浅色主题下反而变黑。
			// 正确做法：**重定义官方 token** —— 既精确命中、又跟随主题机制。
			// 注意 token 要在 html 与 body 两层都写：DSH 可能定义在其中任一层，
			// 自定义属性按「最近的祖先定义」取胜，只写 html 会被 body 上的定义盖过。
			'html[data-dsh-mini],html[data-dsh-mini] body{' +
				'--dsw-alias-bg-base:var(--dsh-mini-panel,#1A1A1A)!important;' +
				'--dsh-boot-bg:var(--dsh-mini-panel,#1A1A1A)!important}',
			'html[data-dsh-mini] [data-dsh-surface="conversation"]{' +
				'box-sizing:border-box!important;' +
				// ★★ 2026-10-11 用户裁定：**卡片铺满窗口**（不再留 60/30/90 的边距）。
				//
				// 原设计照搬参考实现「400×600 卡片居中放在 520×720 窗口里」，留白 左右60/上30/下90。
				// 用户实测后提出：「能不能把这个窗口的默认值直接铺满整个窗格啊？
				// 这样至少就不用做这么多奇怪的动作了，还更方便、更简单一点」。
				//
				// 采纳的理由不只是"更简单" —— 那圈留白本身是一整条缺陷链的源头：
				//   留白 ⇒ 需要透明窗 ⇒ 透明窗在 Windows 上不能系统缩放
				//   ⇒ 自绘 8 个把手 + 自绘拖动 + 穿透判定 ⇒ 三者几何必须一致
				//   ⇒ 一旦不一致就出现「得找一段空白才能拖」「粘手」「挪到哪亮哪一块」。
				// 铺满后留白归零，**上面整条链连同缺陷一起消失**。
				//
				// 代价（如实记录）：不再是参考实现那种"浮在透明窗口里的卡片"外观。
				'width:100%!important;height:100%!important;margin:0!important;' +
				// ★ 圆角用**标定后的实测值 20px**，而不是 docs/06 里那个「估算 12px」。
				//   标定方法（可复算）：probe/radius-baseline.cjs 渲染已知半径的对照块
				//   （0/6/12/30px），证明「逐行首个非零像素」这个口径**不是 1:1**
				//   （0→0、6→3、12→7、30→23）；probe/radius-calibrate.cjs 用该曲线反查：
				//     实测卡片 量出 6  → 估计 10.5px（声明 12px ⇒ 与标定吻合）
				//     参考实现卡片 量出 14 → 估计 19.9px
				//   ⇒ 参考实现真实圆角 ≈20px。docs/06 §1.3 的「12px」是**估算**
				//     （该表自述「由含抗锯齿的视觉半径减抗锯齿外扩推得，非直接读取 CSS」），
				//     本轮用标定曲线把它修正为实测值 20px。
				//
				//   ⚠️ 必须留痕：中途曾一度判定「实测圆角被削成 6px、是缺陷」——**该结论已证伪并撤回**。
				//      真相是那个像素口径天然只量到半径的 ~0.6 倍，拿它直接跟参考实现比才显得"小一半"。
				//      先自证测量方法、再下结论，是这一条的根本教训。
				'border-radius:var(--dsh-mini-radius-panel,20px)!important;' +
				'background:var(--dsh-mini-panel,#1A1A1A)!important;' +
				// ★ `overflow:hidden` **不足以**把圆角裁出来（2026-10-11 实测）
				//
				// 铁证（evidence/batch10-radius-who.log + 角区面积法）：
				//   卡片 computed `border-radius: 20px`、`overflow: hidden`，四角却**零裁剪**——
				//   30×30 角区非黑像素 **900/900**（满），逐像素网格 y614–631 全为卡片色，
				//   而参考实现同区域是 **826**（缺口 ≈20px 圆角）。
				//   标定曲线（0px→900、6px→894、12px→877、30px→719）证明该**面积法对半径强单调**，
				//   故 900 只能解释为「完全没有圆角」，不是测量误差。
				//   同时 `elementsFromPoint` 在缺口各点仍返回卡片内的子元素 ⇒ 卡片边界就是矩形。
				//
				// ⇒ 单靠 `overflow:hidden` 在该层叠环境下不触发圆角裁剪；必须**显式裁剪**。
				//   用 `clip-path: inset(0 round Npx)` 直接给出裁剪形状，不依赖 overflow 的实现细节。
				//   两者同时保留：overflow 管滚动内容，clip-path 管形状。
				'overflow:hidden!important;padding:0!important;' +
				'clip-path:inset(0 round var(--dsh-mini-radius-panel,20px))!important;' +
				'position:relative!important;z-index:1!important}',
			// 外层（root/overlay/皮肤层/满窗 frame）必须透明，否则黑底被盖住、圆角被糊掉
			//
			// ★ 这条是**逐像素比对抓出来的真缺陷**（evidence/batch10-pixel-diff.log）：
			//   此前只列了 root/overlay/skin-layer，漏了 `[data-dsh-frame]`。
			//   而 frame 是**满窗元素**（实测 400×600 的卡片之外它铺满整个客户区），
			//   它的底色走的正是被本插件重定义成 #1A1A1A 的官方 token
			//   `--dsw-alias-bg-base` ⇒ 结果：**黑画布被涂成 #1A1A1A**，
			//   画布留白实测 #1A1A1A（参考实现 #000000，通道差 26），卡片与画布同色、圆角看不见。
			//   单项计算样式断言全部通过、`html` 背景也确实是 rgb(0,0,0)，
			//   只有把成品与参考实现图逐像素对照才暴露 ⇒ 这就是需要像素回路的理由。
			//   `data-dsh-frame` 是实测存在的契约（probe/official-controls.cjs / hero-tree2）。
			'html[data-dsh-mini] [data-dsh-surface="root"],',
			'html[data-dsh-mini] [data-dsh-surface="overlay"],',
			'html[data-dsh-mini] [data-dsh-frame],',
			'html[data-dsh-mini] [data-dsh-skin-layer]{background:transparent!important}',
			// frame 之下的裸包装层（实测它是 frame 的父级，无 data-* 属性）：
			// 用「是 frame 的祖先」这一结构关系定位，不靠类名（类名是 hash，会被 minify）
			'html[data-dsh-mini] body > div:has(> [data-dsh-frame]){' +
				'background:transparent!important}',
			// 卡片内的 phase 容器（实测 `data-phase="hero"`，用官方 token 着色）改为透明，
			// 让卡片自身的 #1A1A1A 透上来。
			// ★ 用实测存在的**稳定属性** `data-phase` 定位，不依赖会被 minify 的 hash 类名；
			//   也不做 `div{...}` 全局覆盖 —— 那会连带压掉输入卡的 #232528。
			'html[data-dsh-mini] [data-dsh-surface="conversation"] [data-phase]{' +
				'background-color:transparent!important;background-image:none!important}',

			// ---- ③ 隐藏 DSH 原生 chrome：小窗里这些是「主窗口的构件」，不属于小窗版面 ----
			//
			// ★★ 2026-10-11 修复「点顶栏 T3 侧栏没反应」（用户实测反馈）。真因**就是下面这两行**：
			//   ① 我把 `[data-pane="sidebar"]` 整块 `display:none` 了；
			//   ② 同时把官方开关 `[data-dsh-responsive-part="sidebar-toggle"]` 也 `display:none` 了。
			//   Companion 顶栏的 T3 是把点击**转发**给官方那个开关（`panel.js` 的 forwardToOfficial）——
			//   转发本身是成功的（`el.click()` 在 0×0 元素上仍会触发 React onClick），
			//   但官方把侧栏容器设成 `display:none` ⇒ **展开了也看不见任何东西**
			//   ⇒ 用户观感就是「按一下，没反应」。
			//
			//   正确做法：**不要隐藏侧栏容器**（它是纯 functional 容器，收起态本来就是 0 宽、
			//   不占版面），只隐藏**视觉上的 rail 轨道**（那是主窗口的构件）。
			//   侧栏「收起 / 展开」交给官方自己的状态机管理 —— 这正是 docs/06 §3.3 指的路。
			//
			//   判据（可复算）：修复前后测 `[data-pane="sidebar"]` 的 computed display，
			//   修复前 `none`、修复后 `block`；再点 T3，其宽度应从 0 → 321（
			//   evidence/batch11-defects.log 已实测到展开后 `sidebarW=321`）。
			// 视觉 rail 轨道：收起态它本该是 0 宽，这里只是保险地收敛它的**视觉**，不动 display。
			'html[data-dsh-mini] [data-rail="rail"][data-wide="rail"]{background:transparent!important}',
			// ★ 关键修复：**不再无条件隐藏 sidebar 容器**。
			//   原来的写法（`[data-pane="sidebar"]{display:none}`）**是 T3 失效的直接原因**：
			//   T3 把点击转发给官方开关，官方状态机确实切了，但容器永远 display:none
			//   ⇒ 展开了也看不见 ⇒ 用户观感"按一下没反应"。
			//
			//   但也不能**完全不管**它：收起态下官方会保留一条 **52px 轨道**，
			//   在参考实现版面里它是多余的，而且会让卡片被挤偏（实测卡片 x 由 60 → 36，
			//   并与轨道**重叠 16px**）。
			//
			//   ★ 正解：**按官方的折叠状态属性**决定 ——
			//     `[data-dsh-frame][data-sidebar-collapsed="true"]`（实测存在）时隐藏轨道；
			//     一旦展开，该属性变 false ⇒ 规则自动失效、侧栏正常显示。
			//     这样「收起时干净」与「展开时可见」两个目标同时满足，且不依赖任何 hash 类名。
			'html[data-dsh-mini] [data-dsh-frame][data-sidebar-collapsed="true"] [data-pane="sidebar"]{' +
				'display:none!important}',
			// 官方开关：**保留在 DOM 里且可点**（T3 要靠它转发），只把它移出可视区。
			// ⚠️ 不能 `display:none` —— 那样它仍是"存在但零尺寸"，历史实现即栽在这里。
			'html[data-dsh-mini] [data-dsh-responsive-part="sidebar-toggle"]{' +
				'position:absolute!important;left:-9999px!important;top:0!important;' +
				'width:1px!important;height:1px!important;opacity:0!important;' +
				'pointer-events:auto!important}',
			// 更新提醒浮层：实测是 fixed 的 `[role="status"]` 大块（404×335@(20,264)），会盖住整张卡片。
			//
			// ★ 2026-10-11 收窄选择器（用户报「拖文件没有原生提示框」时排查所及）：
			//   原来写的是 `[role="status"]{display:none}` —— **范围过宽**，
			//   会把页面里**任何** `role="status"` 的活体区域一起隐藏，
			//   而这类 role 常被用作「拖放提示 / 状态播报」的落点 ⇒ 有误伤风险。
			//
			//   实测当前该节点是更新提醒（`aria-label="WorkBuddy Connect 更新"`，
			//   文本「发现新版本：0.7.2 …」），确认身份后**按 aria-label 精确隐藏**，
			//   不再按 role 一刀切。
			//
			//   注：本轮用户报的"拖放无提示"经取证**不是**这条引起的
			//   （实测页面里只有一个 role=status，就是更新提醒），
			//   但把它收窄是**正确的防御**：将来官方若用 role=status 做拖放提示，
			//   这条宽规则会静默把它抹掉，且极难排查。
			'html[data-dsh-mini] [role="status"][aria-label*="更新"]{display:none!important}',
			// 用量脚卡 / 记忆拟合悬浮件 / 引导层 / 面板宿主：均非小窗版面元素
			'html[data-dsh-mini] [data-dsh-usage-foot-card],',
			'html[data-dsh-mini] [data-dsh-better-sidebar],',
			'html[data-dsh-mini] [data-dsh-panel-host],',
			'html[data-dsh-mini] [data-dam-tour],',
			'html[data-dsh-mini] [data-dam-tour-backdrop],',
			'html[data-dsh-mini] [data-dsh-shutdown-float],',
			'html[data-dsh-mini] .mf-fab,',
			// 第三方插件的悬浮件（实测：`div#ark9-fab-root`，`position:fixed; right:16px;
			// bottom:96px`，44×44，实测压住输入卡右下角 —— evidence/batch10-fab.log）。
			// 小窗版面里没有它的位置，且它挡住输入卡 ⇒ 隐藏。
			// ★ 用实测到的 **id 契约**（稳定、非 hash 类名），不用 `[class*=...]` 猜。
			// ⚠️ 这**不是**「交付物依赖第三方插件」：Companion 与插件本体零依赖，
			//    这条只是「小窗里不显示别的插件的浮标」，主界面与插件功能都不受影响。
			'html[data-dsh-mini] #ark9-fab-root,',
			'html[data-dsh-mini] #ark9-panel-root{display:none!important}',

			// ---- ④ 对话区：参考实现空会话是**纯空**的（实测 y86–514 整段无任何非底色像素）----
			// DSH 的 hero 态会渲染品牌装饰块（鲸鱼标记 svg + 「探索未至之境 / 预览版」），
			// 小窗里必须收敛，否则一眼就是 DSH 而不是参考实现。
			//
			// ⚠️ **不能整块 `display:none`**：`[data-conversation-region="chat"]` 里同时住着
			// 「选择工作区」入口 —— 那是**功能性控件**，隐藏它会让小窗变成死路（无法开始对话）。
			// 因此只收敛「品牌装饰块」，保留全部可点元素。
			//
			// ★ 实测结构（`evidence/batch10-hero-tree.json`，逐节点）：
			//     div.Hqq-bq_root (400x44@(30,375))
			//       └ div.Hqq-bq_stack
			//           ├ div.Hqq-bq_headline (352x32)
			//           │   ├ span.Hqq-bq_fishHitbox
			//           │   │   └ div[data-slot="conversation.hero.brand.mark"]   ← 官方「品牌标记」槽
			//           │   │       └ svg.Hqq-bq_fish
			//           │   └ span.Hqq-bq_titleGroup  ← own text「探索未至之境」+「预览版」
			//           └ div.Hqq-bq_body (352x0，空)
			//   品牌文字**不在** `brand.mark` 槽内（同层兄弟），所以只隐藏该槽是删不掉文字的；
			//   要删整块，必须用 `:has()` 反查「包含品牌标记槽的那个容器」。
			//   该选择器**实测唯一命中**根节点（composerStack/scrollBody 都不满足 4 层链）。
			//
			// ⚠️ **上一批的真缺陷（本轮修）**：曾写 `[data-content-phase="hero"] svg{display:none}`。
			//    实测该属性挂在**输入卡的祖先**上（`[data-composer-seat]` < `[data-conversation-scroll]`
			//    < `[data-conversation-content][data-content-phase=hero]`），于是这条规则把
			//    输入卡里的 `+` 与发送箭头**一并抹掉**了 —— 功能受损。改为只收敛品牌块。
			'html[data-dsh-mini] [data-content-phase="hero"] div:has(> div > div > span > [data-slot="conversation.hero.brand.mark"]){' +
				'display:none!important}',
			'html[data-dsh-mini] [data-content-phase="hero"]{' +
				'background:transparent!important}',
			'html[data-dsh-mini] [data-conversation-region="chat"]{' +
				'background:transparent!important;padding-top:0!important}',
			'html[data-dsh-mini] [data-conversation-content]{background:transparent!important}',

			// ---- ⑤ 输入卡：368×98 / #232528 / 圆角 16 / 距卡片左右 16、距底 17（参考实现实测）----
			// 小窗态下 composer 一律**贴底**（参考实现截图里空会话也是贴底，DSH 的 hero 态会居中）。
			//
			// ⚠️ 实测教训：曾用 `div:has(>[data-composer-card])` 定位，结果匹配到的是
			// **卡片往里数第一层 114px 高的容器**（`.RlGAzG_root`），而不是真正承托它的
			// `[data-composer-seat]`（437×238）—— 于是 `position` 没落到 seat 上，
			// 输入卡依旧停在卡片中部（实测 `seatPos=static`、`seatBox=392x116@(30,207)`）。
			// 正确做法：**直接用实测存在的 `data-composer-seat` 属性定位**。
			'html[data-dsh-mini] [data-composer-seat]{' +
				'position:absolute!important;left:0!important;right:0!important;' +
				'bottom:0!important;top:auto!important;z-index:20!important;' +
				'height:auto!important;padding:0!important;background:transparent!important}',
			'html[data-dsh-mini] [data-dsh-surface="composer"],',
			'html[data-dsh-mini] [data-slot="conversation.composer"],',
			'html[data-dsh-mini] [data-chain-overlay-fallback]{background:transparent!important}',
			'html[data-dsh-mini] [data-composer-card]{' +
				'background:var(--dsh-mini-composer,#232528)!important;' +
				// ⚠️ `border:0` **清不掉那圈虚线**：实测（evidence/batch10-composer-detail.log）
				// 虚线来自官方 `::after` 伪元素 —— `1px dashed rgba(255,255,255,.2)`、
				// `inset:0`、`position:absolute`、`border-radius:28px`。
				// 它同时把圆角从 16px 覆盖成 28px（视觉上更圆）。
				// 参考实现输入卡**无边框**、圆角 16px ⇒ 必须显式清掉这个伪元素。
				'border:0!important;border-radius:16px!important;' +
				'margin:0 16px 17px!important;box-shadow:none!important;' +
				// ★★ 2026-10-11 修复「加了文件就打不了字」（用户实测反馈）。
				//
				// ## 真因（就是下面这两行，实测数据在 evidence/batch16-composer.log）
				//
				//   曾把输入卡高度**钉死 98px** 并配 `overflow:hidden`（当时为的是精确复刻
				//   参考实现 98px 的输入卡）。但官方在卡内还有一个**附件区**：
				//       `[data-slot="conversation.input.attachments"]`（实测 `display:contents`）
				//   一旦放入文件，附件区就会撑高整卡 —— 而 98px + `overflow:hidden`
				//   把它**裁掉**，并把输入区（`[data-input-scroll]`，`flex:1 1 auto`）
				//   压到 0 高度 ⇒ **打不了字**。这正是用户报的现象。
				//
				// ## 修法（采纳用户建议之一：「文件放在输入框上面」+ 让卡片长高）
				//
				//   · 高度改 **自适应**（`min-height:98px` 而非 `height:98px`），
				//     附件区有内容时卡片自然长高，输入区始终保有可用高度；
				//   · 去掉 `overflow:hidden`（否则附件仍会被裁）；
				//   · 显式让附件区**排在最上面**并占满宽度（用户建议 1）。
				//
				// ## 代价（如实记录）
				//   空会话时卡片仍是 98px（`min-height` 生效），与参考实现一致；
				//   但**带附件时会高于 98px** —— 这是必要的功能取舍，
				//   尺寸精确性让位于"能打字 + 能看到文件"。
				'min-height:98px!important;height:auto!important;' +
				'box-sizing:border-box!important;' +
				'display:flex!important;flex-direction:column!important;gap:8px!important;' +
				'padding:6px 8px!important;' +
				'max-height:60vh!important;overflow:visible!important}',
			// 官方 `::after` 虚线框（`1px dashed rgba(255,255,255,.2)`）必须显式清掉，
			// `border:0` 清不掉它（见上）。
			'html[data-dsh-mini] [data-composer-card]::after{' +
				'content:none!important;border:0!important;background:none!important}',
			// ★ 附件区：排在最上（用户建议 1「文件放在输入框上面」），占满宽度，
			//   自身可滚动（用户建议 2「把输入框做成可以滚动的」）⇒ 多个文件也不挤爆卡片。
			'html[data-dsh-mini] [data-slot="conversation.input.attachments"]{' +
				'order:-1!important;flex:0 0 auto!important;width:100%!important;' +
				'max-height:35vh!important;overflow-y:auto!important;overflow-x:hidden!important}',
			// 输入区必须**始终保有可用高度**：`flex:1 1 auto` + `min-height` 兜底。
			// 留痕：曾写 `min-height:0`，那会让它在空间不足时被压成 0 ⇒ 打不了字。
			'html[data-dsh-mini] [data-input-scroll]{' +
				'flex:1 1 auto!important;min-height:36px!important;height:auto!important;overflow-y:auto!important}',
			'html[data-dsh-mini] [data-composer-input]{' +
				'font-size:13px!important;min-height:0!important;height:auto!important;padding:6px 8px 0 14px!important}',
			// ★ 动作行（+ / 模型 / 发送）不得被压缩：它是 fixed-height 控件行。
			'html[data-dsh-mini] [data-composer-card] > :last-child{' +
				'flex:0 0 auto!important;min-height:42px!important}',

			// ---- 让出输入卡占位，避免最后一条消息被压住 ----
			//
			// ★★ 2026-10-11 修复「顶部页签行被顶栏压住」（用户实测反馈 + 截图）。
			//
			// ## 真因（会话态实测数据，非推断；证据 evidence/batch15-ancestors.log）
			//
			//   官方**对话头**实测占据 **y 0..76**，里面是两行：
			//     · 会话标题   y 10..40
			//     · **页签行**（对话/轨迹/上下文/记忆/白板看板） y **50..75**
			//   Companion 顶栏覆盖 **y 0..55** ⇒ 页签行**被压住 5px（下半截）**，
			//   正文第一行也会被切；用户截图正是此现象。
			//
			// ## 踩过的坑（重要，别再犯）
			//
			//   ① 先给 `[data-conversation-scroll]` 加 `padding-top:55px` —— **无效**：
			//      那只推「滚动内容」，推不动 header。
			//   ② 再给 `[data-slot="conversation.header"]` 加 padding —— **仍无效**：
			//      实测该元素 **`display: contents`**（只是一个 slot 包装，**不产生盒子**），
			//      而 `display:contents` 的元素上 **padding/margin 一律不生效**。
			//      ⚠️ 计算样式里 `paddingTop` 会**如实显示 55px**（值被接受但无布局效果）
			//      ⇒ 只看 computed style 会误判"已修复"，必须看 **getBoundingClientRect**。
			//
			// ## 正解
			//
			//   加在**真正参与布局的那个 header 盒子上**：实测 `header[data-window-drag="true"]`
			//   （`display:grid`、rect 520×76@(0,0)、自带 padTop 10px）。
			//   用**实测存在的属性** `data-window-drag` 定位（该属性同时是官方"窗口拖拽区"标记，
			//   语义稳定），不依赖 hash 类名。
			//
			// ★★ 2026-10-12 修正：**这条规则曾是双重让位，白吃 45px —— 现在删掉。**
			//
			// ## 用户反馈
			//   「还是有一个问题，就是现在上面的 banner 占了特别多的空间」
			//   （截图里顶栏与标题行之间**一大块纯空白**）
			//
			// ## 实测真因（`probe/padding-control.cjs`，三组对照，同一窗口）
			//
			//   | 组 | 状态 | 内容顶部 | 可用高 |
			//   |---|---|---|---|
			//   | A | 原样 | **176px** | 560px（82.2%） |
			//   | B | `header` padding 归零 | **131px** | 605px（88.8%） |
			//   | C | **摘掉全部小窗 CSS** | **131px** | 605px（88.8%） |
			//
			//   **B 与 C 完全一致** ⇒ 我们的 CSS 净效果就是**多占 45px**。
			//
			//   定位到两处独立的"让位"叠加：
			//   ```
			//   body   paddingTop = 55px    ← 让位 #1（批次28 为固定顶栏加的）
			//   header paddingTop = 55px    ← 让位 #2（本规则，批次15 加的）
			//   ```
			//   `header` 实测 **`position: static`**（不是 fixed）⇒ **body 的 padding 已经把它推下来了**，
			//   本规则等于**在已经让位过的元素上再让一次** ⇒ 顶栏与标题行之间多出 54px 纯空白。
			//
			// ## 为什么批次15 当时是对的、现在不对
			//   批次15 的真问题是"页签行被顶栏压住"，当时**还没有** body 让位 ⇒ 给 header 加 padding 正确。
			//   批次28 加了 body 让位后，这条就变成多余了 —— **两次修复各自正确，叠加起来出错**。
			//
			// ## 保留原生 padding，不要归零
			//   DSH 原生 `header` 自带 `padding-top: 10px` ⇒ 交给它即可。
			//   实测（C 组）标题行落在 y=65，**顶栏底 = 56 ⇒ 不重叠**，且留 9px 呼吸。
			//   ⚠️ 别再写 `padding-top:0!important` —— 那会把原生呼吸也抹掉（B 组标题行顶到 y=55）。
			//
			// ## 可复算判据（`probe/mini-geometry-check.mjs`）
			//   · `[data-conversation-scroll].y` 必须 **≤ 135**（修复前 176）
			//   · 页签行 `coveredByTopbarPx` 必须 **= 0**
			//   · `header` computed `paddingTop` 必须 **= 10px**（原生值，未被我们覆盖）

			// ★ 滚动内容**不需要**再单独让位 —— 这是实测结论，不是推断。
			//
			// 留痕（这里绕过一次弯，别再改回去）：
			//   · header 让位 55px 后，它自己被推到 y 55..176；
			//   · 而**滚动容器是 header 的兄弟/后继**，实测随之落在 **y=121..720**
			//     （见 evidence/batch15-polish4.log 之后的复测：`滚动容器 y=121`）；
			//   · 121 > 55 ⇒ 内容**本来就在顶栏之下**，再加 55px 会变成双重让位，
			//     把首条消息白白推到 y≈176，浪费一整块空白。
			//
			// ⚠️ 曾一度测到"正文从 y=3 开始" ⇒ 那是**修 header 之前**的状态，
			//    当时的正确判据对象是 header，不是滚动容器。改判据时务必确认测量时机。
			//
			// 只保留底部让位：输入卡是 absolute 贴底的，会盖住最后一条消息。
			'html[data-dsh-mini] [data-conversation-scroll]{' +
				'padding-top:0!important;padding-bottom:130px!important}',

			// ★ 输入卡距卡片底 17px（参考实现实测），但实测多出 32px —— 来自这一层的
			//   `padding-bottom:32px`（`div.Dc7zOa_composerStack.Dc7zOa_composerHero`，
			//   实测 `pad=0px 0px 32px`、`h=175px`、box 400×207@(60,423) bottom=630）。
			//   类名是 hash，不可引用；改用「座位内、包含输入卡的所有祖先」把纵向内边距清零
			//   —— 每个命中项都是输入卡的祖先，收敛它们是精确的、不会误伤别处。
			//   改后：49px（=17 margin + 32 padding）→ 17px。
			'html[data-dsh-mini] [data-composer-seat] :has([data-composer-card]){' +
				'padding-bottom:0!important}',
			// 输入卡必须贴卡片底：座位本身已是 absolute 贴底（实测底边 630 = 卡片底）
			'html[data-dsh-mini] [data-composer-seat]{' +
				'display:flex!important;flex-direction:column!important;' +
				'justify-content:flex-end!important}',

			// ---- 滚动条：细 6px（参考小窗全图无滚动条痕迹） ----
			'html[data-dsh-mini] ::-webkit-scrollbar{width:6px!important;height:6px!important}',
			'html[data-dsh-mini] ::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16)!important;border-radius:3px!important}',
			'html[data-dsh-mini] ::-webkit-scrollbar-track{background:transparent!important}',
		].join('\n');

		/** `<style>` 的 id —— 幂等注入用（重复 apply 不会叠加多份）。 */
		const STYLE_ID = 'dsh-mini-window.style';

		/**
		 * 幂等注入 `MINI_CSS`。
		 *
		 * 为什么用 `<style>` 而不是 `html.style.setProperty`：后者只能设变量，
		 * 无法表达「隐藏某元素 / 改几何」这类规则 —— 这正是此前的缺口。
		 */
		function injectMiniStyle() {
			try {
				const doc = document;
				if (!doc || !doc.head || typeof doc.createElement !== 'function') return false;
				const existing = doc.getElementById(STYLE_ID);
				if (existing) {
					existing.textContent = MINI_CSS;
					return true;
				}
				const el = doc.createElement('style');
				el.id = STYLE_ID;
				el.textContent = MINI_CSS;
				doc.head.appendChild(el);
				return true;
			} catch {
				return false;
			}
		}

		/**
		 * mini 模式下的外壳样式注入。
		 *
		 * 做两件事（缺一不可）：
		 *   ① 给 `<html>` 打 `data-dsh-mini="1"` + 暴露 4 个实测规格变量（供小窗宿主复用）
		 *   ② **真的注入样式表** —— 这一步此前缺失，导致「mini 模式对视觉零影响」
		 *      （8 项计算样式差异 0/8，见 MINI_CSS 的注释与 evidence/batch8-mini-visual-diff.log）
		 *
		 * 纪律：全部规则挂在 `html[data-dsh-mini]` 下 ⇒ 不带参数时**零影响**，不误伤主界面。
		 */
		function applyMiniShell() {
			try {
				const html = document.documentElement;
				if (!html || !html.setAttribute) return false;
				html.setAttribute('data-dsh-mini', MINI_VALUE);
				// 把参考实现实测到的关键几何/配色暴露成 CSS 变量，供样式表与宿主复用
				html.style.setProperty('--dsh-mini-topbar', `${SPEC.topbar}px`);
				html.style.setProperty('--dsh-mini-panel', SPEC.panel);
				html.style.setProperty('--dsh-mini-composer', SPEC.composer);
				html.style.setProperty('--dsh-mini-divider', SPEC.divider);
				// 实测规格里的圆角（参考实现：面板 ≈20px、输入卡 16px）
				// ★ 面板圆角是**标定后的实测值 20px**，见样式表里的标定留痕。
				//   ⚠️ 必须与 MINI_CSS 的 fallback 保持一致：变量在 html 行内样式上，
				//   优先级高于样式表里的 fallback —— 只改一处不生效（实测踩过：
				//   probe/radius-experiment.cjs 里改了 fallback，computed radius 仍是 12px）。
				html.style.setProperty('--dsh-mini-radius-panel', '20px');
				html.style.setProperty('--dsh-mini-radius-composer', '16px');
				// ★ 画布 = **透明**（2026-10-11 修正）。
				//   曾设为 '#000000' —— 那是把「透明区被合成后的底色」误当成"要涂的黑"，
				//   导致小窗外面出现一圈真黑边。参考实现是透明窗，这里必须透明。
				html.style.setProperty('--dsh-mini-canvas', 'transparent');
				// ★ 关键：真正注入样式表
				injectMiniStyle();
				// ★★ 2026-10-11 批次22：在小窗里画 companion 同款的 **55px 顶栏**
				//   （用户要求「把那个 electron 包里面的实现方法和那些展示的界面直接搬过来」）
				mountMiniTopbar();
				return true;
			} catch {
				return false;
			}
		}

		/** 顶栏节点 id（companion 同款界面的容器）。 */
		const TOPBAR_ID = 'dsh-mini-window-topbar';

		/**
		 * ★★ 在小窗里挂 companion 同款的顶栏（批次22「搬界面」的核心）。
		 *
		 * ## 界面来源（照抄 companion/renderer/panel.html:266-290，非自创）
		 *
		 *   | 按钮 | companion 原语义 | 本插件实现 |
		 *   |---|---|---|
		 *   | T1 最小化 | `minimize()` | host 路由 `minimize` |
		 *   | T2 置顶 | 已置顶/取消 | host 路由 `pin`（**用户要求可切换**） |
		 *   | T3 侧栏 | 转发官方开关 | `ctx.layout.toggleSidebar()` |
		 *   | T7 紧凑浮窗 | 400×420 | host 路由 `compact` |
		 *   | T8 更多 | 展开菜单 | 展开下方菜单（缩放/重载/回主界面/关闭） |
		 *
		 * ## 为什么 host 不可用时也要画
		 *
		 *   顶栏是**小窗模式的一部分**：即使 host 路由不可用（纯浏览器环境），
		 *   顶栏里的 T1/T2/T7 会灰掉，但 T3/T8 仍可用（侧栏开关与前端的"更多"）
		 *   —— 比"完全没有顶栏"更接近用户要的效果。
		 */
		function mountMiniTopbar() {
			try {
				const doc = globalThis.document;
				if (!doc || !doc.body) return false;
				if (doc.getElementById(TOPBAR_ID)) return true;   // 幂等
				const bar = doc.createElement('div');
				bar.id = TOPBAR_ID;
				bar.setAttribute('role', 'toolbar');
				bar.setAttribute('aria-label', 'DSH 小窗工具栏');

				/** 造一个图标按钮（内联 SVG，不引用外部图片 —— 交付物零外部依赖）。 */
				function mkBtn(id, title, svg, onClick) {
					const b = doc.createElement('button');
					b.type = 'button';
					b.id = id;
					b.title = title;
					b.setAttribute('aria-label', title);
					b.innerHTML = svg;
					b.addEventListener('click', function (ev) {
						try { ev.preventDefault(); ev.stopPropagation(); } catch { /* noop */ }
						try { onClick(); } catch { /* 按钮失败绝不影响页面 */ }
					});
					return b;
				}

				// 与 companion 完全同款的 5 个图标（path 直接照抄）
				const I_MIN = '<svg viewBox="0 0 16 16"><path d="M1 8h14"/></svg>';
				const I_PIN = '<svg viewBox="0 0 16 16"><path d="M5 2h6l-1 4.5L14 9.5v1H2v-1l4-3L5 2z"/><path d="M8 10.5V15.5"/></svg>';
				const I_SIDE = '<svg viewBox="0 0 16 16"><rect x="0.8" y="1.5" width="14.4" height="13" rx="2.5"/><path d="M10.5 1.5v13"/></svg>';
				const I_COMPACT = '<svg viewBox="0 0 16 16"><rect x="0.8" y="1.5" width="14.4" height="13" rx="2.5"/><rect x="8" y="7.5" width="6" height="5.5" rx="1"/><path d="M3.5 7.5l3-3M3.5 4.5h3v3"/></svg>';
				const I_MORE = '<svg viewBox="0 0 16 16"><circle cx="2" cy="5" r="2.2" style="fill:currentColor;stroke:none"/><circle cx="2" cy="11" r="2.2" style="fill:currentColor;stroke:none"/><path d="M6.2 5h8.8M6.2 11h8.8"/></svg>';

				const t1 = mkBtn(TOPBAR_ID + '-min', '最小化', I_MIN, async () => { await callHostWindow('minimize'); });
				const t2 = mkBtn(TOPBAR_ID + '-pin', hostWindowPinned ? '已置顶（点击取消）' : '未置顶（点击置顶）', I_PIN, async () => {
					const r = await callHostWindow('pin');
					if (r && typeof r.pinned === 'boolean') {
						hostWindowPinned = r.pinned;
						t2.classList.toggle('active', hostWindowPinned);
						t2.title = hostWindowPinned ? '已置顶（点击取消）' : '未置顶（点击置顶）';
						t2.setAttribute('aria-pressed', String(hostWindowPinned));
					}
				});
				const t3 = mkBtn(TOPBAR_ID + '-side', '打开侧栏', I_SIDE, () => { openSidebarViaCtx(); });
				const spacer = doc.createElement('span');
				spacer.className = 'dsh-mini-topbar-spacer';
				const t7 = mkBtn(TOPBAR_ID + '-compact', '紧凑浮窗', I_COMPACT, async () => { await callHostWindow('compact'); });
				const t8 = mkBtn(TOPBAR_ID + '-more', '更多', I_MORE, () => { toggleMiniMenu(); });

				if (hostWindowPinned) {
					t2.classList.add('active');
					t2.setAttribute('aria-pressed', 'true');
				}
				bar.appendChild(t1);
				bar.appendChild(t2);
				bar.appendChild(t3);
				bar.appendChild(spacer);
				bar.appendChild(t7);
				bar.appendChild(t8);
				doc.body.appendChild(bar);

				// 顶栏占位：55px（与 companion 的 --topbar-h 一致）
				// ★ 用 padding-top 而不是 margin —— 让页面内容整体下移，不产生重叠
				try {
					doc.documentElement.style.setProperty('--dsh-mini-topbar', String(SPEC.topbar) + 'px');
					doc.body.style.paddingTop = String(SPEC.topbar) + 'px';
				} catch { /* noop */ }

				// 初始同步一次真实状态（host 不可用则保持默认）
				callHostWindow('state').then((r) => {
					if (r && typeof r.open === 'boolean') hostWindowOpen = r.open;
					if (r && typeof r.pinned === 'boolean') {
						hostWindowPinned = r.pinned;
						try {
							t2.classList.toggle('active', hostWindowPinned);
							t2.title = hostWindowPinned ? '已置顶（点击取消）' : '未置顶（点击置顶）';
						} catch { /* noop */ }
					}
				}).catch(() => {});

				injectTopbarStyle();
				return true;
			} catch {
				// 顶栏只是装饰 ⇒ 失败绝不能影响小窗本体（批次19 纪律）
				return false;
			}
		}

		/**
		 * T3 打开侧栏 —— **转发给官方开关**（不是自己切状态）。
		 *
		 * ★ 为什么必须转发（2026-10-11 实测踩过的坑）：
		 *   官方侧栏的展开/收起由它自己的状态机管；自己改 CSS 会导致
		 *   "展开了但容器仍是 display:none ⇒ 用户观感按了没反应"。
		 *   正确做法：点官方那个 `[data-dsh-responsive-part="sidebar-toggle"]`。
		 *   实测：转发后侧栏宽度 0 → 321（evidence/batch11-defects.log）。
		 *
		 * 顺序：优先用 `ctx.layout.toggleSidebar()`（官方服务，最干净）；
		 * 该服务不存在时**退回真点 DOM 开关**（两条路都留，避免"半修"）。
		 */
		function openSidebarViaCtx() {
			try {
				// ① 官方服务（若可用）
				const layout = layoutRef;
				if (layout && typeof layout.toggleSidebar === 'function') {
					try { layout.toggleSidebar(); return true; } catch { /* 退回 DOM */ }
				}
				// ② 退回：真点官方开关（React 受控组件也能响应 el.click()）
				const doc = globalThis.document;
				if (!doc) return false;
				const el = doc.querySelector('[data-dsh-responsive-part="sidebar-toggle"]');
				if (el && typeof el.click === 'function') { el.click(); return true; }
				return false;
			} catch {
				return false;
			}
		}

		/** `ctx.layout` 引用（由 apply 注入；用于侧栏开关等官方能力）。 */
		let layoutRef = null;

		/** 「更多」菜单 id。 */
		const MENU_ID = TOPBAR_ID + '-menu';

		/**
		 * T8 展开/收起「更多」菜单（照抄 companion 的 #menu 内容）。
		 *
		 * companion 的菜单有 4 项：界面缩放（−/百分比/＋）、重新加载、回到 DSH 主界面、关闭小窗。
		 * 本插件同样实现这 4 项 ——
		 *   · 界面缩放：改 `document.documentElement.style.zoom`（前端唯一能做到的"真缩放"）
		 *   · 重新加载：`location.reload()`
		 *   · 回到主界面：关掉小窗（主窗口本来就在）
		 *   · 关闭小窗：调 host 路由 `close`
		 */
		function toggleMiniMenu() {
			try {
				const doc = globalThis.document;
				if (!doc) return false;
				const exist = doc.getElementById(MENU_ID);
				if (exist && exist.parentNode) { exist.parentNode.removeChild(exist); return false; }
				const menu = doc.createElement('div');
				menu.id = MENU_ID;
				menu.setAttribute('role', 'menu');

				/** 一行按钮。 */
				function row(id, label, fn) {
					const b = doc.createElement('button');
					b.type = 'button';
					b.id = id;
					b.setAttribute('role', 'menuitem');
					b.textContent = label;
					b.addEventListener('click', function (ev) {
						try { ev.preventDefault(); ev.stopPropagation(); } catch { /* noop */ }
						try { fn(); } catch { /* noop */ }
					});
					return b;
				}

				// ── 界面缩放（companion 的 #zoom-out / #zoom-val / #zoom-in）
				let z = 100;
				try { z = Math.round((Number(globalThis.__dshMiniZoom) || 1) * 100); } catch { /* noop */ }
				const zoomRow = doc.createElement('div');
				zoomRow.className = 'dsh-mini-menu-row';
				const zLabel = doc.createElement('span');
				zLabel.textContent = '界面缩放';
				const zSteps = doc.createElement('span');
				zSteps.className = 'dsh-mini-menu-steps';
				const zVal = doc.createElement('span');
				zVal.className = 'dsh-mini-menu-val';
				zVal.textContent = z + '%';
				/**
				 * 应用缩放（clamp 到 60%~200%，与 companion 的档位范围一致）。
				 *
				 * ★ 2026-10-11 修正的真缺陷：原实现是
				 *     `applyZoom(z - 10)` / `applyZoom(z + 10)`
				 *   但 `z` 是**闭包快照、从不更新** ⇒ 每次点击都以初始值为基准：
				 *     初始 100 → 点放大 = 110 → 再点缩小 = 100-10 = **90**（不是 100）。
				 *   验收实测：放大得 1.1，缩小得 0.9（期望 1.0）⇒ 抓出来了。
				 *   ⇒ 改为**状态放一个可变变量**，每次读写它。
				 */
				let zoomPct = z;
				function applyZoom(next) {
					const v = Math.max(60, Math.min(200, next));
					zoomPct = v;
					globalThis.__dshMiniZoom = v / 100;
					try { doc.documentElement.style.zoom = String(v / 100); } catch { /* 环境不支持 */ }
					zVal.textContent = v + '%';
				}
				const zOut = doc.createElement('button');
				zOut.type = 'button';
				zOut.id = MENU_ID + '-zoom-out';
				zOut.title = '缩小';
				zOut.textContent = '−';
				zOut.addEventListener('click', function (ev) { try { ev.stopPropagation(); } catch { /* noop */ } applyZoom(zoomPct - 10); });
				const zIn = doc.createElement('button');
				zIn.type = 'button';
				zIn.id = MENU_ID + '-zoom-in';
				zIn.title = '放大';
				zIn.textContent = '＋';
				zIn.addEventListener('click', function (ev) { try { ev.stopPropagation(); } catch { /* noop */ } applyZoom(zoomPct + 10); });
				zSteps.appendChild(zOut);
				zSteps.appendChild(zVal);
				zSteps.appendChild(zIn);
				zoomRow.appendChild(zLabel);
				zoomRow.appendChild(zSteps);
				menu.appendChild(zoomRow);

				const sep = doc.createElement('div');
				sep.className = 'dsh-mini-menu-sep';
				menu.appendChild(sep);

				menu.appendChild(row(MENU_ID + '-reload', '重新加载', () => {
					try { globalThis.location.reload(); } catch { /* noop */ }
				}));
				menu.appendChild(row(MENU_ID + '-main', '回到 DSH 主界面', async () => {
					await callHostWindow('close');
				}));
				menu.appendChild(row(MENU_ID + '-close', '关闭小窗', async () => {
					await callHostWindow('close');
				}));

				doc.body.appendChild(menu);
				injectMenuStyle();
				return true;
			} catch {
				return false;
			}
		}

		/** 「更多」菜单样式（照抄 companion #menu 的观感）。 */
		const MENU_CSS = [
			'#' + MENU_ID + '{position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483300;',
			'background:var(--dsh-mini-panel,#232528);color:var(--dsh-mini-fg,#e8e8e8);',
			'border:1px solid var(--dsh-mini-divider,rgba(255,255,255,.10));border-radius:10px;',
			'box-shadow:0 12px 32px rgba(0,0,0,.5);padding:6px;font:13px/1.5 system-ui,sans-serif}',
			'#' + MENU_ID + ' button{display:block;width:100%;text-align:left;border:0;border-radius:6px;',
			'background:transparent;color:inherit;padding:8px 10px;cursor:pointer;font:inherit}',
			'#' + MENU_ID + ' button:hover{background:rgba(255,255,255,.10)}',
			'.dsh-mini-menu-row{display:flex;align-items:center;justify-content:space-between;padding:6px 10px}',
			'.dsh-mini-menu-steps{display:flex;align-items:center;gap:6px}',
			'.dsh-mini-menu-steps button{width:24px!important;height:24px!important;padding:0!important;',
			'text-align:center!important;background:rgba(255,255,255,.08)!important}',
			'.dsh-mini-menu-val{min-width:44px;text-align:center;font-variant-numeric:tabular-nums}',
			'.dsh-mini-menu-sep{height:1px;background:rgba(255,255,255,.10);margin:6px 4px}',
		].join('');

		/** 幂等注入菜单样式。 */
		function injectMenuStyle() {
			try {
				const doc = globalThis.document;
				const id = MENU_ID + '-style';
				if (!doc || doc.getElementById(id)) return false;
				const s = doc.createElement('style');
				s.id = id;
				s.textContent = MENU_CSS;
				(doc.head || doc.documentElement).appendChild(s);
				return true;
			} catch {
				return false;
			}
		}

		/** 顶栏样式（照抄 companion panel.html 的 #topbar/.tb 规格）。 */		const TOPBAR_CSS = [
			'#' + TOPBAR_ID + '{position:fixed;left:0;right:0;top:0;height:var(--dsh-mini-topbar,55px);',
			'background:var(--dsh-mini-panel,#232528);border-bottom:1px solid var(--dsh-mini-divider,rgba(255,255,255,.08));',
			'z-index:2147483200;user-select:none;display:flex;align-items:center;gap:2px;padding:0 6px;',
			'-webkit-app-region:drag}',
			'#' + TOPBAR_ID + ' button{-webkit-app-region:no-drag;width:28px;height:28px;border:0;border-radius:6px;',
			'background:transparent;color:var(--dsh-mini-fg,#e8e8e8);display:flex;align-items:center;',
			'justify-content:center;cursor:pointer;padding:0;font:inherit}',
			'#' + TOPBAR_ID + ' button:hover{background:rgba(255,255,255,.10)}',
			'#' + TOPBAR_ID + ' button.active{background:rgba(255,255,255,.14)}',
			'#' + TOPBAR_ID + ' svg{width:16px;height:16px;fill:none;stroke:currentColor;',
			'stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}',
			'.dsh-mini-topbar-spacer{flex:1 1 auto}',
		].join('');

		/** 幂等注入顶栏样式。 */
		function injectTopbarStyle() {
			try {
				const doc = globalThis.document;
				const id = TOPBAR_ID + '-style';
				if (!doc || doc.getElementById(id)) return false;
				const s = doc.createElement('style');
				s.id = id;
				s.textContent = TOPBAR_CSS;
				(doc.head || doc.documentElement).appendChild(s);
				return true;
			} catch {
				return false;
			}
		}

		/**
		 * 调试角标：mini 模式下在右下角显示一个极小的标记。
		 *
		 * ## ★ 2026-10-11 改为**默认不显示**（逐像素比对抓出的差异）
		 *
		 * 此前 mini 模式一律显示它，目的是让「mini 模式确实生效了」肉眼可验。
		 * 但参考小窗的 18 个元素里**没有这个角标**，且它落在卡片之外的黑色画布上 ——
		 * 逐像素比对实测（`evidence/batch10-final-detail.log`）：
		 *   右下角 (440-520, 660-720) 区域，参考实现非黑像素 **0** 个，实测 **420** 个
		 *   （包围盒 x 454–509 / y 688–709）。
		 * 复刻参考实现就不该有它。改成**只有带 `?dsh-mini-debug=1` 才显示**：
		 * 保留「肉眼可验 mini 是否生效」的调试能力，成品版面与参考实现一致。
		 *
		 * ⚠️ **children 必须写在 props 里，不能当第三参传**（2026-10-11 真宿主像素取证抓到的真缺陷）。
		 *
		 * React **自动运行时**（`react/jsx-runtime` 的 `jsx`/`jsxs`，区别于 classic 的
		 * `createElement`）签名是 **`jsx(type, config, maybeKey)`** —— 第三参是 **key**，
		 * 不是 children。官方实现（react@19 `cjs/react-jsx-runtime.production.js`）：
		 *
		 *     function jsxProd(type, config, maybeKey) {
		 *       var key = null;
		 *       void 0 !== maybeKey && (key = "" + maybeKey);   // ← 第三个参数被当成 key
		 *       ...
		 *       props: maybeKey                                 // props 来自 config
		 *     }
		 *
		 * 曾经写成 `jsx('div', {...}, '小窗模式')` ⇒ 文本被当 key 吞掉、`props.children`
		 * 从未设置 ⇒ 渲染出**零子节点的空框**（真宿主实测 16×8px，内容尺寸 0×0：
		 * 16×8 恰好等于 padding 3/7 + border 1，即内容严格为 0）。
		 * 症状极隐蔽：元素存在、样式正确、角标断言 `badge === true` 依旧通过。
		 */
		function MiniBadge() {
			if (!isMiniMode() || !isMiniDebug()) return null;
			return react_jsx_runtime.jsx('div', {
				'data-dsh-mini-badge': '1',
				children: '小窗模式',
				style: {
					position: 'fixed',
					right: '10px',
					bottom: '10px',
					zIndex: 2147483647,
					padding: '3px 7px',
					borderRadius: '6px',
					fontSize: '10px',
					lineHeight: '1.4',
					fontFamily: 'system-ui, sans-serif',
					background: 'rgba(0,0,0,.62)',
					color: '#fff',
					border: `1px solid ${SPEC.divider}`,
					pointerEvents: 'none',   // click-through：绝不挡交互
					userSelect: 'none',
				},
			});
		}

		/** 必需服务：UI slot 注册表。 */
		const inject = ['slots'];

		// ==================================================================
		// 悬浮球 + 文档画中画小窗（**零下载方案**）
		// ==================================================================
		//
		// ## 为什么内联在这里（而不是单独一个模块文件）
		//
		// 实测契约：factory 收到的 `require` **只解析**「平台种子表 → 已记忆记录 →
		// 启动图 row → 已注册 factory」，**不含相对路径**。所以 `require('./ball.cjs')`
		// 在浏览器侧**解析不到**。这正是本项目「免构建」契约的代价 —— 想要多文件
		// 就得有构建步骤。为保住免构建，这里内联。
		//
		// ## 为什么不用 Electron companion（原方案）
		//
		// 原方案让用户**下载 151.0 MB**、**占盘 380.6 MB**，而我们自己的源码只有
		// 0.21 MB。实测浏览器自带能力已足够：
		//   · 悬浮球 = 一个 position:fixed 的 DOM 元素（本机 @linxin666/dsh-desktop-launcher
		//     的 floating button 就是这么做的，装上就有、零 Electron）
		//   · 真·系统置顶小窗 = Document Picture-in-Picture API
		//     （实测本机渲染进程 `typeof documentPictureInPicture === 'object'`
		//      且 requestWindow 是函数；Chromium 152）
		//
		// ## 能力边界（诚实说明）
		//
		//   · 悬浮球**在页面内**，不能拖出浏览器窗口
		//   · PiP 小窗是**真·操作系统窗口、系统置顶**，可拖到屏幕任意位置
		//   · 但 PiP **位置由系统管**（只记大小，不记位置）；无托盘；宿主页关了就没了
		//   · 需要「浏览器关了球还在」才需要可选的 Electron 增强
		// ==================================================================

		/**
		 * 悬浮球 DOM id（幂等判据）。
		 *
		 * ⚠️ **id 里绝不能含 `.`** —— 实测踩过，这是本批次的**真缺陷**：
		 *   原写 `'dsh-mini-window.ball'`，而 CSS 选择器 `#dsh-mini-window.ball` 里的
		 *   点号是**class 分隔符** ⇒ 该选择器意为「id=dsh-mini-window **且** class=ball」，
		 *   与元素的实际 id `dsh-mini-window.ball` **不相同** ⇒ **规则一条都不匹配**。
		 *
		 *   症状极隐蔽（真人实测驱动才暴露）：
		 *     · `getElementById('dsh-mini-window.ball')` **仍能找到**节点 ⇒ 探针报「球存在」
		 *     · 但 `getComputedStyle` 出来 `position:static`、圆角 0、背景透明
		 *     · 页面上是个**裸 div**（884×25 的文字块），不是 44×44 的圆
		 *   ⇒ 改用连字符 `-` 分隔，选择器与 id 再无歧义。
		 */
		const BALL_ID = 'dsh-mini-window-ball';
		/** 悬浮球样式表 id（只被 getElementById 用、不参与 CSS 选择器；为命名一致也改连字符）。 */
		const BALL_STYLE_ID = 'dsh-mini-window-ball-style';
		/**
		 * 球位置记忆键。
		 * ⚠️ 这是 **localStorage 键**，不是 CSS 选择器，含点号无妨（保留原值以免用户已存的位置失效）。
		 */
		const BALL_POS_KEY = 'dsh-mini-window.ball-pos';
		/** 球直径。 */
		const BALL_SIZE = 44;
		/** 球距边缘留白。 */
		const BALL_MARGIN = 16;
		/** PiP 小窗默认尺寸。 */
		const PIP_W = 420;
		const PIP_H = 640;

		/**
		 * 悬浮球样式。
		 *
		 * ★ 2026-10-11 用户实测反馈修正：**球不再依赖 mini 模式**。
		 *   原设计把球挂在 `html[data-dsh-mini]` 下、且只在 `?dsh-mini=1` 时创建
		 *   ⇒ 用户在自己的 DSH 主界面（不带参数）**根本看不到球**，
		 *     只有在 Companion 小窗（它加载的正是 `?dsh-mini=1`）里才看得到。
		 *   而「点球弹出置顶小窗」这个功能本来就是给主界面用的
		 *   —— 必须先进入小窗模式才能开小窗，是**逻辑闭环错误**。
		 *
		 *   现在：球在**任何页面**都挂载（只要插件加载），选择器用独立的
		 *   `#dsh-mini-window-ball`，不再要求祖先带 `data-dsh-mini`。
		 *   mini 相关的外观规则仍挂在 `html[data-dsh-mini]` 下，不受影响。
		 */
		const BALL_CSS = [
			'#' + BALL_ID + '{',
			'position:fixed;width:' + BALL_SIZE + 'px;height:' + BALL_SIZE + 'px;',
			'border-radius:50%;z-index:2147483000;',
			'display:flex;align-items:center;justify-content:center;',
			'background:rgba(35,37,40,.92);',
			'border:1px solid rgba(255,255,255,.14);',
			'box-shadow:0 4px 16px rgba(0,0,0,.4);',
			'cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none;',
			'color:#fff;transition:transform .12s ease,background .12s ease}',
			'#' + BALL_ID + ':hover{background:rgba(48,51,55,.96);transform:scale(1.06)}',
			'#' + BALL_ID + '[data-dragging="true"]{cursor:grabbing;transition:none;transform:scale(1.1)}',
			'#' + BALL_ID + ' svg{pointer-events:none;display:block}',
			// PiP 不可用时角上点一个小黄点（不靠文字打扰用户；title 里有说明）
			'#' + BALL_ID + '[data-pip="unsupported"]::after{',
			'content:"";position:absolute;right:0;bottom:0;width:9px;height:9px;',
			'border-radius:50%;background:#e0a020;border:1px solid rgba(0,0,0,.55)}',
		].join('');

		/**
		 * 球图标 —— 内联 SVG 自绘，**不依赖任何图片资源**（免打包、免版权）。
		 * 形状：小窗轮廓（圆角矩形 + 标题栏横线 + 左侧圆点）。
		 * @returns 图标标记。
		 */
		function ballIconSvg() {
			return [
				'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">',
				'<rect x="3" y="3.5" width="14" height="13" rx="2.5" stroke="currentColor" stroke-width="1.6"/>',
				'<path d="M3 8h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
				'<circle cx="5.6" cy="5.75" r=".9" fill="currentColor"/>',
				'</svg>',
			].join('');
		}

		/** 读记忆的球位置；失败或无记录返回 null。 */
		function readBallPos() {
			try {
				const raw = globalThis.localStorage && globalThis.localStorage.getItem(BALL_POS_KEY);
				if (!raw) return null;
				const o = JSON.parse(raw);
				if (!o || typeof o !== 'object') return null;
				const side = o.side === 'left' || o.side === 'right' ? o.side : null;
				const top = typeof o.top === 'number' && isFinite(o.top) ? o.top : null;
				return side && top !== null ? { side, top } : null;
			} catch { return null; }
		}

		/**
		 * 是否用 `?dsh-ball=0` 关闭了悬浮球。
		 *
		 * 独立成函数（而不是内联在 apply 里）有两个原因：
		 *   ① 守卫可以**真调用**它做断言（本项目纪律：不接受"源码含某字符串"这类恒真守卫）；
		 *   ② apply 里的每一段逻辑越短越好 —— 见 apply 顶部那段防御说明。
		 * @returns 需要关闭球时为 true。
		 */
		function isBallDisabled() {
			try {
				const g = typeof globalThis !== 'undefined' ? globalThis : undefined;
				const loc = g && g.location ? g.location : (typeof window !== 'undefined' ? window.location : undefined);
				const search = loc && loc.search;
				if (typeof search !== 'string') return false;
				return new URLSearchParams(search).get(BALL_PARAM) === '0';
			} catch { return false; }
		}

		/** 只记 side 与 top（水平方向永远吸附边缘，不记具体 x）。 */
		function saveBallPos(side, top) {
			try {
				if (globalThis.localStorage) {
					globalThis.localStorage.setItem(BALL_POS_KEY, JSON.stringify({ side, top: Math.round(top) }));
				}
			} catch { /* 存储不可用 ⇒ 位置不记，功能不受影响 */ }
		}

		/** 把 top 夹进视口。 */
		function clampBallTop(top) {
			const vh = globalThis.innerHeight || 800;
			const max = Math.max(BALL_MARGIN, vh - BALL_SIZE - BALL_MARGIN);
			return Math.min(Math.max(top, BALL_MARGIN), max);
		}

		/** 吸附到左/右边缘后的 left 值。 */
		function ballSideLeft(side) {
			const vw = globalThis.innerWidth || 1200;
			return side === 'left' ? BALL_MARGIN : Math.max(BALL_MARGIN, vw - BALL_SIZE - BALL_MARGIN);
		}

		/**
		 * Document PiP 是否可用。
		 *
		 * 判据要「对象存在 **且** requestWindow 是函数」—— 只判存在不够，
		 * 实测见过对象在、方法缺的情况。
		 */
		/**
		 * Document PiP 是否可用。
		 *
		 * ★ 2026-10-11 **两次**修正的教训（供后续别再犯）：
		 *
		 *   第一版只看 `typeof requestWindow === 'function'`
		 *     ⇒ 太宽：API 在但被策略拒时误判"可用"。
		 *   第二版加了 `featurePolicy.allowsFeature('document-picture-in-picture')`
		 *     ⇒ **错判据**。实测两份证据：
		 *         · 纯净 http 页：allowsFeature = **false**，requestWindow **RESOLVED（真开窗）**
		 *         · DSH 宿主页：allowsFeature = **false**，requestWindow **REJECTED**
		 *       **两者都是 false** ⇒ 该 API 无法区分"能用/不能用"，
		 *       拿它做判据会把**本来能用**的环境也一并禁掉（典型"用无效判据过度防御"）。
		 *
		 *   ⇒ 现在**只查 API 存在性**；真能不能开交给 `requestWindow()` 自己回答
		 *     （失败时 catch 再降级，代价仅一次异步调用）。
		 *
		 *   另一条同时确认的**根本限制**：无论 PiP 是否可用，
		 *   **它都不可能"拖出宿主应用之外"**（PiP 窗口是浏览器/Electron 的子窗口）。
		 *   用户明确要求「能拖离原来的软件」⇒ 该需求**只有原生窗口能满足**（见 README 的 L3/companion）。
		 *
		 * @returns API 存在时 true。
		 */
		function isPipAvailable() {
			try {
				const pip = globalThis.documentPictureInPicture;
				return !!pip && typeof pip.requestWindow === 'function';
			} catch { return false; }
		}

		/**
		 * 打开 PiP 小窗（L2）。
		 *
		 * ## 实现取舍：让 PiP 窗口**自己加载 URL**，而不是搬运当前 DOM
		 *
		 * 搬 DOM 进另一个 document 会让 React 合成事件失效（两套事件系统），
		 * 风险高且难调。改为 iframe 载入「带 ?dsh-mini=1 的当前地址」——
		 * 等价于「开个小窗看应用」，零兼容风险；代价是多一次本地加载。
		 *
		 * @returns 成功返回 PiP window；失败返回 null（调用方据此降级）。
		 */
		async function openPipWindow() {
			try {
				const pip = globalThis.documentPictureInPicture;
				if (!pip || typeof pip.requestWindow !== 'function') return null;
				const win = await pip.requestWindow({ width: PIP_W, height: PIP_H });
				if (!win || !win.document) return null;
				const doc = win.document;
				const url = globalThis.location ? globalThis.location.href : '';
				doc.body.innerHTML = '';
				doc.body.style.cssText = 'margin:0;padding:0;overflow:hidden;background:#000';
				const f = doc.createElement('iframe');
				f.src = url;
				f.setAttribute('allow', 'clipboard-write; microphone');
				f.style.cssText = 'border:0;width:100vw;height:100vh;display:block;background:#000';
				doc.body.appendChild(f);
				return win;
			} catch (e) {
				// 非用户手势触发 / 被策略禁用等都会 reject ⇒ 一律退化为 L1
				try { console.warn('[dsh-mini-window] PiP 打开失败，退化为页面内模式：', e && e.message); } catch { /* noop */ }
				return null;
			}
		}

		/**
		 * ★★ 开「真窗口」小窗 —— **本插件的主方案**（2026-10-11 用户需求驱动重排）。
		 *
		 * ## 为什么它必须是主方案
		 *
		 *   用户原话：「**小窗调出后…无法被拖离至原来的 Electron 应用之外**」
		 *            「**我在做小窗插件，要是小窗脱离不了原本的软件，那我做的是什么？**」
		 *   ⇒ **"能脱离宿主应用"是小窗的定义性需求**，不是加分项。
		 *
		 *   三种候选的判定：
		 *     · DOM 浮层      —— **物理上不可能**脱离（它就是页面里的一个 div）
		 *     · Document PiP  —— **已被本机 DSH 拒绝**（featurePolicy/策略）
		 *     · **`window.open`** —— **实测可行**（见下）
		 *
		 * ## 实测证据（在真宿主页面里，用 CDP 真实点击触发）
		 *
		 *   ```
		 *   window.open 返回了窗口对象，closed = false
		 *   Electron 主进程侧：窗口数 0 → 2，新增窗口 [2, 1]
		 *   ```
		 *   ⇒ `window.open` 由 Electron 壳开成了**真正的 BrowserWindow**：
		 *     可拖到应用外、可缩放、有系统关闭按钮，且**零额外下载**。
		 *
		 * ## 注意：不要复用同一个窗口名
		 *
		 *   用固定窗口名会让第二次点击"聚焦已有窗口"而不是开新窗；
		 *   这里**每次开新窗**并把引用存起来做 toggle（与 PiP 分支语义一致）。
		 *
		 * @returns 成功返回 window 对象；被拦截（返回 null）时返回 null。
		 */
		function openRealWindow() {
			try {
				// 已开着 ⇒ 再点关闭（toggle 语义）
				if (realWin && !realWin.closed) {
					try { realWin.close(); } catch { /* noop */ }
					realWin = null;
					wasRealWinOpen = true;   // 告知调用方：这是"刚关闭"，不是"开不出来"
					return null;
				}
				wasRealWinOpen = false;
				const g = globalThis;
				const url = g.location ? g.location.href : '';
				// 尺寸：贴近小窗形态（宽 440、高 680），并让系统提供缩放/关闭
				const feats = [
					'width=440', 'height=680',
					'left=' + Math.max(0, ((g.screen && g.screen.availWidth) || 1280) - 480),
					'top=' + Math.round(Math.max(0, (((g.screen && g.screen.availHeight) || 800) - 680) / 2)),
					'resizable=yes', 'scrollbars=yes',
					'menubar=no', 'toolbar=no', 'location=no', 'status=no',
				].join(',');
				const w = g.open(url, 'dsh_mini_' + Date.now(), feats);
				if (!w) return null;
				realWin = w;
				try {
					// 用户手动关掉时清引用，保证 toggle 语义正确
					w.addEventListener('pagehide', function () { realWin = null; });
				} catch { /* 跨源可能拿不到，忽略 */ }
				return w;
			} catch { return null; }
		}

		/**
		 * ★★★ 决定性取证结论（2026-10-11 用户实测点破，推翻了我前两批的判断）
		 *
		 * ## 用户原话（逐字）
		 *   「默认调起的是兜底形式，就是在页面里面的那种，并没有新建一个小窗口」
		 *   「之后一直卡在加载页面」
		 *
		 * ## 在**真 DSH 应用**里的实测（用户重启宿主后逐条验证）
		 *
		 *   进程结构：
		 *   ```
		 *   PID 60456  DeepSeek Harness.exe                ← Electron 主进程（真窗口能力在这里）
		 *     └─ 68420  --expose-internals .../dsh-desktop-host/lib/index.js
		 *               ↑ DSH 服务（拥有 19387）＝ **插件 host**，Node 模式
		 *   ```
		 *
		 *   | 尝试的路径 | 实测结果 |
		 *   |---|---|
		 *   | host 侧 `import('electron')` | ❌ **失败**（`GET /dsh-mini-window/probe` → `electron.ok=false`）——host 是 Node 子进程，不是 Electron |
		 *   | `window.open()` | ❌ **被拒**：真 DSH 的 7 处 `setWindowOpenHandler` **全部 `{action:"deny"}`** |
		 *   | `documentPictureInPicture` | ❌ 权限策略拒绝（且它本来也拖不出应用外） |
		 *   | `window.dshPlatform.open(page,bounds)` | ❌ 只接受 `"usage"`/`"top-up"`，不能装 DSH 界面 |
		 *   | 页面内 iframe 浮层 | ⚠️ 能显示，但 **iframe 载入 DSH 自身一直转圈**（自嵌受限），且**拖不出应用外** |
		 *
		 *   ⇒ **在真 DSH 里，浏览器侧没有任何办法开出"能拖出去的真窗口"。**
		 *     这是宿主的安全设计，不是 bug，改不了。
		 *
		 * ## 我前两批错在哪（必须留痕）
		 *
		 *   · 批次21 宣布"`window.open` 可用" —— 那个实验是在**另一个 Electron 实例**里做的
		 *     （用 companion 自带的 electron 加载 DSH 页面），**那个实例没有 DSH 主进程的
		 *     `setWindowOpenHandler`** ⇒ **环境不等价，结论无效**。
		 *   · 批次22 宣布"host 侧能 import electron" —— 只看到 app.asar 里有 `from "electron"`
		 *     （那是**主进程 60456** 的代码），没验证**插件 host（68420）**能否真 import。
		 *   ⇒ 教训：**验证必须跑在真实目标环境里**，否则一切"通过"都是假的。
		 *
		 * ## 所以：唯一能真正做到"独立小窗"的是 Companion
		 *
		 *   Companion 是**独立的 Electron 程序**，它自己就是主进程 ⇒ 能开真窗口、
		 *   能置顶、能拖出任何地方。代价是那 151 MB（用户已知情并接受过）。
		 *
		 *   本函数把球的点击**引导到 Companion**：优先唤醒本机已装的 Companion；
		 *   没装则如实告知，**不再假装能开窗**（前两批就是假装，用户白试两次）。
		 *
		 * @returns 唤醒 Companion 是否成功。
		 */
		async function callCompanion() {
			try {
				const g = globalThis;
				if (!g.fetch) return false;
				const loc = g.location;
				const base = loc && loc.origin ? loc.origin : '';
				// 走 host 路由：host 侧知道 Companion 装在哪、能不能拉起
				const res = await g.fetch(base + HOST_ROUTE_PREFIX + '/companion', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: '{}',
					cache: 'no-store',
				});
				if (!res || !res.ok) return false;
				const data = await res.json();
				return !!(data && data.ok && data.launched);
			} catch {
				return false;
			}
		}

		/** 真窗口引用（同一时刻只保留一个，用于 toggle）。 */
		let realWin = null;
		/**
		 * 上一次点击是否开着真窗口。
		 *
		 * 为什么要这个标记：`openRealWindow()` 在「已开着 ⇒ 关闭」时也返回 `null`，
		 * 与「被拦截、没开成」**返回值相同**。若不加区分，点一下关闭后
		 * 代码会继续往下走、又弹出 PiP/浮层 —— 变成"关不掉"。
		 */
		let wasRealWinOpen = false;

		/**
		 * PiP 窗口引用（同一时刻只保留一个）。 */
		let pipWin = null;

		/** 如实告知浮层的 id。 */
		const NOTICE_ID = 'dsh-mini-window-notice';

		/**
		 * ★ 如实告知：**当前环境开不了独立小窗**，并给出可行的下一步。
		 *
		 * ## 为什么不是"再造一个浮层窗口"
		 *
		 *   前两批的做法是：开不出真窗口就退到页面内 iframe 浮层。
		 *   用户实测的后果是：
		 *     · 「默认调起的是兜底形式，就是在页面里面的那种」—— 不是他要的
		 *     · 「之后一直卡在加载页面」—— **iframe 自嵌 DSH 会因为自嵌限制一直转圈**
		 *
		 *   ⇒ 给一个**转圈的假窗口**比什么都不做更糟：用户会以为功能坏了。
		 *     所以现在**如实说明 + 给出下一步**，这是唯一诚实的降级。
		 *
		 * ## 为什么删掉 iframe
		 *
		 *   DSH 页面自嵌时（`iframe src=<同一个 DSH>`）会因为会话/自嵌策略一直 loading。
		 *   实测：用户看到的就是"一直转圈"。⇒ 本函数**只用静态 HTML，不嵌 iframe**。
		 */
		function showWindowUnavailableNotice() {
			try {
				const doc = globalThis.document;
				if (!doc || !doc.body) return false;

				// 幂等：已开着就先关掉（再点一次 = 收起）
				const exist = doc.getElementById(NOTICE_ID);
				if (exist && exist.parentNode) { exist.parentNode.removeChild(exist); return false; }

				const box = doc.createElement('div');
				box.id = NOTICE_ID;
				box.setAttribute('role', 'dialog');
				box.setAttribute('aria-label', 'DSH 小窗说明');
				box.style.cssText = [
					'position:fixed', 'right:16px', 'top:60px', 'width:340px',
					'z-index:2147483400',
					'background:var(--dsh-mini-panel,#232528)', 'color:#e8e8e8',
					'border:1px solid rgba(255,255,255,.14)', 'border-radius:12px',
					'box-shadow:0 16px 48px rgba(0,0,0,.55)',
					'font:13px/1.65 system-ui,sans-serif', 'padding:14px 16px 12px',
				].join(';');

				// 顶栏（可拖动 + 关闭）
				const bar = doc.createElement('div');
				bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;'
					+ 'margin:-4px 0 8px;font-weight:600';
				const title = doc.createElement('span');
				title.textContent = '小窗需要 Companion';
				const close = doc.createElement('button');
				close.type = 'button';
				close.textContent = '✕';
				close.setAttribute('aria-label', '关闭说明');
				close.style.cssText = 'all:unset;cursor:pointer;padding:2px 8px;border-radius:6px;opacity:.7';
				close.addEventListener('click', function () {
					try { box.parentNode.removeChild(box); } catch { /* noop */ }
				});
				bar.appendChild(title);
				bar.appendChild(close);

				// 正文：**如实说明**，不绕弯子
				const body = doc.createElement('div');
				body.style.cssText = 'opacity:.88';
				body.innerHTML = [
					'当前 DSH 用<a style="color:inherit">安全策略</a>禁止页面开独立窗口：',
					'<br>· <code>window.open</code> 被宿主拒绝',
					'<br>· Document PiP 被权限策略拒绝',
					'<br>· iframe 自嵌会一直转圈',
					'<br><br>要真正的独立小窗（可拖出应用 / 可置顶），需要用 <b>Companion</b>。',
				].join('');

				// 操作区
				const actions = doc.createElement('div');
				actions.style.cssText = 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap';

				/** 造一个操作按钮。 */
				function act(label, primary, fn) {
					const b = doc.createElement('button');
					b.type = 'button';
					b.textContent = label;
					b.style.cssText = [
						'cursor:pointer', 'border:1px solid rgba(255,255,255,.16)', 'border-radius:8px',
						'padding:6px 12px', 'font:inherit', 'color:inherit',
						primary ? 'background:rgba(96,165,250,.22)' : 'background:rgba(255,255,255,.06)',
					].join(';');
					b.addEventListener('click', function () {
						try { fn(); } catch { /* noop */ }
					});
					return b;
				}

				// 「切小窗模式」——官方支持的、零下载的可用形态（整窗变小窗）
				actions.appendChild(act('切小窗模式', false, function () {
					try {
						const loc = globalThis.location;
						const url = new URL(loc.href);
						url.searchParams.set(MINI_PARAM, MINI_VALUE);
						loc.assign(url.href);
					} catch { /* noop */ }
				}));
				// 「再试一次 Companion」
				actions.appendChild(act('启动 Companion', true, function () {
					callCompanion().then(function (ok) {
						if (ok) { try { box.parentNode.removeChild(box); } catch { /* noop */ } }
					}).catch(function () { /* noop */ });
				}));

				box.appendChild(bar);
				box.appendChild(body);
				box.appendChild(actions);
				doc.body.appendChild(box);
				return true;
			} catch {
				return false;
			}
		}

		/**
		 * 页面内浮层小窗（**保留但不再默认使用**）。
		 *
		 * ⚠️ 2026-10-11 用户实测：这个浮层里的 iframe 载入 DSH 会**一直转圈**，
		 *   而且它拖不出宿主应用 ⇒ `onBallActivate` 已**不再调用它**。
		 *   保留函数仅供 `?dsh-mini=1` 的调试与守卫断言使用（有断言守着它的历史行为）。
		 *
		 * @returns 浮层根节点；已存在时返回它（幂等）。
		 */
		function toggleInPageWindow() {
			try {
				const doc = document;
				if (!doc || !doc.body) return null;
				const ID = 'dsh-mini-window-float';
				const existing = doc.getElementById(ID);
				if (existing) {
					// 已存在 ⇒ 再点关闭（toggle 语义，与 PiP 分支一致）
					try { existing.parentNode.removeChild(existing); } catch { /* noop */ }
					return null;
				}
				const url = globalThis.location ? globalThis.location.href : '';
				const box = doc.createElement('div');
				box.id = ID;
				box.setAttribute('role', 'dialog');
				box.setAttribute('aria-label', 'DSH 小窗');
				// 内联样式（不依赖外部样式表，卸载时一并消失）
				box.style.cssText = [
					'position:fixed', 'right:16px', 'top:60px',
					'width:420px', 'height:640px',
					'max-width:calc(100vw - 32px)', 'max-height:calc(100vh - 80px)',
					'z-index:2147483001',
					'background:#1a1a1a',
					'border:1px solid rgba(255,255,255,.16)',
					'border-radius:12px',
					'box-shadow:0 16px 48px rgba(0,0,0,.55)',
					'overflow:hidden', 'display:flex', 'flex-direction:column',
				].join(';');

				// 顶栏：标题 + 关闭
				const bar = doc.createElement('div');
				bar.style.cssText = 'flex:0 0 auto;height:34px;display:flex;align-items:center;'
					+ 'justify-content:space-between;padding:0 6px 0 12px;'
					+ 'background:#232528;color:#e8e8e8;font:12px/1 system-ui,sans-serif;'
					+ 'cursor:grab;user-select:none';
				const title = doc.createElement('span');
				title.textContent = 'DSH 小窗';
				const close = doc.createElement('button');
				close.type = 'button';
				close.textContent = '✕';
				close.setAttribute('aria-label', '关闭小窗');
				close.style.cssText = 'all:unset;cursor:pointer;padding:4px 8px;border-radius:6px;'
					+ 'font-size:13px;line-height:1';
				close.addEventListener('mouseenter', function () { close.style.background = 'rgba(255,255,255,.12)'; });
				close.addEventListener('mouseleave', function () { close.style.background = 'transparent'; });
				close.addEventListener('click', function () {
					try { box.parentNode.removeChild(box); } catch { /* noop */ }
				});
				bar.appendChild(title);
				bar.appendChild(close);

				// 内容：iframe 载入小窗模式（不搬 React DOM，避免合成事件跨文档失效）
				const f = doc.createElement('iframe');
				f.setAttribute('title', 'DSH 小窗内容');
				f.src = url;
				f.style.cssText = 'flex:1 1 auto;width:100%;border:0;background:#1a1a1a';

				box.appendChild(bar);
				box.appendChild(f);
				doc.body.appendChild(box);

				// 顶栏拖动（让用户能挪开它）
				let drag = false;
				let sx = 0; let sy = 0; let ox = 0; let oy = 0;
				bar.addEventListener('pointerdown', function (e) {
					try {
						drag = true; sx = e.clientX; sy = e.clientY;
						const r = box.getBoundingClientRect();
						ox = r.left; oy = r.top;
						bar.style.cursor = 'grabbing';
						if (bar.setPointerCapture && e.pointerId !== undefined) {
							try { bar.setPointerCapture(e.pointerId); } catch { /* noop */ }
						}
						e.preventDefault();
					} catch { /* noop */ }
				});
				bar.addEventListener('pointermove', function (e) {
					if (!drag) return;
					try {
						const nx = ox + (e.clientX - sx);
						const ny = oy + (e.clientY - sy);
						box.style.left = Math.max(0, Math.min(nx, (globalThis.innerWidth || 1200) - 80)) + 'px';
						box.style.top = Math.max(0, Math.min(ny, (globalThis.innerHeight || 800) - 40)) + 'px';
						box.style.right = 'auto';
					} catch { /* noop */ }
				});
				function endDrag() {
					drag = false;
					try { bar.style.cursor = 'grab'; } catch { /* noop */ }
				}
				bar.addEventListener('pointerup', endDrag);
				bar.addEventListener('pointercancel', endDrag);

				return box;
			} catch (e) {
				try { console.warn('[dsh-mini-window] 浮层小窗创建失败：', e && e.message); } catch { /* noop */ }
				return null;
			}
		}

		/**
		 * 球的激活行为（三级，**按"能否脱离宿主应用"排序**）。
		 *
		 * ★★ 2026-10-11 用户需求驱动重排：
		 *   用户原话「小窗调出后…无法被拖离至原来的 Electron 应用之外」
		 *          「我在做小窗插件，要是小窗脱离不了原本的软件，那我做的是什么？」
		 *   ⇒ **"能脱离宿主"是第一判据**，所以顺序必须是：
		 *
		 *     ① **`window.open` 真窗口**  —— 实测可用（Electron 开成真 BrowserWindow）
		 *        可拖出应用外 ✓ 可缩放 ✓ 系统关闭按钮 ✓ 零下载 ✓
		 *     ② Document PiP 置顶小窗    —— 本机 DSH 被拒，但其他环境可能可用
		 *        （置顶这一条比真窗口更强，所以它在可用时优先于 ①？**不**——
		 *          用户要的是"小窗"，①同时满足"可脱离 + 可缩放 + 可关闭"，
		 *          而 PiP **无法拖出应用外**，故 ① 优先。）
		 *     ③ 页面内浮层（最后兜底，**只保证"点了有反应"**）
		 *
		 * @param ev - 触发事件。
		 */
		/**
		 * ★★ 调 host 侧开「真窗口」（批次22 主方案）。
		 *
		 * ## 为什么它排在 window.open 之前
		 *
		 *   用户确认要「复刻 companion 小窗的全部」+「置顶可切换」：
		 *
		 *   | 能力 | `window.open`（前端） | **host 侧 BrowserWindow** |
		 *   |---|---|---|
		 *   | 拖出宿主应用 | ✅ | ✅ |
		 *   | 缩放 / 关闭 | ✅ | ✅ |
		 *   | **置顶（可切换）** | ❌ **做不到** | ✅ |
		 *   | **自绘顶栏（无边框）** | ❌（系统标题栏） | ✅ |
		 *   | 紧凑浮窗（companion T7） | ❌ | ✅ |
		 *
		 *   ⇒ host 侧能拿到完整 `BrowserWindow`，是实现"companion 同款"的唯一路径。
		 *   host 不可用时（如纯浏览器环境）再退回 `window.open`。
		 *
		 * ## 契约
		 *   host 侧注册 `POST /dsh-mini-window/<action>`，action ∈
		 *   `open|close|toggle|pin|minimize|compact|state`（见 `lib/host-routes.js`）。
		 *
		 * @param {string} action - 动作名。
		 * @returns {Promise<object|null>} 成功返回 JSON；host 不可用返回 null。
		 */
		async function callHostWindow(action) {
			try {
				const g = globalThis;
				if (!g.fetch) return null;
				const loc = g.location;
				const base = loc && loc.origin ? loc.origin : '';
				const res = await g.fetch(base + HOST_ROUTE_PREFIX + '/' + action, {
					method: action === 'state' ? 'GET' : 'POST',
					headers: { 'content-type': 'application/json' },
					body: action === 'state' ? undefined : '{}',
					// 同源请求会自动带 cookie；不允许被缓存
					cache: 'no-store',
				});
				if (!res || !res.ok) return null;
				const data = await res.json();
				return data && typeof data === 'object' ? data : null;
			} catch {
				// host 路由不存在（例如 web 端没装 host 侧）⇒ 返回 null 让调用方降级
				return null;
			}
		}

		/**
		 * 小窗（host 侧真窗口）当前是否开着 —— 缓存最近一次结果，
		 * 供顶栏按钮与球的状态判断，避免每次都打一次请求。
		 */
		let hostWindowOpen = false;
		/** 小窗是否置顶（缓存）。 */
		let hostWindowPinned = true;

		/**
		 * 球的激活行为。
		 *
		 * ★★★ 2026-10-11 第三次修正（用户实测驱动，前两次都错了）
		 *
		 *   用户原话：「默认调起的是兜底形式，就是在页面里面的那种，并没有新建一个小窗口」
		 *            「之后一直卡在加载页面」
		 *
		 *   实测已排除（真 DSH 环境，见 `callCompanion` 上方表格）：
		 *     host import electron ❌ / window.open ❌ / Document PiP ❌ / dshPlatform ❌
		 *
		 *   ⇒ 现在的顺序（**唯一能满足"独立小窗"的排在前面**）：
		 *
		 *     ① **Companion**（独立 Electron 程序，真窗口 / 可置顶 / 可拖出）
		 *        —— 唯一能做到用户要求的路径，代价是 151MB（用户已知情）
		 *     ② 页面内浮层，但**不再用 iframe 自嵌**（那正是"一直转圈"的原因），
		 *        改为**明示对话框**：告诉用户"当前环境开不了独立小窗"，
		 *        并给出下一步（装 Companion / 用 ?dsh-mini=1 切小窗模式）。
		 *        —— **宁可如实说，也不给一个转圈的假窗口**（前两批的教训）
		 *
		 * @param ev - 触发事件。
		 */
		async function onBallActivate(ev) {
			try {
				// ① ★ 浏览器小窗（**零下载**，用户 2026-10-11 拍板的最终方案）
				//    用系统已有的 Chrome/Edge 以 `--app=` 开 520×720 独立窗口：
				//    无地址栏、可置顶、可拖到应用之外。
				//    host 先自签会话 cookie 交给浏览器（**cookie 忽略端口**，实测），
				//    再 302 到 DSH ⇒ **开出来就是登录态**。
				if (await callBrowserWindow()) return;

				// ② Companion（Electron）：浏览器不可用时的后备（需 234.9MB 运行时）
				if (await callCompanion()) return;

				// ③ 如实告知 + 给出可行下一步（不再造假窗口）
				showWindowUnavailableNotice();
			} catch (e) {
				try { console.warn('[dsh-mini-window] 球的激活失败：', e && e.message); } catch { /* noop */ }
			}
		}


		/**
		 * 让 host 用**系统已有的浏览器**开一个小窗（零下载）。
		 *
		 * @returns {Promise<boolean>} 是否成功启动
		 */
		async function callBrowserWindow() {
			try {
				const r = await callHostWindow('browser', { width: 520, height: 720 });
				return !!(r && r.ok && r.launched);
			} catch { return false; }
		}


		/** 降级路径：在 URL 上加/去 ?dsh-mini=1 并刷新。 */
		function toggleMiniMode() {
			try {
				const loc = globalThis.location;
				if (!loc) return;
				const url = new URL(loc.href);
				if (url.searchParams.get(MINI_PARAM) === MINI_VALUE) url.searchParams.delete(MINI_PARAM);
				else url.searchParams.set(MINI_PARAM, MINI_VALUE);
				loc.assign(url.toString());
			} catch { /* noop */ }
		}

		/**
		 * 挂载悬浮球。
		 * @returns 卸载函数；环境不支持时返回 null。
		 */
		function mountBall() {
			try {
				const doc = document;
				if (!doc || !doc.body || typeof doc.createElement !== 'function') return null;

				// 幂等：重复 apply 不叠加
				const oldBall = doc.getElementById(BALL_ID);
				if (oldBall && oldBall.parentNode) oldBall.parentNode.removeChild(oldBall);
				const oldStyle = doc.getElementById(BALL_STYLE_ID);
				if (oldStyle && oldStyle.parentNode) oldStyle.parentNode.removeChild(oldStyle);

				const style = doc.createElement('style');
				style.id = BALL_STYLE_ID;
				style.textContent = BALL_CSS;
				(doc.head || doc.documentElement).appendChild(style);

				const ball = doc.createElement('div');
				ball.id = BALL_ID;
				ball.setAttribute('role', 'button');
				ball.setAttribute('tabindex', '0');
				ball.setAttribute('aria-label', 'DSH 小窗');
				ball.innerHTML = ballIconSvg();
				ball.dataset.pip = isPipAvailable() ? 'supported' : 'unsupported';
				ball.title = isPipAvailable()
					? 'DSH 小窗（点击弹出置顶小窗；可拖动）'
					: 'DSH 小窗（当前环境不支持置顶小窗，点击切换小窗模式；可拖动）';

				const saved = readBallPos();
				const side = saved ? saved.side : 'right';
				const vh = globalThis.innerHeight || 800;
				const top0 = saved ? clampBallTop(saved.top) : clampBallTop((vh - BALL_SIZE) / 2);
				ball.style.left = ballSideLeft(side) + 'px';
				ball.style.top = top0 + 'px';
				doc.body.appendChild(ball);

				// ---- 拖动（pointer 事件同时覆盖鼠标与触屏）----
				let dragging = false;
				let moved = false;
				let startX = 0;
				let startY = 0;
				let origLeft = 0;
				let origTop = 0;

				function onDown(e) {
					try {
						dragging = true; moved = false;
						startX = e.clientX; startY = e.clientY;
						origLeft = parseFloat(ball.style.left) || 0;
						origTop = parseFloat(ball.style.top) || 0;
						ball.dataset.dragging = 'true';
						if (ball.setPointerCapture && e.pointerId !== undefined) {
							try { ball.setPointerCapture(e.pointerId); } catch { /* 环境不支持 */ }
						}
						e.preventDefault();
					} catch { /* noop */ }
				}
				function onMove(e) {
					if (!dragging) return;
					try {
						const dx = e.clientX - startX;
						const dy = e.clientY - startY;
						if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
						ball.style.left = (origLeft + dx) + 'px';
						ball.style.top = clampBallTop(origTop + dy) + 'px';
					} catch { /* noop */ }
				}
				function onUp() {
					if (!dragging) return;
					try {
						dragging = false;
						delete ball.dataset.dragging;
						const curLeft = parseFloat(ball.style.left) || 0;
						const vw = globalThis.innerWidth || 1200;
						const toSide = (curLeft + BALL_SIZE / 2) < vw / 2 ? 'left' : 'right';
						ball.style.left = ballSideLeft(toSide) + 'px';
						const finalTop = clampBallTop(parseFloat(ball.style.top) || 0);
						ball.style.top = finalTop + 'px';
						saveBallPos(toSide, finalTop);
						// 位移很小 ⇒ 视为点击（拖动结束不再触发 click）
						if (!moved) onBallActivate();
					} catch { /* noop */ }
				}
				function onClick(e) { try { e.preventDefault(); } catch { /* noop */ } }
				function onKey(e) {
					try {
						if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
							e.preventDefault();
							onBallActivate();
						}
					} catch { /* noop */ }
				}
				function onResize() {
					try {
						const l = parseFloat(ball.style.left) || 0;
						const vw = globalThis.innerWidth || 1200;
						const s = (l + BALL_SIZE / 2) < vw / 2 ? 'left' : 'right';
						ball.style.left = ballSideLeft(s) + 'px';
						ball.style.top = clampBallTop(parseFloat(ball.style.top) || 0) + 'px';
					} catch { /* noop */ }
				}

				ball.addEventListener('pointerdown', onDown);
				ball.addEventListener('pointermove', onMove);
				ball.addEventListener('pointerup', onUp);
				ball.addEventListener('pointercancel', onUp);
				ball.addEventListener('click', onClick);
				ball.addEventListener('keydown', onKey);
				globalThis.addEventListener('resize', onResize);

				return function unmountBall() {
					try { ball.removeEventListener('pointerdown', onDown); } catch { /* noop */ }
					try { ball.removeEventListener('pointermove', onMove); } catch { /* noop */ }
					try { ball.removeEventListener('pointerup', onUp); } catch { /* noop */ }
					try { ball.removeEventListener('pointercancel', onUp); } catch { /* noop */ }
					try { ball.removeEventListener('click', onClick); } catch { /* noop */ }
					try { ball.removeEventListener('keydown', onKey); } catch { /* noop */ }
					try { globalThis.removeEventListener('resize', onResize); } catch { /* noop */ }
					try { if (ball.parentNode) ball.parentNode.removeChild(ball); } catch { /* noop */ }
					try { if (style.parentNode) style.parentNode.removeChild(style); } catch { /* noop */ }
				};
			} catch (e) {
				try { console.warn('[dsh-mini-window] 悬浮球挂载失败：', e && e.message); } catch { /* noop */ }
				return null;
			}
		}

		/**
		 * 客户端根上下文入口。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			// ══════════════════════════════════════════════════════════════════
			// ★ 防御原则（2026-10-11 事故固化）：
			//   本插件的**可选 UI 增强**（mini 外观、悬浮球）**绝不能**让宿主
			//   的 web 启动失败。宿主在启动时会检查每个 entry 是否 activate；
			//   任何未捕获异常都会导致：
			//     「web boot: N entry did not activate」
			//     「@a9i5k4/dsh-mini-window: import failed」
			//   整个应用直接弹「应用无法启动或已意外停止」——**用户完全无法使用**。
			//
			//   实测事故：168:28 用户在应用内点了按钮触发前端 bundle 重载，
			//   恰好读到我**编辑过程中的中间态**（apply() 已引用 BALL_PARAM，
			//   但 BALL_PARAM 的定义还没写进去）⇒ import failed ⇒ 应用起不来。
			//
			//   ⇒ 两道防线：
			//     ① 每个可选增强各自 try/catch，失败只降级、不冒泡；
			//     ② 最外层再包一层，任何意外都吞掉并打日志。
			//   代价：真出问题时界面上看不出异样（球不见了）——所以**必须打日志**，
			//   排查看 console 即可。这个取舍是刻意的：**可用性 > 可见的错误**。
			// ══════════════════════════════════════════════════════════════════
			try {
				const mini = isMiniMode();
				console.info('[dsh-mini-window] client 侧 apply 已执行；mini 模式 =', mini);

				// ★ 拿到官方 layout 服务（用于顶栏 T3 的侧栏开关）。
				//   拿不到也没关系：openSidebarViaCtx() 会退回"真点官方 DOM 开关"。
				try {
					const l = ctx && ctx.layout;
					if (l && typeof l.toggleSidebar === 'function') layoutRef = l;
				} catch { /* 服务形态变化则忽略，走 DOM 兜底 */ }

				if (mini) {
					try {
						const ok = applyMiniShell();
						console.info('[dsh-mini-window] 外壳标记注入 =', ok);
					} catch (e) {
						console.warn('[dsh-mini-window] 小窗外壳注入失败（已降级，不影响应用）：', e && e.message);
					}
				}

				/**
				 * ★ 悬浮球：**无条件挂载**（2026-10-11 用户实测反馈修正）。
				 *
				 * 原设计只在 `mini` 为真时挂球 —— 结果是用户在**自己的 DSH 主界面**
				 * （不带 `?dsh-mini=1`）根本看不到球，只有 Companion 小窗里才有
				 * （因为壳加载的正是 `?dsh-mini=1`）。而「点球弹出系统置顶小窗」这个
				 * 功能本来就是给主界面用的 ⇒ 必须先进入小窗模式才能开小窗，是闭环错误。
				 *
				 * 现在任何页面都挂球（样式也不再依赖 `html[data-dsh-mini]`）。
				 * 仍保留一个**逃生开关**：带 `?dsh-ball=0` 时不挂，便于排查与用户关闭。
				 */
				if (!isBallDisabled()) {
					try {
						const unmount = mountBall();
						console.info('[dsh-mini-window] 悬浮球挂载 =', !!unmount,
							'；Document PiP 可用 =', isPipAvailable());
					} catch (e) {
						console.warn('[dsh-mini-window] 悬浮球挂载失败（已降级，不影响应用）：', e && e.message);
					}
				} else {
					console.info('[dsh-mini-window] 悬浮球已被 ?' + BALL_PARAM + '=0 关闭');
				}

			/**
			 * 向 shell.overlay 注册。
			 *
			 * ⚠️ **list slot 必须带 `id`** —— 实测踩过：只给 `{name}` 会抛
			 *   `Uncaught Error: list slot "shell.overlay" requires options.id`
			 * 而且是**未捕获异常**，直接中断整个 AppFrame 的渲染（症状是页面上
			 * `[data-dsh-surface]` 一个都没有，看起来像「官方布局没了」）。
			 * id 要全局唯一，用包名做前缀。
			 */
			try {
				const OVERLAY_ID = 'dsh-mini-window.badge';
				ctx.slots.inject('shell.overlay', function* () {
					yield ctx.slots.register({ name: 'shell.overlay', id: OVERLAY_ID }, MiniBadge);
				});
			} catch (e) {
				// 角标是纯装饰，注册失败绝不该让应用起不来。
				console.warn('[dsh-mini-window] 角标注册失败（已降级，不影响应用）：', e && e.message);
			}
			} catch (e) {
				// ★ 兜底：任何未预期的异常都在此终结，**绝不冒泡到宿主**
				//   （冒泡 = web boot 判定该 entry 未 activate = 整个应用打不开）。
				console.error('[dsh-mini-window] apply 阶段出现未预期错误（已吞掉以保证应用可用）：', e);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.isMiniMode = isMiniMode;
		exports.isMiniDebug = isMiniDebug;
		// 导出给运行时守卫做**真调用**断言（守卫按「真执行 + 断返回值」纪律验收，
		// 不接受「源码含某字符串」这类恒真守卫）。
		exports.mountBall = mountBall;
		exports.isPipAvailable = isPipAvailable;
		exports.openRealWindow = openRealWindow;
		exports.toggleInPageWindow = toggleInPageWindow;
		exports.openPipWindow = openPipWindow;
		exports.ballIconSvg = ballIconSvg;
		exports.clampBallTop = clampBallTop;
		exports.ballSideLeft = ballSideLeft;
		exports.readBallPos = readBallPos;
		exports.saveBallPos = saveBallPos;
		exports.BALL_ID = BALL_ID;
		exports.BALL_STYLE_ID = BALL_STYLE_ID;
		exports.BALL_POS_KEY = BALL_POS_KEY;
		exports.BALL_SIZE = BALL_SIZE;
		exports.BALL_PARAM = BALL_PARAM;
		exports.isBallDisabled = isBallDisabled;
		exports.MINI_PARAM = MINI_PARAM;
		// ---- 批次22：companion 同款界面 + host 真窗口桥 ----
		exports.callHostWindow = callHostWindow;
		// ★ 测试入口：导出**同一个** onBallActivate（守卫要真调用它，不能复制一份）
		exports.onBallActivateForTest = onBallActivate;
		exports.callCompanion = callCompanion;
		exports.showWindowUnavailableNotice = showWindowUnavailableNotice;
		exports.NOTICE_ID = NOTICE_ID;
		exports.mountMiniTopbar = mountMiniTopbar;
		exports.toggleMiniMenu = toggleMiniMenu;
		exports.openSidebarViaCtx = openSidebarViaCtx;
		exports.HOST_ROUTE_PREFIX = HOST_ROUTE_PREFIX;
		exports.TOPBAR_ID = TOPBAR_ID;
		exports.MENU_ID = MENU_ID;
		return module.exports;
	},
});
