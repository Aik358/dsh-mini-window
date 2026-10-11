/**
 * ls-seed 的 origin 映射验收（真 import → 真调用 → 断言返回值）
 *
 * 依据用户硬性验收纪律：
 *   - 真 import → 真构造 → 真调用 → 断言返回值
 *   - 禁止以「源码含某字符串」充当功能验收
 *   - 每条验收必须带负路径
 *   - 给出可复算物理量
 *
 * 用法：node tests/smoke/ls-seed.test.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const lib = require('../../lib/ls-seed.js');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    fail++;
    console.log(`  FAIL  ${name}\n          ${err.message}`);
  }
}

console.log('=== ls-seed origin 映射验收 ===\n');

// ---------- 1. 常量与真实数据形状 ----------
console.log('[1] 常量与真实数据形状');

t('SHELL_ORIGIN 常量正是实测到的 dsh-app://app', () => {
  assert.strictEqual(lib.SHELL_ORIGIN, 'dsh-app://app');
});

t('devtools origin 被列入忽略表', () => {
  assert.ok(lib.IGNORED_ORIGINS.has('devtools://devtools'));
});

// ---------- 2. 核心：origin 映射（这是 bug 的修复点）----------
console.log('\n[2] 核心：把 dsh-app://app 映射到 webview 的实际 origin');

t('宿主业务 key 被映射到目标 origin（用真实形状的输入）', () => {
  const raw = {
    'devtools://devtools': { x: '1' },
    'dsh-app://app': {
      'dam-skin': 'v4',
      'dsh-auto-memory.tourDismissed': '1',
      'dsh-auto-memory.semWizardDone': '1',
      'dsh-vision-router:onboarding:model-guide-v2': 'seen',
    },
  };
  const target = 'http://127.0.0.1:19387';
  const { seed, stats } = lib.normalizeSeed(raw, target);

  assert.strictEqual(stats.error, undefined, `不应报错：${stats.error}`);
  assert.deepStrictEqual(Object.keys(seed), [target], '结果必须只含目标 origin 一个桶');
  const bucket = seed[target];
  assert.strictEqual(bucket['dam-skin'], 'v4');
  assert.strictEqual(bucket['dsh-auto-memory.tourDismissed'], '1');
  assert.strictEqual(bucket['dsh-auto-memory.semWizardDone'], '1');
  assert.strictEqual(bucket['dsh-vision-router:onboarding:model-guide-v2'], 'seen');
  assert.strictEqual(stats.entries, 4);
  assert.ok(stats.mergedFrom.includes('dsh-app://app'));
  assert.ok(stats.ignored.includes('devtools://devtools'), 'devtools 应被忽略');
  assert.ok(!( 'devtools://devtools' in seed), '忽略的 origin 不得出现在结果里');
});

t('★ 负路径：不做映射时（按原 origin 匹配）目标 origin 桶必须为空', () => {
  // 这正是修复前的行为：preload 报 no-bucket-for-origin
  const raw = { 'dsh-app://app': { 'dam-skin': 'v4' } };
  const target = 'http://127.0.0.1:19387';
  assert.strictEqual(raw[target], undefined, '原始 seed 里不应有目标 origin 桶（复现 bug 前提）');
  const { seed } = lib.normalizeSeed(raw, target);
  assert.ok(seed[target] !== undefined, '映射后必须有目标 origin 桶');
});

t('目标 origin 自己那份数据也并入，但优先级低于应用桶', () => {
  const target = 'http://127.0.0.1:19387';
  const raw = {
    'dsh-app://app': { k: 'from-app', only_app: 'a' },
    [target]: { k: 'from-own', only_own: 'b' },
  };
  const { seed } = lib.normalizeSeed(raw, target);
  assert.strictEqual(seed[target].k, 'from-app', '应用桶优先');
  assert.strictEqual(seed[target].only_own, 'b', '目标 origin 独有的 key 也要保留');
  assert.strictEqual(seed[target].only_app, 'a');
});

t('没有应用桶时，其它业务 origin 的数据也能并入（多壳场景）', () => {
  const target = 'http://127.0.0.1:19387';
  const raw = { 'https://other.example': { 'dam-skin': 'v3' } };
  const { seed, stats } = lib.normalizeSeed(raw, target);
  assert.strictEqual(seed[target]['dam-skin'], 'v3');
  assert.ok(stats.mergedFrom.includes('https://other.example'));
  assert.strictEqual(stats.sawAppBucket, false);
});

// ---------- 3. 负路径：坏输入不崩 ----------
console.log('\n[3] 负路径：坏输入必须如实报错，且不抛异常');

t('负路径：raw 为 null → 报 bad-raw-shape', () => {
  const { seed, stats } = lib.normalizeSeed(null, 'http://x');
  assert.deepStrictEqual(seed, {});
  assert.strictEqual(stats.error, 'bad-raw-shape');
});
t('负路径：raw 为数组 → 报 bad-raw-shape', () => {
  const { stats } = lib.normalizeSeed([1, 2], 'http://x');
  assert.strictEqual(stats.error, 'bad-raw-shape');
});
t('负路径：targetOrigin 为空串 → 报 bad-target-origin', () => {
  const { stats } = lib.normalizeSeed({ 'a://b': { k: 'v' } }, '');
  assert.strictEqual(stats.error, 'bad-target-origin');
});
t('负路径：targetOrigin 为 undefined → 报 bad-target-origin', () => {
  const { stats } = lib.normalizeSeed({ 'a://b': { k: 'v' } }, undefined);
  assert.strictEqual(stats.error, 'bad-target-origin');
});
t('负路径：只有被忽略的 origin → 结果为 0 条（调用方据此判 loaded:false）', () => {
  const { seed, stats } = lib.normalizeSeed({ 'devtools://devtools': { a: '1' } }, 'http://x');
  assert.strictEqual(stats.entries, 0);
  assert.deepStrictEqual(seed, {}, '空结果时不得造出空桶');
});
t('负路径：桶不是对象（是字符串/数组）时跳过而不崩', () => {
  const target = 'http://x';
  const { seed, stats } = lib.normalizeSeed(
    { 'dsh-app://app': 'oops', 'a://b': [1, 2], 'c://d': { good: 'yes' } },
    target,
  );
  assert.strictEqual(stats.error, undefined);
  assert.strictEqual(seed[target].good, 'yes', '好的那份仍应并入');
  assert.strictEqual(stats.entries, 1);
});
t('负路径：值为非字符串时原样保留（不静默丢弃）', () => {
  const target = 'http://x';
  const { seed } = lib.normalizeSeed({ 'dsh-app://app': { n: 123, b: true } }, target);
  assert.strictEqual(seed[target].n, 123);
  assert.strictEqual(seed[target].b, true);
});

// ---------- 4. 文件读写（真落盘 → 真读回）----------
console.log('\n[4] 文件读写（真构造 fixture → 真调用）');

function fixture(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lsseed-'));
  const f = path.join(dir, 'seed.json');
  fs.writeFileSync(f, JSON.stringify(obj), 'utf8');
  return { dir, f };
}

t('readSeedFile 真读回 JSON，并给出字节数', () => {
  const { f } = fixture({ 'dsh-app://app': { k: 'v' } });
  const r = lib.readSeedFile(f);
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.raw['dsh-app://app'].k, 'v');
  assert.ok(r.bytes > 0, 'bytes 应 > 0');
  assert.strictEqual(r.bytes, fs.statSync(f).size, 'bytes 必须等于真实文件大小');
});

t('负路径：文件不存在 → ok:false 且 reason 带 read-failed', () => {
  const r = lib.readSeedFile(path.join(os.tmpdir(), 'definitely-not-here-xyz.json'));
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /read-failed/);
});

t('负路径：文件内容非法 JSON → ok:false 且 reason 带 parse-failed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lsseed-'));
  const f = path.join(dir, 'bad.json');
  fs.writeFileSync(f, '{ this is not json', 'utf8');
  const r = lib.readSeedFile(f);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /parse-failed/);
});

t('负路径：JSON 是数组 → ok:false 且 reason=bad-shape', () => {
  const { f } = fixture([1, 2, 3]);
  const r = lib.readSeedFile(f);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'bad-shape');
});

// ---------- 5. 提取器调用 ----------
console.log('\n[5] 提取器调用（不依赖真实宿主）');

t('负路径：提取器路径不存在 → ok:false, reason=extractor-missing，且不抛错', () => {
  const r = lib.runExtractor(path.join(os.tmpdir(), 'never.json'), 'Z:/no/such/extractor.cjs');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'extractor-missing');
});

t('默认提取器路径指向 probe/host-ls-extract.cjs，且该文件真实存在', () => {
  const p = lib.defaultExtractorPath();
  assert.match(p.replace(/\\/g, '/'), /probe\/host-ls-extract\.cjs$/);
  assert.ok(fs.existsSync(p), `默认提取器应存在：${p}`);
});

// ---------- 6. 与真实提取数据对拍（最有说服力的一条）----------
console.log('\n[6] 与真实提取数据对拍');

t('真实 raw seed（若存在）映射后必须含关键引导 key', () => {
  const rawPath = path.join(process.env.APPDATA || os.homedir(), 'dsh-companion', 'ls-seed.raw.json');
  if (!fs.existsSync(rawPath)) {
    console.log('        （跳过：真实 raw 文件尚不存在，属预期——先跑一次 Companion）');
    return;
  }
  const r = lib.readSeedFile(rawPath);
  assert.strictEqual(r.ok, true, `raw 应可读：${r.reason}`);
  const target = 'http://127.0.0.1:19387';
  const { seed, stats } = lib.normalizeSeed(r.raw, target);
  assert.strictEqual(stats.error, undefined);
  const bucket = seed[target];
  assert.ok(bucket !== undefined, '必须产出目标 origin 桶');
  const keys = Object.keys(bucket);
  console.log(`        真实 raw：${Object.keys(r.raw).length} 个 origin / ${r.bytes} B → 映射后 ${keys.length} 条`);
  console.log(`        origin 明细：${JSON.stringify(stats.rawOrigins)}`);
  for (const k of ['dam-skin', 'dsh-auto-memory.tourDismissed', 'dsh-auto-memory.semWizardDone']) {
    assert.ok(k in bucket, `关键 key 必须映射进来：${k}`);
    console.log(`        ✓ ${k} = ${JSON.stringify(String(bucket[k]).slice(0, 40))}`);
  }
});

console.log(`\n=== 结果：${fail === 0 ? `全绿 PASS（${pass} 项）` : `${fail} 项失败 / 共 ${pass + fail} 项`} ===`);
process.exit(fail === 0 ? 0 : 1);
