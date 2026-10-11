/**
 * mini 模式的规格常量与判定 —— 单一真相源。
 *
 * ## 为什么单独成文件
 *
 * 这些数字散落在插件 CSS、Companion 窗口尺寸、验收脚本三处时，改一处漏一处是必然的。
 * 集中在这里，并配测试断言，任何漂移都会立刻红。
 *
 * ## 数字的出处（全部实测，不是估的）
 *
 * 来自 `plugin/lib/mini-spec.cjs`（对桌面端参考实现小窗逐像素量测）：
 *   - 参考实现窗口**外框** 520×720 —— **这不是 UI 尺寸**
 *   - 真正的内容卡片 **400×600**，居中放置（左右各留 60、上 30、下 90）
 *   - 卡片内三段竖排：顶栏 **55px** / 对话区 429px / 输入卡 **98px**
 *   - 圆角：面板 ~15px（取整 12–15）、输入卡 ~17px（取整 16）
 *   - 配色：面板底 `#1A1A1A`、输入卡底 `#232528`、顶栏分隔线 `#313131`
 *
 * ⚠️ 早期 `docs/01` §3.2 把 520×720 当成 UI 尺寸，**该表述已过时**，勿再引用。
 *
 * ## 与官方响应式的关系（实测，见 evidence/batch2-official-responsive-verified.md）
 *
 * 「隐藏 56px 控制栏 / 隐藏右栏」这两件事**官方布局已自带**：
 *   - ≤1024px 侧栏自动折叠为 56px 轨道
 *   - ≤760px  对话区满宽、`details` 高度归零、轨道改为 `position:absolute` +
 *              `pointer-events:none` 的浮层，`elementFromPoint` 实测不遮挡
 * ⇒ 小窗目标宽度 460 落在「已满宽」区间，**不需要我们自己写收缩 CSS**。
 *   额外覆盖只会与官方机制打架（症状随机），明确避免。
 */
'use strict';

/** 参考小窗的实测规格。 */
const REFERENCE = Object.freeze({
  /** 窗口外框（含留白）。**不是** UI 尺寸。 */
  windowFrame: Object.freeze({ width: 520, height: 720 }),
  /** 真正的内容卡片。 */
  content: Object.freeze({ width: 400, height: 600 }),
  /** 卡片在窗口内的留白。 */
  padding: Object.freeze({ left: 60, right: 60, top: 30, bottom: 90 }),
  /** 卡片内三段。 */
  topbar: 55,
  conversation: 429,
  composer: 98,
  /** 圆角。 */
  radiusPanel: 15,
  radiusComposer: 17,
  /** 配色。 */
  colorPanel: '#1A1A1A',
  colorComposer: '#232528',
  colorDivider: '#313131',
});

/**
 * 本项目的窗口尺寸选择。
 *
 * 定位：Companion 的小窗是**无边框自绘标题栏**，与参考实现一样把留白做进窗口外框。
 * 取参考实现同款 520×720 会得到一个 400×600 的内容区；但我们的自绘标题栏已占掉
 * 顶部一条，所以直接把**窗口**设为内容尺寸，避免「窗口 520 但内容只有 400」的浪费。
 *
 * 取 460×720：宽度落在官方「对话区已满宽」的区间（≤760），
 * 且比 400 宽 15%，在 13 寸屏上单列对话更从容。
 */
const WINDOW = Object.freeze({
  width: 460,
  height: 720,
  minWidth: 360,
  minHeight: 480,
});

/** mini 模式的触发参数（对齐参考实现用 URL 判据切小窗的做法）。 */
const TRIGGER = Object.freeze({
  param: 'dsh-mini',
  value: '1',
});

/**
 * 判断一个 URL/查询串是否处于 mini 模式。
 *
 * 容错：任何解析失败都返回 false —— 宁可不开小窗，也不能因为取 URL 失败影响主界面。
 *
 * @param {string|undefined} search 形如 `?dsh-mini=1`，或完整 URL
 * @returns {boolean}
 */
function isMiniSearch(search) {
  if (typeof search !== 'string' || search === '') return false;
  try {
    // 接受完整 URL 或裸查询串两种输入
    const q = search.includes('?') ? search.slice(search.indexOf('?')) : search;
    return new URLSearchParams(q).get(TRIGGER.param) === TRIGGER.value;
  } catch {
    return false;
  }
}

/**
 * 官方响应式断点（实测值，用于**验收断言**而非样式覆盖）。
 *
 * 这两个数字的作用是「证明我们落在已满宽区间」，不是拿来写 media query。
 */
const OFFICIAL_BREAKPOINTS = Object.freeze({
  /** ≤ 此宽度：侧栏折叠为 56px 轨道 */
  sidebarAutoCollapse: 1024,
  /** ≤ 此宽度：对话区满宽、details 归零、轨道变 pointer-events:none 浮层 */
  conversationFullBleed: 760,
  /** 折叠态轨道宽度（实测 52–56，取上报值 56） */
  railWidth: 56,
});

module.exports = {
  REFERENCE,
  WINDOW,
  TRIGGER,
  OFFICIAL_BREAKPOINTS,
  isMiniSearch,
};
