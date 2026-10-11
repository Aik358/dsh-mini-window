/**
 * 小窗 webview 的 preload —— 把宿主侧读出的 LocalStorage 键值**注入**到本分区。
 *
 * ## 为什么需要它（真 bug）
 *
 * Web 存储按 **(partition, origin)** 隔离。Companion 用独立 partition
 * `persist:dsh-companion`，DSH 桌面壳用自己 userData 下的 default session
 * ⇒ Companion 里那个 origin 的 localStorage 是**空的**。
 * DSH 前端插件用 localStorage 记「引导已完成」，实测 key：
 *   `dsh-auto-memory.firstRunDone` / `.semWizardDone` / `.tourDismissed` / `.seenVersion`
 *   `router:onboarding:model-guide-v2`、`dam-skin*`、`sidebar:v1:ses*` 等
 * ⇒ 空即被判定为全新安装 ⇒ 反复弹欢迎向导。这就是要修的 bug。
 *
 * ## 为什么不是「拷 leveldb 文件」
 *
 * 最初做法是把宿主 `Local Storage/leveldb/` 整份拷进 Companion 分区。
 * **实测被证伪**：拷贝成功（7 文件 / 191193 B），但 Chromium 一打开就整库丢弃重建
 * （运行后只剩 41 B 空 MANIFEST、`.ldb` 全删）——LocalStorage 的 schema
 * 跨 Chromium 版本不兼容（宿主壳 Electron 44.0.0 vs Companion 44.7.0）。
 * 所以必须走**应用层写入**。
 *
 * ## 为什么用 sendSync（而不是读文件）
 *
 * 实测两条前提（都有独立验证）：
 *   1. `<webview>` 的 preload 在**页面文档创建之前**执行 ⇒ 写入对页面脚本可见。
 *      验证：`tests/smoke/webview-preload-feasibility.cjs`
 *      （页面内联脚本读到 preload 写的值；不挂 preload 时为 null）
 *   2. `<webview>` 是独立 webContents，**宿主的 additionalArguments 不透传**到它
 *      ⇒ 不能靠命令行传参拿到 seed（首跑可行性测试即因此失败）。
 *
 * 这里改用 **`ipcRenderer.sendSync`**：
 *   - `sendSync` 是同步的 ⇒ 能在页面脚本运行前拿到数据（`invoke` 是异步的，
 *     页面脚本可能先跑，不满足时序要求）
 *   - `ipcRenderer` 在**沙箱化 preload** 里也可用 ⇒ 无需 `sandbox=no`，
 *     不必把 webview 的安全级别降下来（比读文件方案更安全）
 *
 * ## 安全边界
 *
 *   - 只**写入** localStorage；不读页面数据、不发网络请求、不碰 DOM。
 *   - 只写主进程显式给出的 key，**且仅在缺失时**写入 ——
 *     本分区可能已有更新的用户状态（用户在小窗里点掉了引导），
 *     用宿主旧快照覆盖会把用户的更新冲掉。缺失才补是安全方向。
 */
'use strict';

const { ipcRenderer } = require('electron');

/** 从主进程同步取 seed（结构：{ "<origin>": { "<key>": "<value>" } }）。 */
function fetchSeed() {
  try {
    return ipcRenderer.sendSync('companion:ls-seed-sync');
  } catch {
    return undefined;
  }
}

/**
 * 应用 seed。
 * @returns {{ok:boolean, reason:string, written?:number, entries?:number}}
 */
function applySeed() {
  const payload = fetchSeed();
  if (payload === undefined || payload === null) return { ok: false, reason: 'no-seed' };
  if (payload.ok !== true) return { ok: false, reason: payload.reason || 'seed-unavailable' };

  const seed = payload.data;
  if (seed === null || typeof seed !== 'object') return { ok: false, reason: 'bad-seed-shape' };

  // 只应用与当前 origin 匹配的那一份，避免把别的站点的数据写进这里
  let origin;
  try {
    origin = String(window.location.origin);
  } catch {
    return { ok: false, reason: 'no-origin' };
  }

  const bucket = seed[origin];
  if (bucket === undefined || bucket === null || typeof bucket !== 'object') {
    return { ok: false, reason: `no-bucket-for-origin: ${origin}` };
  }

  let written = 0;
  let skipped = 0;
  let entries = 0;
  for (const [k, v] of Object.entries(bucket)) {
    if (typeof k !== 'string' || typeof v !== 'string') continue;
    entries++;
    try {
      if (window.localStorage.getItem(k) === null) {   // 仅缺失时写
        window.localStorage.setItem(k, v);
        written++;
      } else {
        skipped++;
      }
    } catch {
      // QuotaExceeded / SecurityError 等：单条失败不影响其余
    }
  }

  return { ok: true, reason: 'applied', written, entries, skipped, origin };
}

try {
  const r = applySeed();
  if (r.ok) {
    console.info(`[mini-window/preload] localStorage seed 已应用：写入 ${r.written} / 条目 ${r.entries}` +
      (r.skipped ? `（已存在跳过 ${r.skipped}）` : ''));
    // 供验收断言：注入结果挂在 window 上（只读探针，不参与业务）
    Object.defineProperty(window, '__dshMiniSeedResult', { value: r, enumerable: false });
  } else {
    console.info(`[mini-window/preload] 跳过（${r.reason}）`);
    Object.defineProperty(window, '__dshMiniSeedResult', { value: r, enumerable: false });
  }
} catch (err) {
  // preload 绝不能因为注入失败而影响页面加载
  console.info('[mini-window/preload] 注入异常（已忽略）:', err && err.message);
}
