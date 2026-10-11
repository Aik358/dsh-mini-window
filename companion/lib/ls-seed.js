/**
 * localStorage 注入 seed 的装载、规范化与投递。
 *
 * ## 背景（全部为实测结论，不是推断）
 *
 * DSH 前端插件用 localStorage 记「引导已完成」之类的状态。Companion 是**独立
 * Electron 进程**，用它自己的 partition，于是那块存储是空的 ⇒ 插件判定为全新安装
 * ⇒ 反复弹欢迎向导。这是要修的 bug。
 *
 * ### 为什么不能「拷 leveldb 文件」
 * 曾经把宿主 `Local Storage/leveldb/` 整份拷进本分区。**实测证伪**：拷贝成功
 * （7 文件 / 191193 B），但 Chromium 一打开就整库丢弃重建（运行后只剩 41 B 空
 * MANIFEST、`.ldb` 全删）——LocalStorage 的 schema 跨 Chromium 版本不兼容
 * （宿主壳 Electron 44.0.0 vs 本进程 44.7.0）。⇒ 必须走应用层写入。
 *
 * ### 为什么需要「origin 映射」（★这是本模块存在的核心理由）
 * 实测提取到的宿主存储里，origin 只有两个：
 *   - `dsh-app://app`      → 238 条，**全部业务 key 都在这里**
 *   - `devtools://devtools` → 4 条，无关
 * 即：**桌面壳的前端跑在自定义协议 `dsh-app://app` 下**。
 * 而 Companion 的 webview 加载的是 `http://127.0.0.1:19387/`，它的 origin 是
 * `http://127.0.0.1:19387`。两者的 localStorage 是**完全不同的存储区域**。
 *
 * 所以照 origin 原样匹配必然一条都注入不进去（早期版本正是如此：
 * preload 报 `no-bucket-for-origin`）。必须把「应用桶」映射到 webview 的**实际** origin。
 *
 * 好消息是这个映射是安全的：插件用的是**应用级 key**（`dam-skin`、
 * `dsh-auto-memory.tourDismissed` …），不带 origin 语义；同一份 UI 换个壳加载时，
 * 这些 key 本来就该跟着走。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 桌面壳前端的 origin（实测；所有业务 key 都挂在这里）。 */
const SHELL_ORIGIN = 'dsh-app://app';

/** 与业务无关、不应被注入的 origin。 */
const IGNORED_ORIGINS = new Set(['devtools://devtools']);

/**
 * 把「提取到的原始 seed」规范成「可直接注入的 seed」。
 *
 * 规则：
 *   1. 丢弃无关 origin（devtools 等）
 *   2. 把 `dsh-app://app` 这份应用桶映射到 `targetOrigin`（webview 实际会有的 origin）
 *   3. 若原始 seed 里**恰好**还有别的业务 origin 也一并并入（多壳场景），
 *      冲突时 `dsh-app://app` 优先 —— 它是桌面壳的权威来源
 *
 * @param {Record<string, Record<string,string>>} raw      提取器输出
 * @param {string} targetOrigin                             webview 的实际 origin
 * @returns {{seed: Record<string, Record<string,string>>, stats: object}}
 */
function normalizeSeed(raw, targetOrigin) {
  const stats = {
    rawOrigins: [],
    ignored: [],
    mergedFrom: [],
    entries: 0,
    targetOrigin,
  };

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { seed: {}, stats: { ...stats, error: 'bad-raw-shape' } };
  }
  if (typeof targetOrigin !== 'string' || targetOrigin === '') {
    return { seed: {}, stats: { ...stats, error: 'bad-target-origin' } };
  }

  stats.rawOrigins = Object.keys(raw);

  /** @type {Record<string,string>} */
  const merged = {};
  let sawAppBucket = false;

  // 先并入应用桶（权威）
  const appBucket = raw[SHELL_ORIGIN];
  if (appBucket !== null && typeof appBucket === 'object' && !Array.isArray(appBucket)) {
    Object.assign(merged, appBucket);
    sawAppBucket = true;
    stats.mergedFrom.push(SHELL_ORIGIN);
  }

  // 再并入其它业务 origin（不含被忽略的、不含应用桶自身、不含目标 origin 自身）
  for (const [origin, bucket] of Object.entries(raw)) {
    if (origin === SHELL_ORIGIN) continue;
    if (IGNORED_ORIGINS.has(origin)) { stats.ignored.push(origin); continue; }
    if (origin === targetOrigin) continue;              // 目标 origin 自己那份稍后处理
    if (bucket === null || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
    // 不覆盖已有的应用桶 key
    for (const [k, v] of Object.entries(bucket)) {
      if (!(k in merged)) merged[k] = v;
    }
    stats.mergedFrom.push(origin);
  }

  // 目标 origin 自己那份优先级**低于**应用桶（应用桶是权威来源）
  const ownBucket = raw[targetOrigin];
  if (ownBucket !== null && typeof ownBucket === 'object' && !Array.isArray(ownBucket)) {
    for (const [k, v] of Object.entries(ownBucket)) {
      if (!(k in merged)) merged[k] = v;
    }
    stats.mergedFrom.push(targetOrigin);
  }

  const seed = Object.keys(merged).length > 0 ? { [targetOrigin]: merged } : {};
  stats.entries = Object.keys(merged).length;
  stats.sawAppBucket = sawAppBucket;
  return { seed, stats };
}

/**
 * 读取现成的 seed 文件。
 * @returns {{ok:boolean, reason:string, raw?:object, bytes?:number}}
 */
function readSeedFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, reason: `read-failed: ${err.code ?? err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `parse-failed: ${err.message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'bad-shape' };
  }
  return { ok: true, reason: 'ok', raw: parsed, bytes: Buffer.byteLength(raw, 'utf8') };
}

/** 提取器脚本路径（相对本模块：companion/lib → 仓库根/probe）。 */
function defaultExtractorPath() {
  return path.join(__dirname, '..', '..', 'probe', 'host-ls-extract.cjs');
}

/**
 * 现场调用提取器，把宿主 leveldb 读成原始 seed 写到 `outFile`。
 * 失败不抛错，交由调用方回落。
 *
 * @returns {{ok:boolean, reason:string, stderr?:string}}
 */
function runExtractor(outFile, extractorPath, opts) {
  const ex = extractorPath || defaultExtractorPath();
  if (!fs.existsSync(ex)) return { ok: false, reason: 'extractor-missing' };
  const timeout = (opts && opts.timeout) || 20000;
  const spawnSync = require('node:child_process').spawnSync;
  try {
    // 用 Electron 自带的 node（ELECTRON_RUN_AS_NODE）跑，避免另找 node 可执行文件
    const r = spawnSync(process.execPath, [ex, '--out', outFile, '--quiet'], {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    if (r.status !== 0) {
      return { ok: false, reason: `extractor-exit-${r.status}`, stderr: (r.stderr || '').slice(0, 300) };
    }
    return { ok: fs.existsSync(outFile), reason: fs.existsSync(outFile) ? 'ok' : 'no-output' };
  } catch (err) {
    return { ok: false, reason: `spawn-failed: ${err.message}` };
  }
}

module.exports = {
  SHELL_ORIGIN,
  IGNORED_ORIGINS,
  normalizeSeed,
  readSeedFile,
  runExtractor,
  defaultExtractorPath,
};
