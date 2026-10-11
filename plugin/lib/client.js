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
			// ## 判据（可复算）
			//   `probe/header-ancestors.cjs` 打印页签行矩形与其"被顶栏压住多少 px"：
			//   修复后页签行 `y` 必须 **≥ 55**、`coveredByTopbarPx` 必须 **= 0**。
			'html[data-dsh-mini] header[data-window-drag="true"]{padding-top:55px!important}',
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

		/**
		 * 客户端根上下文入口。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			const mini = isMiniMode();
			console.info('[dsh-mini-window] client 侧 apply 已执行；mini 模式 =', mini);

			if (mini) {
				const ok = applyMiniShell();
				console.info('[dsh-mini-window] 外壳标记注入 =', ok);
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
			const OVERLAY_ID = 'dsh-mini-window.badge';

			ctx.slots.inject('shell.overlay', function* () {
				yield ctx.slots.register({ name: 'shell.overlay', id: OVERLAY_ID }, MiniBadge);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.isMiniMode = isMiniMode;
		exports.isMiniDebug = isMiniDebug;
		return module.exports;
	},
});
