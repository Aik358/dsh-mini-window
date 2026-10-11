/**
 * client.js 运行时守卫（真执行 factory，非静态断言）
 *
 * 依据用户的硬性验收规则：
 *   凡改动经 `__ModuleLoader__.load({factory})` 注册的前端入口，
 *   必须跑一个**真执行 factory** 的运行时守卫，不能只靠静态断言与 node --check。
 *
 * 本脚本做的事：
 *   1. 在 node:vm 里造一个最小的浏览器沙箱（window / document / location / URLSearchParams / console）
 *   2. 装一个 __ModuleLoader__ 桩，捕获 load({id, factory})
 *   3. **真的调用 factory(...)**，并断言它返回的 exports
 *   4. 真的调用 exports.apply(ctx)，用一个记录型 slots 桩断言注册行为
 *   5. 跑负路径：dsh-mini=0 / 无参数时，探针组件必须返回 null
 *
 * 用法：node tests/smoke/client-factory-guard.cjs
 * 退出码：0 = 全绿；1 = 有断言失败
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CLIENT = path.join(__dirname, '..', '..', 'lib', 'client.js');
const src = fs.readFileSync(CLIENT, 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${extra === undefined ? '' : '  ← ' + extra}`);
  }
}

/** 造一个最小浏览器沙箱并执行 client.js，返回捕获到的注册信息与导出。 */
function runInSandbox(search) {
  const captured = { id: null, factory: null, loadCalls: 0 };

  // applyMiniShell 会碰 documentElement；给一个记录型桩，便于断言它写了什么
  const attrs = {};
  const styleProps = {};
  const documentElement = {
    setAttribute(k, v) { attrs[k] = v; },
    getAttribute(k) { return attrs[k]; },
    style: { setProperty(k, v) { styleProps[k] = v; } },
  };

  const sandbox = {
    console,
    URLSearchParams,
    location: { search },
    document: { documentElement, createElement: () => ({ style: {}, setAttribute() {} }) },
    setTimeout,
    clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.location = { search };
  sandbox.window.__ModuleLoader__ = {
    load(def) {
      captured.loadCalls++;
      captured.id = def.id;
      captured.factory = def.factory;
    },
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(src, context, { filename: 'client.js' });

  return { captured, sandbox, context, attrs, styleProps };
}

/**
 * 假 require：只提供 react/jsx-runtime，其余按「基座没有」抛错（暴露多余依赖）。
 *
 * ★ **jsx/jsxs 必须忠实复刻 React 自动运行时的语义**（2026-10-11 修正）。
 *
 * 旧版桩写成 `jsx: (type, props, key) => ({..., props, key})` —— 参数**个数**对了，
 * 但把第三参**原样塞进 key 字段**、同时把第二参当 props。看着像对的，实际漏了关键一点：
 * **第三参永远不会变成 children**。
 *
 * 真实签名是 `jsx(type, config, maybeKey)`，其中 `maybeKey` **只是 key**。
 * 于是产品代码 `jsx('div', {...}, '小窗模式')` 在真实运行时里渲染出一个
 * **零子节点的空框**，而旧桩因为同样没把第三参当 children，测试**照样全绿** ——
 * 这是「测试与产品共享同一个错误假设」型假绿：
 * 两边都以为第三参是 children，真运行时却不是，于是守卫与产品一起错、且互相佐证。
 *
 * 本桩按 react@19 `cjs/react-jsx-runtime.production.js` 的 `jsxProd` 逐行对齐：
 *   · key 只来自 `maybeKey` 或 `config.key`
 *   · **props 完全来自 config**，children 只能由 `config.children` 提供
 * 这样「把 children 传成第三参」的写法在守卫里就会**真的丢文字**、被断言抓住。
 */
function makeRequire(used) {
  const REACT_ELEMENT_TYPE = Symbol.for('react.transitional.element');
  /** 与 reactProd 同语义：第三参是 key，绝不是 children。 */
  const jsxProd = (type, config, maybeKey) => {
    let key = null;
    if (maybeKey !== undefined) key = '' + maybeKey;
    if (config !== null && config !== undefined && 'key' in config) key = '' + config.key;
    let props = config;
    if (config !== null && config !== undefined && 'key' in config) {
      props = {};
      for (const propName in config) {
        if (propName !== 'key') props[propName] = config[propName];
      }
    }
    if (props === null || props === undefined) props = {};
    return {
      $$typeof: REACT_ELEMENT_TYPE,
      type,
      key,
      ref: props.ref === undefined ? null : props.ref,
      props,
    };
  };
  const jsxRuntime = {
    jsx: jsxProd,
    jsxs: jsxProd,
    Fragment: Symbol('Fragment'),
  };
  return (name) => {
    used.push(name);
    if (name === 'react/jsx-runtime') return jsxRuntime;
    throw new Error(`sandbox require 未提供模块: ${name}`);
  };
}

/**
 * 记录型 slots 桩：捕获 inject 与 register 的调用。
 *
 * ⚠️ 必须模拟 cordis 的 **generator effect** 语义：
 *   官方注册写法是 `ctx.slots.inject(name, function* () { yield ctx.slots.register(...) })`
 *   —— callback 是 generator 函数，**调用它只得到 generator 对象，body 不执行**。
 *   cordis 会迭代该 generator 并收集 yield 出来的 disposer。
 *
 *   证据：官方 @deepseek-ai/dsh-client-ui-brand-official 用的正是这个写法；
 *   若框架不迭代，它的 register 永不执行、品牌图标永不渲染，与它声明的用途矛盾。
 *
 *   因此桩必须 drain（迭代到底），否则守卫会误报「注册 0 个组件」——
 *   这是**守卫的模拟缺陷**，不是被测代码的缺陷。首次跑守卫就踩到了这一点。
 */
function makeSlotsStub() {
  const log = { injects: [], registers: [] };

  /** 按 cordis effect 语义执行 callback：普通函数直接调；generator 则迭代到底。 */
  function runEffect(cb) {
    const out = cb();
    if (out !== null && typeof out === 'object' && typeof out.next === 'function') {
      let step = out.next();
      while (!step.done) step = out.next();
    }
    return out;
  }

  return {
    log,
    slots: {
      inject(name, cb) {
        log.injects.push(name);
        if (typeof cb === 'function') runEffect(cb);
      },
      register(decl, Component) {
        log.registers.push({ decl, Component });
        return () => {};
      },
    },
  };
}

console.log('=== client.js 运行时守卫 ===');
console.log(`文件: ${CLIENT}  ${src.length} B\n`);

// ---------- A. mini 模式（?dsh-mini=1）----------
console.log('[A] location.search = "?dsh-mini=1"');
{
  const { captured, attrs, styleProps } = runInSandbox('?dsh-mini=1');
  check('__ModuleLoader__.load 被调用 1 次', captured.loadCalls === 1, `实际 ${captured.loadCalls}`);
  check('注册 id 正确（= 完整包名 @a9i5k4/dsh-mini-window）', captured.id === '@a9i5k4/dsh-mini-window', `实际 ${JSON.stringify(captured.id)}`);
  check('factory 是函数', typeof captured.factory === 'function');

  const used = [];
  const exportsObj = captured.factory(makeRequire(used));
  check('factory 真执行后返回 exports 对象', exportsObj !== null && typeof exportsObj === 'object');
  check('require 只请求了 react/jsx-runtime', used.length === 1 && used[0] === 'react/jsx-runtime', `实际 ${JSON.stringify(used)}`);
  check('导出 apply 是函数', typeof exportsObj.apply === 'function');
  check('导出 inject 是数组', Array.isArray(exportsObj.inject));
  check("inject 恰为 ['slots']", JSON.stringify(exportsObj.inject) === JSON.stringify(['slots']), `实际 ${JSON.stringify(exportsObj.inject)}`);
  check('isMiniMode() 为 true', exportsObj.isMiniMode() === true);

  // 真调用 apply
  const stub = makeSlotsStub();
  exportsObj.apply({ slots: stub.slots });
  check(
    "apply 调用了 slots.inject('shell.overlay')",
    stub.log.injects.length === 1 && stub.log.injects[0] === 'shell.overlay',
    JSON.stringify(stub.log.injects),
  );
  check('apply 注册了 1 个组件', stub.log.registers.length === 1, `实际 ${stub.log.registers.length}`);
  check(
    "注册声明 name === 'shell.overlay'",
    stub.log.registers[0]?.decl?.name === 'shell.overlay',
    JSON.stringify(stub.log.registers[0]?.decl),
  );
  // ★ list slot 必须带 id —— 实测踩过：缺 id 会抛
  //   `Uncaught Error: list slot "shell.overlay" requires options.id`
  //   且是未捕获异常，直接中断整个 AppFrame 渲染（症状：surfaces 全空）。
  //   这条断言就是防止它悄悄回来。
  check(
    '★ list slot 注册必须带 id（缺 id 会抛异常并中断 AppFrame 渲染）',
    typeof stub.log.registers[0]?.decl?.id === 'string' && stub.log.registers[0].decl.id.length > 0,
    `decl = ${JSON.stringify(stub.log.registers[0]?.decl)}`,
  );
  check(
    'overlay id 以包名为前缀（避免与其他插件的 id 撞车）',
    // ★ 断言口径：id 形如 `<包名>.badge`。包名已改为 scoped（@a9i5k4/dsh-mini-window），
    //   故不能再按裸名 startsWith('dsh-mini-window') 判 —— 那样会**恒假**。
    //   改为断言「以包名末段为前缀」，包名怎么改名它都跟着成立。
    typeof stub.log.registers[0]?.decl?.id === 'string'
      && stub.log.registers[0].decl.id.startsWith('dsh-mini-window'),
    `id = ${JSON.stringify(stub.log.registers[0]?.decl?.id)}`,
  );
  // 负路径（契约硬约束）：绝不允许注册到 root —— 那会遮蔽整个 AppFrame
  check(
    '禁止注册到 root（会遮蔽 AppFrame）',
    stub.log.injects.includes('root') === false
      && stub.log.registers.every((r) => r.decl?.name !== 'root'),
    JSON.stringify(stub.log.injects),
  );

  // ★ mini 模式下必须真的给 html 打上标记（批次 2 的核心副作用）
  check('mini 模式下 html 被打上 data-dsh-mini="1"', attrs['data-dsh-mini'] === '1', JSON.stringify(attrs));
  check('mini 模式下注入了 --dsh-mini-topbar = 55px（参考实现实测顶栏高）',
    styleProps['--dsh-mini-topbar'] === '55px', JSON.stringify(styleProps));
  check('mini 模式下注入了 --dsh-mini-panel = #1A1A1A（参考实现实测面板底）',
    styleProps['--dsh-mini-panel'] === '#1A1A1A', JSON.stringify(styleProps));
  check('mini 模式下注入了 --dsh-mini-composer = #232528（参考实现实测输入卡底）',
    styleProps['--dsh-mini-composer'] === '#232528', JSON.stringify(styleProps));

  // 角标：**默认不渲染**（2026-10-11 改 · 逐像素比对驱动）
  //
  // 参考小窗 18 个元素里没有这个角标，且它落在卡片之外的黑色画布上
  // （实测：右下角该区域参考实现非黑像素 0 个、旧版实测 420 个）。
  // ⇒ 产品改为「只有 ?dsh-mini-debug=1 才显示」，保留调试能力、成品版面与参考实现一致。
  const Badge = stub.log.registers[0]?.Component;
  check('角标组件是函数', typeof Badge === 'function');
  check('mini 模式下**默认不渲染**角标（参考实现版面里没有它）',
    Badge() === null, JSON.stringify(Badge()));
  check('isMiniDebug() 在无 debug 参数时为 false', exportsObj.isMiniDebug() === false);
  check('导出 isMiniDebug（供调试参数判定）', typeof exportsObj.isMiniDebug === 'function');
}

// ---------- A1b. 调试角标：?dsh-mini-debug=1 时才渲染，且内容必须真的渲染出来 ----------
console.log('\n[A1b] 调试角标（显式开启）必须真的有文字 —— 空框缺陷的回归项');
{
  const { captured, attrs, styleProps } = runInSandbox('?dsh-mini=1&dsh-mini-debug=1');
  const ex = captured.factory(makeRequire([]));
  const stub = makeSlotsStub();
  ex.apply({ slots: stub.slots });
  check('带 debug 参数时 isMiniDebug() 为 true', ex.isMiniDebug() === true);
  const Badge = stub.log.registers[0]?.Component;
  const vnode = Badge();
  check('带 debug 参数时角标渲染非 null', vnode !== null && vnode !== undefined);
  check('角标带 data-dsh-mini-badge 标记', vnode?.props?.['data-dsh-mini-badge'] === '1', JSON.stringify(vnode?.props));
  check('角标是 click-through（pointerEvents:none，绝不挡交互）',
    vnode?.props?.style?.pointerEvents === 'none', JSON.stringify(vnode?.props?.style));

  // ★ 角标必须**真的有文字**（2026-10-11 真宿主像素取证补的断言）。
  //
  // 旧守卫只断言「元素存在 + 有标记 + click-through」，全都过了，但真宿主上
  // 这个角标其实是个**空框**（实测 16×8px、内容 0×0）：文字被当成 jsx 的第三参
  // 传进去，而自动运行时的第三参是 **key**，于是 children 永远是空的。
  // ⇒ 「元素存在」不等于「内容渲染出来了」，必须直接断言 children。
  check('角标 children 非空（文字真的会渲染，而不是一个空框）',
    typeof vnode?.props?.children === 'string' && vnode.props.children.length > 0,
    `children = ${JSON.stringify(vnode?.props?.children)}`);
  check('角标文字为「小窗模式」', vnode?.props?.children === '小窗模式',
    JSON.stringify(vnode?.props?.children));
  // 第三参是 key，不是 children —— 文字若落在 key 上就说明写法又错了
  check('角标文字不得落在 key 上（jsx 第三参是 key，不是 children）',
    vnode?.key === null || vnode?.key === undefined,
    `key = ${JSON.stringify(vnode?.key)}`);
  check('调试角标同时仍注入 mini 外壳（两种参数可共存）',
    attrs['data-dsh-mini'] === '1' && styleProps['--dsh-mini-panel'] === '#1A1A1A', JSON.stringify(attrs));
}

// ---------- A2. 负路径：mini 参数必须精确匹配 ----------
console.log('\n[A2] 负路径：仅有参数名或值不对时，不得进入 mini 模式');
for (const [label, search] of [
  ['?dsh-mini（无值）', '?dsh-mini'],
  ['?dsh-mini=0', '?dsh-mini=0'],
  ['?dsh-mini=true', '?dsh-mini=true'],
  ['?dsh-mini=11', '?dsh-mini=11'],
  ['?dshmini=1（参数名不同）', '?dshmini=1'],
  ['?dsh-mini=1&x=2（多参）→ 应 true', '?dsh-mini=1&x=2'],
]) {
  const { captured, attrs } = runInSandbox(search);
  const ex2 = captured.factory(makeRequire([]));
  const expected = label.endsWith('应 true');
  check(`${label} → isMiniMode()=${expected}`,
    ex2.isMiniMode() === expected, `实际 ${ex2.isMiniMode()}`);
  if (!expected) {
    const stub2 = makeSlotsStub();
    ex2.apply({ slots: stub2.slots });
    check(`  ${label} → 不得给 html 打 mini 标记（不误伤主界面）`,
      attrs['data-dsh-mini'] === undefined, JSON.stringify(attrs));
    check(`  ${label} → 角标返回 null`,
      stub2.log.registers[0].Component() === null);
  }
}

// ---------- B. 负路径：非 mini 模式必须什么都不渲染 ----------
console.log('\n[B] 负路径：location.search = "" （无参数）');
{
  const { captured } = runInSandbox('');
  const exportsObj = captured.factory(makeRequire([]));
  const stub = makeSlotsStub();
  exportsObj.apply({ slots: stub.slots });
  const Badge = stub.log.registers[0]?.Component;
  check('非 mini 模式下角标返回 null（不得误伤主界面）', Badge() === null, JSON.stringify(Badge()));
  check('isMiniMode() 为 false', exportsObj.isMiniMode() === false);
  check('非 mini 模式下仍注册 shell.overlay（不带参数也要能正常工作）',
    stub.log.registers.length === 1 && stub.log.injects[0] === 'shell.overlay');
}

console.log('\n[C] 负路径：location.search = "?dsh-mini=0"');
{
  const { captured } = runInSandbox('?dsh-mini=0');
  const exportsObj = captured.factory(makeRequire([]));
  check('dsh-mini=0 时 isMiniMode() 为 false', exportsObj.isMiniMode() === false);
  const stub = makeSlotsStub();
  exportsObj.apply({ slots: stub.slots });
  check('dsh-mini=0 时探针返回 null', stub.log.registers[0].Component() === null);
}

console.log('\n[D] 负路径：location.search 取不到 / 是坏值（异常兜底）');
{
  // 被测函数动态读 globalThis.location，因此直接改沙箱全局即可触达各分支。
  const { captured: cap2, context: ctx2 } = runInSandbox('?dsh-mini=1');
  const ex2 = cap2.factory(makeRequire([]));

  const cases = [
    { label: 'search 为 undefined', value: undefined },
    { label: 'search 为 null', value: null },
    { label: 'search 为数字', value: 123 },
    { label: 'search 为畸形串 "?dsh-mini"', value: '?dsh-mini' },
    { label: 'search 为空串', value: '' },
  ];
  for (const c of cases) {
    vm.runInContext(`globalThis.location = { search: ${JSON.stringify(c.value)} };`, ctx2);
    let r, threw = false;
    try { r = ex2.isMiniMode(); } catch { threw = true; }
    check(`${c.label} → 返回 false 且不抛错`, threw === false && r === false, `threw=${threw} r=${JSON.stringify(r)}`);
  }

  // location 整个不可用（删掉）
  vm.runInContext('delete globalThis.location;', ctx2);
  let threw = false, r;
  try { r = ex2.isMiniMode(); } catch { threw = true; }
  check('location 不存在 → 返回 false 且不抛错', threw === false && r === false, `threw=${threw} r=${JSON.stringify(r)}`);
}

console.log(`\n=== 结果：${failures === 0 ? '全绿 PASS' : failures + ' 项失败 FAIL'} ===`);
process.exit(failures === 0 ? 0 : 1);
