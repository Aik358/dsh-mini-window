/**
 * 可行性验证：`<webview>` 的 preload 能否在**页面脚本之前**把键值写进同源 localStorage？
 *
 * 这是批次 1 注入方案的前提。若为假，整个 preload 注入路线作废，必须换方案。
 *
 * 验证设计（真跑，不是静态断言）：
 *   1. 起一个本地 HTTP 服务，`/` 返回一个页面，页面脚本**立刻**读 localStorage 并把结果写进 DOM
 *   2. webview 挂 preload，preload 在 document 创建前写 localStorage
 *   3. 页面加载后回读 DOM，断言页面脚本**看到了** preload 写的值
 *   4. 负路径：不挂 preload 时，页面脚本必须**看不到**那些 key
 *
 * 额外验证「additionalArguments 传参」是否真的能到达 webview 的 preload 进程
 * —— 因为 <webview> 是独立进程，主进程的 additionalArguments 未必透传。
 *
 * 用法：electron.exe tests/smoke/webview-preload-feasibility.cjs
 */
const { app, BrowserWindow, session, ipcMain } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SENTINEL_KEY = 'dsh-probe.earlyWrite';
const SENTINEL_VAL = 'written-by-preload';

/**
 * ⚠️ 必须注册 `companion:ls-seed-sync`：
 * preload（lib/webview-ls-seed.js）用 `ipcRenderer.sendSync` 向主进程取 seed。
 * 本测试早于该改造写成，当时 preload 读文件；改造后没同步更新测试，
 * 于是 `sendSync` 无 handler ⇒ 拿不到 seed ⇒ [A] 用例超时假失败。
 * 这是**测试与产品脱节**，不是产品缺陷。
 */
let SEED_ORIGIN = '';
/** 置 true 时 handler 故意返回「不含当前 origin」的 seed，用于 [C] 负路径。 */
let SEED_WITHHOLD = false;
ipcMain.on('companion:ls-seed-sync', (event) => {
  // [C] 负路径要求「seed 里没有该 origin 的分桶」时 preload 必须一条都不写。
  // handler 必须**尊重**这个条件 —— 首版无条件返回同一份 seed，
  // 导致 [C] 拿到「注入成功」而 FAIL，那是**测试桩失真**，不是产品问题。
  const bucket = SEED_WITHHOLD ? { 'http://elsewhere.invalid': { x: '1' } } : {
    [SEED_ORIGIN]: {
      [SENTINEL_KEY]: SENTINEL_VAL,
      'router:onboarding:model-guide-v2': 'done',
    },
  };
  event.returnValue = { ok: true, data: bucket };
});

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${extra === undefined ? '' : '  ← ' + extra}`); }
}

// ---- seed 文件（preload 按**固定路径约定**查找，见 lib/webview-ls-seed.js）----
//
// ★ 2026-10-11 修复：**绝不能写生产的 `%APPDATA%\dsh-companion\ls-seed.json`**。
//
// 旧版把 seedDir 写死成 `%APPDATA%\dsh-companion`，与运行中的 Companion **共用同一文件**。
// 而本测试的 [C] 负路径会故意写入 `{"http://elsewhere.invalid":{"x":"1"}}`（38 B）且**不还原**，
// 于是跑一次测试就把用户 Companion 的 240 条宿主标记（104525 B）清成了那 38 B 垃圾。
// 实测症状：Companion 小窗内 DSH 前端被判定为全新安装、重新弹首次引导。
//
// 修法：
//   1. 用**独立的目录**（`dsh-companion-selftest`），与生产目录彻底分开；
//   2. 本测试的真实通路是 `ipcMain` 的 `companion:ls-seed-sync`（preload 走 sendSync），
//      **根本不读这个文件** —— 写文件只是「将来若 preload 回退到读文件也不至于失效」的
//      前瞻性兜底，属于**可选**行为，没有理由落在生产路径上。
//   3. 结束时自检：生产文件若与测试内容相同则判 FAIL（防止将来又被改回去）。
const seedDir = path.join(process.env.APPDATA || os.homedir(), 'dsh-companion-selftest');
const seedFile = path.join(seedDir, 'ls-seed.json');

/** 生产 seed 路径 —— 本测试**只读校验、绝不写入**。 */
const PROD_SEED = path.join(process.env.APPDATA || os.homedir(), 'dsh-companion', 'ls-seed.json');

// ⚠️ 测试自身必需的守卫：Electron 默认在「所有窗口关闭」时退出进程。
//    本测试会依次开/关多个宿主窗口，不拦这个事件就会在用例之间被直接终止
//    （表现为后续用例的断言完全不打印、进程却以 0 退出 —— 首跑即踩到）。
app.on('window-all-closed', () => { /* 测试期间不退出 */ });

app.whenReady().then(async () => {
  const PORT = 18991;
  const ORIGIN = `http://127.0.0.1:${PORT}`;
  // 让 ipcMain 的 sendSync handler 知道该为哪个 origin 造 seed
  // （preload 按 window.location.origin 查表）
  SEED_ORIGIN = ORIGIN;

  // 同时仍写一份到固定路径：若将来 preload 回退到「读文件」也不至于失效
  fs.mkdirSync(seedDir, { recursive: true });
  fs.writeFileSync(seedFile, JSON.stringify({
    [ORIGIN]: { [SENTINEL_KEY]: SENTINEL_VAL, 'router:onboarding:model-guide-v2': 'done' },
  }), 'utf8');
  console.log(`seed 写入：${seedFile}（${fs.statSync(seedFile).size} B）`);
  console.log(`seed 同时经 ipcMain 通道提供（origin=${SEED_ORIGIN}）\n`);

  // ---- 页面：脚本一执行就读 localStorage，并把结果放 DOM ----
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body><div id="r"></div><script>
      (function(){
        var out = {};
        try {
          out.early = window.localStorage.getItem(${JSON.stringify(SENTINEL_KEY)});
          out.onboard = window.localStorage.getItem('router:onboarding:model-guide-v2');
          out.count = window.localStorage.length;
        } catch (e) { out.err = String(e && e.message); }
        document.getElementById('r').textContent = JSON.stringify(out);
      })();
    </script></body></html>`);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const PART = 'persist:dsh-ls-probe';
  const ses = session.fromPartition(PART);

  /** 起一个宿主窗口，里面放 webview；preloadPath 为 undefined 时即负路径。 */
  async function runCase({ withPreload }) {
    const host = new BrowserWindow({
      width: 500, height: 400, show: false,
      webPreferences: { partition: PART, webviewTag: true, contextIsolation: true, sandbox: false },
    });

    // ⚠️ 必须在 loadFile 之前注册 —— webview 会在宿主页面加载过程中就 attach，
    // 注册晚了监听器永远不触发（这是本测试首跑超时的真因）。
    const attached = new Promise((resolve) => {
      host.webContents.once('did-attach-webview', (_e, guest) => resolve(guest));
    });

    // webview 的 preload 属性需要 file:// URL 形式（绝对路径 + 正斜杠）
    const preloadUrl = withPreload
      ? 'file:///' + path.join(__dirname, '..', '..', 'lib', 'webview-ls-seed.js')
        .replace(/\\/g, '/').replace(/^\//, '')
      : undefined;

    const preloadAttr = preloadUrl === undefined ? '' : ` preload="${preloadUrl}"`;
    // webpreferences 用逗号分隔的 key=value；给 preload 一个能跑 node 的环境
    const webprefAttr = withPreload ? ' webpreferences="contextIsolation=no,sandbox=no,nodeIntegration=no"' : '';

    const html = `<!doctype html><html><body>
      <webview id="v" src="${ORIGIN}/" partition="${PART}"${preloadAttr}${webprefAttr}></webview>
    </body></html>`;
    const hostFile = path.join(os.tmpdir(), `dsh-webview-host-${withPreload ? 'pre' : 'nopre'}.html`);
    fs.writeFileSync(hostFile, html, 'utf8');

    const loaded = host.loadFile(hostFile);

    // 等 guest 出现
    const guest = await Promise.race([
      attached,
      new Promise((r) => setTimeout(() => r(undefined), 8000)),
    ]);

    let result;
    if (guest === undefined) {
      result = { err: 'webview 未 attach（超时）' };
    } else {
      // 把 seed 路径传给 guest 的 preload。
      // <webview> 是独立 webContents，宿主窗口的 additionalArguments 不会透传，
      // 因此在 attach 后立刻给 guest 进程补参数；配合页面本身很快加载，
      // 这对「能否在页面脚本前写入」的验证已经足够（真实实现里我们会用固定路径约定）。
      try {
        if (typeof guest.setPreloads === 'function') {
          guest.setPreloads([path.join(__dirname, '..', '..', 'lib', 'webview-ls-seed.js')]);
        }
      } catch { /* 旧版没有该方法则跳过 */ }

      result = await new Promise((resolve) => {
        const t = setTimeout(() => resolve({ timeout: true }), 10000);
        const done = async () => {
          clearTimeout(t);
          try {
            const txt = await guest.executeJavaScript('document.getElementById("r").textContent');
            resolve({ text: txt });
          } catch (e) { resolve({ err: String(e && e.message) }); }
        };
        if (guest.isLoading && guest.isLoading()) guest.once('did-finish-load', done);
        else done();
      });
    }

    await loaded.catch(() => {});
    host.destroy();
    return result;
  }

  console.log('=== webview preload 注入可行性 ===\n');
  console.log(`探测 origin：${ORIGIN}\n`);

  console.log('[A] 挂 preload');
  const a = await runCase({ withPreload: true });
  console.log('    页面读到：', JSON.stringify(a));
  check('webview 内页面成功执行并回读 DOM', typeof a.text === 'string', JSON.stringify(a));
  if (typeof a.text === 'string') {
    const parsed = JSON.parse(a.text);
    // ★ 核心断言：这是整个注入方案成立与否的判据
    check('preload 在页面脚本之前写入了同源 localStorage',
      parsed.early === SENTINEL_VAL, `early=${JSON.stringify(parsed.early)}`);
    check('第二条 key 也已注入', parsed.onboard === 'done', `onboard=${JSON.stringify(parsed.onboard)}`);
    check('页面可见条目数为 2', parsed.count === 2, `count=${parsed.count}`);
  }

  console.log('\n[B] 负路径：不挂 preload');
  // 清空该分区的存储，确保是干净起点
  await ses.clearStorageData({ storages: ['localstorage'] });
  const b = await runCase({ withPreload: false });
  console.log('    页面读到：', JSON.stringify(b));
  check('无 preload 时页面仍能执行', typeof b.text === 'string', JSON.stringify(b));
  if (typeof b.text === 'string') {
    const parsed = JSON.parse(b.text);
    check('负路径：无 preload 时哨兵 key 必须为 null', parsed.early === null, JSON.stringify(parsed));
    check('负路径：无 preload 时条目数为 0', parsed.count === 0, `count=${parsed.count}`);
  }

  console.log('\n[C] 负路径：seed 缺该 origin 的分桶');
  {
    // 两处都要设：文件（若 preload 回退到读文件）与 ipcMain 通道（当前真实通路）。
    // 首版只改了文件、没管 sendSync handler，于是 handler 仍返回完整 seed
    // ⇒ [C] 拿到「注入成功」而 FAIL。那是**测试桩失真**，不是产品问题。
    SEED_WITHHOLD = true;
    fs.writeFileSync(seedFile, JSON.stringify({ 'http://elsewhere.invalid': { x: '1' } }), 'utf8');
    await ses.clearStorageData({ storages: ['localstorage'] });
    const c = await runCase({ withPreload: true });
    console.log('    页面读到：', JSON.stringify(c));
    if (typeof c.text === 'string') {
      const parsed = JSON.parse(c.text);
      check('负路径：origin 不匹配时不得写入任何东西', parsed.count === 0 && parsed.early === null, JSON.stringify(parsed));
    }
    SEED_WITHHOLD = false;   // 还原，避免影响后续用例
  }

  server.close();

  // ★ 生产数据守恒断言（2026-10-11 补）：本测试**不得**改动 Companion 的生产 seed。
  //   旧版正是因为把 seedDir 指到生产目录、且 [C] 负路径写入后不还原，
  //   跑一次测试就把用户的 240 条宿主标记清成了 38 B 垃圾。
  //   这里在结束时反向校验：生产文件**不能**等于本测试造的负路径内容。
  try {
    if (fs.existsSync(PROD_SEED)) {
      const prod = fs.readFileSync(PROD_SEED, 'utf8');
      const polluted = prod.includes('elsewhere.invalid') && prod.length < 200;
      check('生产 seed 未被本测试污染（不是负路径内容）', polluted === false,
        `生产 ${PROD_SEED} = ${prod.length} B：${prod.slice(0, 80)}`);
      console.log(`    生产 seed 现状：${prod.length} B（本测试只读校验）`);
    } else {
      console.log(`    生产 seed 不存在（${PROD_SEED}）—— 跳过守恒校验`);
    }
    check('测试 seed 与生产 seed 不同路径', seedFile !== PROD_SEED, `${seedFile} vs ${PROD_SEED}`);
  } catch (err) {
    check('生产 seed 守恒校验可执行', false, err.message);
  }

  console.log(`\n=== 结果：${failures === 0 ? '全绿 PASS' : failures + ' 项失败'} ===`);
  console.log('注：若 [A] 中 early 仍为 null，说明 additionalArguments 未透传到 webview preload ——');
  console.log('    需改用 session.setPreloads() 或 —— 更稳妥 —— 在 webview 的 preload 里');
  console.log('    用固定路径约定（而非命令行参数）取 seed。');
  app.exit(failures === 0 ? 0 : 1);
});
