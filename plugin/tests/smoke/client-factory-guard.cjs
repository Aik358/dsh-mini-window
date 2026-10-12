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

/**
 * 异步断言收集器。
 *
 * ⚠️ 本文件是 `.cjs`（CommonJS）⇒ 不支持顶层 await。
 * 涉及 Promise 的断言（如 PiP 降级路径）统一 push 到这里，
 * 在文件末尾 `await Promise.all(pending)` 之后再统计结果。
 */
const pending = [];

/** 造一个最小浏览器沙箱并执行 client.js，返回捕获到的注册信息与导出。 */
/**
 * 建一个**够用的 DOM 桩**，让悬浮球代码能真跑（而不是走进 catch 返回 null）。
 *
 * ## 为什么必须补这个
 *
 * 原沙箱的 `createElement` 只返回 `{style:{}, setAttribute(){}}` —— 没有
 * `head`/`body`/`appendChild`/`id`/`classList`，悬浮球一进去就抛异常、被自己的
 * try/catch 吞掉、返回 null。那样断言只能验证「返回 null」，**验不到真实逻辑**。
 *
 * 本桩记录所有创建的节点与事件监听，供后续做**真调用断言**
 * （挂载返回函数、幂等、位置夹紧、边缘吸附、卸载清理）。
 */
function makeDomStub() {
  const created = [];
  const listeners = new Map();

  function makeEl(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      id: '',
      className: '',
      title: '',
      innerHTML: '',
      textContent: '',
      dataset: {},
      childNodes: [],
      parentNode: null,
      attrs: {},
      style: {
        _p: {},
        setProperty(k, v) { this._p[k] = v; },
        getPropertyValue(k) { return this._p[k]; },
      },
      setAttribute(k, v) { el.attrs[k] = String(v); },
      getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
      removeAttribute(k) { delete el.attrs[k]; },
      /**
       * ★ 2026-10-11 补 `classList`（批次22 顶栏需要）。
       *
       * 此前桩没有它 ⇒ 产品代码里 `t2.classList.add('active')` 直接抛
       * ⇒ 被 `mountMiniTopbar` 的 try/catch 吞掉 ⇒ 整个顶栏**静默不挂载**。
       * 症状是守卫报「mountMiniTopbar() 真返回 true ← false」，
       * 而根因**是桩不给力，不是产品缺陷**（与上次 `querySelector` 同类）。
       */
      classList: {
        _set: new Set(),
        add(c) { this._set.add(String(c)); },
        remove(c) { this._set.delete(String(c)); },
        contains(c) { return this._set.has(String(c)); },
        toggle(c, force) {
          const on = force === undefined ? !this._set.has(String(c)) : !!force;
          if (on) this._set.add(String(c)); else this._set.delete(String(c));
          return on;
        },
      },
      appendChild(c) { c.parentNode = el; el.childNodes.push(c); return c; },
      removeChild(c) {
        const i = el.childNodes.indexOf(c);
        if (i >= 0) el.childNodes.splice(i, 1);
        c.parentNode = null;
        return c;
      },
      addEventListener(type, fn) {
        const key = el.id || el.tagName;
        if (!listeners.has(key)) listeners.set(key, []);
        listeners.get(key).push({ type, fn });
      },
      removeEventListener(type, fn) {
        const key = el.id || el.tagName;
        const arr = listeners.get(key) || [];
        const i = arr.findIndex((x) => x.type === type && x.fn === fn);
        if (i >= 0) arr.splice(i, 1);
      },
      /**
       * 触发监听器。
       *
       * ★ 2026-10-11 兼容两种签名（此前只支持 `(type, ev)`）：
       *   · `dispatch('click', ev)`   —— 桩历史签名
       *   · `dispatch({type:'click'})` —— 贴近真实 DOM 的 `dispatchEvent(event)`
       *
       * 为什么必须兼容：我按真实 DOM 语义写了单对象调用，桩却要求两个参数
       * ⇒ `x.type === type` 变成 `'click' === {…}` ⇒ **恒 false** ⇒
       * 「点按钮真的打了路由」这类断言**无辜全红**（症状看着像产品没接线）。
       * 这已是本项目第 3 次栽在「桩的 API 形状与真实 DOM 不一致」上。
       */
      dispatch(typeOrEv, ev) {
        const type = (typeOrEv && typeof typeOrEv === 'object') ? typeOrEv.type : typeOrEv;
        const payload = (typeOrEv && typeof typeOrEv === 'object') ? typeOrEv : (ev || {});
        const key = el.id || el.tagName;
        const arr = (listeners.get(key) || []).filter((x) => x.type === type);
        for (const x of arr) x.fn(payload);
        return arr.length;
      },
      // querySelectorAll / querySelector 在桩里只做**按标签名**的递归查找。
      // ★ 2026-10-11 补 `querySelector`：此前只有 `querySelectorAll` 且恒返回 []，
      //   导致「浮层里有 iframe」这类断言**必然红**（桩不给力，不是产品缺陷）。
      querySelectorAll(sel) {
        const s = String(sel || '');
        // ★ 2026-10-11 补**属性选择器** `[attr="value"]`。
        //   产品代码用 `querySelector('[data-dsh-responsive-part="sidebar-toggle"]')`
        //   找官方侧栏开关 —— 只按标签名匹配的旧桩必然找不到 ⇒ 断言无辜变红。
        //   这里支持 `[attr]` 与 `[attr="v"]` 两种写法，与真实 DOM 语义一致。
        const m = /^\[([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]$/.exec(s);
        if (m) {
          const attr = m[1];
          const want = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : null);
          const out = [];
          (function walk(n) {
            for (const c of n.childNodes || []) {
              const has = attr in (c.attrs || {});
              if (has && (want === null || String(c.attrs[attr]) === want)) out.push(c);
              walk(c);
            }
          })(el);
          return out;
        }
        const want = s.toUpperCase();
        const out = [];
        (function walk(n) {
          for (const c of n.childNodes || []) {
            if (String(c.tagName).toUpperCase() === want) out.push(c);
            walk(c);
          }
        })(el);
        return out;
      },
      querySelector(sel) {
        return el.querySelectorAll(sel)[0] || null;
      },
    };
    created.push(el);
    return el;
  }

  const documentElement = makeEl('html');
  const head = makeEl('head');
  const body = makeEl('body');
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const doc = {
    documentElement,
    head,
    body,
    createElement: (tag) => makeEl(tag),
    /**
     * ★ 2026-10-11 补 `document.querySelector` / `querySelectorAll`。
     *
     * 此前 **document 上根本没有这两个方法** ⇒ 产品代码里
     * `doc.querySelector('[data-dsh-responsive-part="sidebar-toggle"]')`
     * 直接抛 `TypeError: doc.querySelector is not a function`
     * ⇒ 被 catch 吞掉 ⇒ 断言无辜变红（**桩不给力，不是产品缺陷**）。
     * 语义与真实 DOM 一致：从 documentElement 开始递归。
     */
    querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
    querySelector: (sel) => documentElement.querySelector(sel),
    getElementById(id) {
      const stack = [documentElement];
      while (stack.length) {
        const n = stack.pop();
        if (n.id === id) return n;
        for (const c of n.childNodes) stack.push(c);
      }
      return null;
    },
  };

  return { doc, documentElement, head, body, created, listeners, makeEl };
}

function runInSandbox(search, opts) {
  const o = opts || {};
  const captured = { id: null, factory: null, loadCalls: 0 };

  // applyMiniShell 会碰 documentElement；给一个记录型桩，便于断言它写了什么
  const attrs = {};
  const styleProps = {};
  const dom = makeDomStub();
  // DOM 语义修正（留痕）：真实 `Element.getAttribute()` 在属性不存在时返回 **null**，
  // 而原先的桩直接 `return attrs[k]` ⇒ 返回 **undefined**，让「没有该属性」的断言
  // 无辜变红（attrs={} 明明证明属性不存在）。这里让桩遵守真实语义。
  dom.documentElement.setAttribute = (k, v) => { attrs[k] = v; };
  dom.documentElement.getAttribute = (k) => (k in attrs ? attrs[k] : null);
  dom.documentElement.style.setProperty = (k, v) => { styleProps[k] = v; };

  const sandbox = {
    console,
    URLSearchParams,
    URL,
    location: { search, href: 'http://127.0.0.1:19387/?dsh-mini=1', assign() {} },
    document: dom.doc,
    setTimeout,
    clearTimeout,
    innerWidth: o.innerWidth || 1200,
    innerHeight: o.innerHeight || 800,
    addEventListener() {},
    removeEventListener() {},
    localStorage: (() => {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: (k) => { m.delete(k); },
      };
    })(),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.location = sandbox.location;
  sandbox.window.__ModuleLoader__ = {
    load(def) {
      captured.loadCalls++;
      captured.id = def.id;
      captured.factory = def.factory;
    },
  };

  const context = vm.createContext(sandbox);
  // ★★ 必须用**严格模式**执行（2026-10-11 事故固化）。
  //
  //   宿主的 client bundle 是 **ES module** ⇒ **天然严格模式**；
  //   而 `vm.runInContext` 默认是**非严格**的 sloppy 模式。两者语义不同：
  //     · 未声明就赋值：sloppy 建全局变量、strict 抛 ReferenceError
  //     · 删除不可删属性、重复参数名、`with` 等：sloppy 放行、strict 报错
  //     · 给只读属性赋值：sloppy 静默失败、strict 抛 TypeError
  //   ⇒ 守卫若跑在 sloppy 下，**宿主必炸的代码在守卫里全绿**，守卫等于失守。
  //
  //   做到这一点有两种写法：`runInContext('"use strict";' + src)` 或
  //   `new vm.Script(src, { ... })` 前缀。此处用前者（最直白、不易被改坏）。
  vm.runInContext("'use strict';\n" + src, context, { filename: 'client.js' });

  return { captured, sandbox, context, attrs, styleProps, dom };
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

// ---------- E. 悬浮球 + Document PiP（2026-10-11 零下载方案）----------
//
// ★ 验收纪律：**真调用 → 断言返回值/副作用**，不接受「源码含某字符串」这类恒真守卫。
//   本节全部断言都建立在「真调 mountBall() / 真派发事件 / 再读 DOM 桩状态」之上。
console.log('\n[E] 悬浮球（纯 DOM，零下载）—— 真调用与副作用断言');
{
  const { captured, dom, sandbox } = runInSandbox('?dsh-mini=1');
  const ex = captured.factory(makeRequire([]));

  // 导出面（守卫用）
  check('导出 mountBall', typeof ex.mountBall === 'function');
  check('导出 isPipAvailable', typeof ex.isPipAvailable === 'function');
  check('导出 openPipWindow', typeof ex.openPipWindow === 'function');

  // ---- E1. 真调用：挂载 ----
  const unmount = ex.mountBall();
  check('mountBall() 真调用后返回卸载函数', typeof unmount === 'function', `实际 ${typeof unmount}`);

  const ball = dom.doc.getElementById(ex.BALL_ID);
  check('挂载后 DOM 里真的存在悬浮球节点', ball !== null);
  check('球被挂到 body 上', ball !== null && ball.parentNode === dom.body);
  check('球带 role=button（可访问性）', ball !== null && ball.getAttribute('role') === 'button');
  check('球带 tabindex=0（可键盘激活）', ball !== null && ball.getAttribute('tabindex') === '0');
  check('球图标是内联 SVG（不依赖图片资源）',
    ball !== null && /<svg[\s\S]*<\/svg>/.test(ball.innerHTML));
  check('球的 icon 里没有 <img>（杜绝资源依赖）',
    ball !== null && !/<img/i.test(ball.innerHTML));

  // 样式表真的注入了。
  // ★ 判据更新（2026-10-11 行为变更）：原先断「规则全部以 html[data-dsh-mini] 开头」——
  //   那是**旧设计**（球只在 mini 模式挂）。现改为「任何页面都挂球」，
  //   所以球的样式必须**不依赖** mini 祖先选择器，否则主界面里球是无样式裸节点。
  //   这是「改判据」而非「改回代码」：旧判据守的是已废弃的行为。
  const styleEl = dom.doc.getElementById(ex.BALL_STYLE_ID);
  check('悬浮球样式表已注入', styleEl !== null);
  check('球样式不依赖 html[data-dsh-mini] 祖先（主界面里也要有样式）',
    styleEl !== null && styleEl.textContent.indexOf('html[data-dsh-mini]') === -1,
    styleEl ? JSON.stringify(styleEl.textContent.slice(0, 80)) : 'null');
  check('球样式每条规则都直接锚在 #<ballId> 上',
    styleEl !== null && styleEl.textContent.split('}').filter((s) => s.trim()).every((s) => s.indexOf('#' + ex.BALL_ID) >= 0),
    styleEl ? JSON.stringify(styleEl.textContent.slice(0, 120)) : 'null');

  // ---- E2. 真调用：拖动 → 位置变化 → 松手吸附 ----
  //
  // ⚠️ 断言修正（留痕）：最初写「拖到 (20,300) 后应吸附到左边」—— **断言错**。
  //   球默认在右侧 left=1140（vw=1200）；dx = 20-100 = -80 ⇒ left=1060，
  //   球心 1082 仍在右半屏 ⇒ 吸附回右边是**正确行为**。
  //   要跨到左半屏需 dx < -482。这里改为**拖足距离**再断言。
  const dispatch = (type, ev) => typeof ball.dispatch === 'function' && ball.dispatch(type, ev);
  check('球上注册了 pointerdown 处理器', dispatch('pointerdown', { clientX: 1140, clientY: 400, preventDefault() {} }) > 0);
  dispatch('pointermove', { clientX: 300, clientY: 400, preventDefault() {} });
  const draggedLeft = parseFloat(ball.style.left);
  check('拖动后 left 真的变了（不再是初始值）', Number.isFinite(draggedLeft) && draggedLeft !== 1140, `left=${ball.style.left}`);
  const handled = dispatch('pointerup', { clientX: 300, clientY: 400, preventDefault() {} });
  check('松手后吸附到**左**边缘（拖足距离跨过半屏）',
    Math.abs(parseFloat(ball.style.left) - ex.ballSideLeft('left')) < 0.5,
    `left=${ball.style.left} 期望=${ex.ballSideLeft('left')}`);
  check('pointerup 处理器真的执行了', handled > 0);

  // ---- E3. 真调用：位置夹紧（负路径：极端值不得越界）----
  check('clampBallTop(-9999) 被夹到上边界', ex.clampBallTop(-9999) === 16, String(ex.clampBallTop(-9999)));
  check('clampBallTop(99999) 被夹到下边界',
    ex.clampBallTop(99999) === Math.max(16, (sandbox.innerHeight || 800) - ex.BALL_SIZE - 16),
    String(ex.clampBallTop(99999)));

  // ---- E4. 真调用：位置记忆（localStorage 往返）----
  ex.saveBallPos('right', 123);
  const back = ex.readBallPos();
  check('saveBallPos → readBallPos 往返一致',
    back && back.side === 'right' && Math.round(back.top) === 123, JSON.stringify(back));
  // 负路径：存坏数据不得抛错，返回 null
  sandbox.localStorage.setItem(ex.BALL_POS_KEY, '{坏 JSON');
  check('存储里是坏 JSON 时 readBallPos 返回 null 且不抛错', ex.readBallPos() === null);
  sandbox.localStorage.setItem(ex.BALL_POS_KEY, JSON.stringify({ side: 'xxx', top: 'abc' }));
  check('存储里 side/top 非法时 readBallPos 返回 null', ex.readBallPos() === null);

  // ---- E5. 真调用：卸载必须清理干净（不留节点/样式）----
  unmount();
  check('卸载后球节点从 DOM 移除', dom.doc.getElementById(ex.BALL_ID) === null);
  check('卸载后样式表也从 DOM 移除', dom.doc.getElementById(ex.BALL_STYLE_ID) === null);

  // ---- E6. 幂等：重复挂载不叠加 ----
  const u1 = ex.mountBall();
  const u2 = ex.mountBall();
  const balls = [];
  (function walk(n) { if (n.id === ex.BALL_ID) balls.push(n); for (const c of n.childNodes) walk(c); })(dom.documentElement);
  check('重复 mountBall 后 DOM 里仍只有 1 个球', balls.length === 1, `实际 ${balls.length} 个`);
  u1(); u2();

  // ---- E7. Document PiP 能力探测（真调用，非静态断言）----
  //   沙箱里默认**没有** documentPictureInPicture ⇒ 必须返回 false
  check('沙箱无 documentPictureInPicture 时 isPipAvailable() 为 false（负路径）',
    ex.isPipAvailable() === false);
  //   补上对象但缺 requestWindow ⇒ 仍必须 false（判据要求「方法存在」）
  sandbox.documentPictureInPicture = {};
  check('对象存在但缺 requestWindow 时 isPipAvailable() 仍为 false（判据不只看存在）',
    ex.isPipAvailable() === false);
  //   补齐方法 ⇒ 必须 true
  let requested = 0;
  sandbox.documentPictureInPicture = {
    requestWindow(cfg) { requested++; return Promise.resolve({ document: { body: { innerHTML: '', style: {}, appendChild() {} }, createElement: () => ({ style: {}, setAttribute() {}, set src(v) { this._s = v; } }) }, addEventListener() {} }); },
  };
  check('补齐 requestWindow 后 isPipAvailable() 为 true',
    ex.isPipAvailable() === true);
  check('球的 data-pip 标记随能力更新（重新挂载后为 supported）', (() => {
    const u = ex.mountBall();
    const b = dom.doc.getElementById(ex.BALL_ID);
    const v = b && b.dataset ? b.dataset.pip : null;
    u();
    return v === 'supported';
  })(), '期望 supported');
}

console.log('\n[E2] ★ 主界面也要有球：**不带任何参数时照样创建悬浮球**');
{
  // ★ 2026-10-11 用户实测反馈驱动的**行为变更**（原断言是反的，已改写）：
  //   原设计「非 mini 模式不创建球」—— 实测后果是用户在**自己的 DSH 主界面**
  //   完全看不到球，只有 Companion 小窗（它加载 ?dsh-mini=1）里才有。
  //   而「点球弹出置顶小窗」本来就是给主界面用的 ⇒ 必须先进入小窗模式才能开小窗，
  //   是**逻辑闭环错误**。现改为**任何页面都挂球**。
  const { captured, dom, attrs } = runInSandbox('');   // 不带任何参数
  const ex = captured.factory(makeRequire([]));
  const stub = makeSlotsStub();
  ex.apply({ slots: stub.slots });
  const ball = dom.doc.getElementById(ex.BALL_ID);
  check('不带 ?dsh-mini=1 时**仍然有**球（这是本轮的行为修正）', ball !== null);
  check('球样式表也注入了', dom.doc.getElementById(ex.BALL_STYLE_ID) !== null);
  check('不带参数时 html 上没有 data-dsh-mini（mini 外观不生效）',
    attrs['data-dsh-mini'] === undefined && dom.documentElement.getAttribute('data-dsh-mini') === null,
    `attrs=${JSON.stringify(attrs)} getAttr=${JSON.stringify(dom.documentElement.getAttribute('data-dsh-mini'))}`);
  // 球的 CSS 不得再依赖 mini 祖先选择器，否则主界面里球会是无样式裸节点。
  const css = dom.doc.getElementById(ex.BALL_STYLE_ID).textContent;
  check('球样式**不依赖** html[data-dsh-mini] 前缀（否则主界面里球没样式）',
    css.indexOf('html[data-dsh-mini] #' + ex.BALL_ID) === -1);
  check('球样式直接用 #<ballId> 选择器', css.indexOf('#' + ex.BALL_ID + '{') >= 0);
}

console.log('\n[E2c] 逃生开关：?dsh-ball=0 时**不挂**球（用户可自行关掉）');
{
  const { captured, dom } = runInSandbox('?dsh-ball=0');
  const ex = captured.factory(makeRequire([]));
  ex.apply({ slots: makeSlotsStub().slots });
  check('带 ?dsh-ball=0 时 DOM 里没有球', dom.doc.getElementById(ex.BALL_ID) === null);
  check('带 ?dsh-ball=0 时也没有注入球样式表', dom.doc.getElementById(ex.BALL_STYLE_ID) === null);
  // 负路径的负路径：参数值不是 '0' 时依然要挂球（避免"有参数就不挂"的半修）
  const r2 = runInSandbox('?dsh-ball=1');
  const ex2 = r2.captured.factory(makeRequire([]));
  ex2.apply({ slots: makeSlotsStub().slots });
  check('带 ?dsh-ball=1 时**仍然有**球（只有 =0 才关）', r2.dom.doc.getElementById(ex2.BALL_ID) !== null);
}

console.log('\n[E4] ★ 回归：球 id 里**不能含 `.`**（否则 CSS 选择器 `#a.b` 被解析成 id=a 且 class=b，规则全不匹配）');
{
  const { captured, dom } = runInSandbox('?dsh-mini=1');
  const ex = captured.factory(makeRequire([]));

  // ① id 本身不得含点号（点号是 CSS class 分隔符）
  check('球 id 不含 "."（含点号会让 #id 选择器变成 id+class 组合，规则静默失效）',
    ex.BALL_ID.indexOf('.') === -1, '实际 BALL_ID = ' + ex.BALL_ID);

  // ② 样式表里每条选择器引用的 id 都必须与真实 id 一致
  const u = ex.mountBall();
  const styleEl = dom.doc.getElementById(ex.BALL_STYLE_ID);
  const css = styleEl ? styleEl.textContent : '';
  check('样式表按 "id=真实球 id" 精确引用（选择器里出现 #' + ex.BALL_ID + '）',
    css.indexOf('#' + ex.BALL_ID) >= 0, '前 80 字符 = ' + JSON.stringify(css.slice(0, 80)));

  // ③ **真解析判据**：把选择器交给真实 URL 解析，确认它只含 id、不含 class 组合。
  //    做法：用沙箱外的 node 侧简单校验 —— 选择器里 "#xxx" 之后若紧跟 `.`，
  //    说明它被当成了「id.xxx + class」的组合选择器。
  const badSel = css.split(/[{,}]/).map((s) => s.trim())
    .filter((s) => s.indexOf('#' + ex.BALL_ID) >= 0 && /#[^.#,\s]+\.[A-Za-z]/.test(s));
  check('没有任何选择器把球 id 误写成 "id.class" 组合形式',
    badSel.length === 0, JSON.stringify(badSel.slice(0, 2)));

  // ④ 卸载干净
  u();
  check('卸载后球与样式表都清掉', dom.doc.getElementById(ex.BALL_ID) === null && dom.doc.getElementById(ex.BALL_STYLE_ID) === null);
}

console.log('\n[E2b] 拖动吸附：**拖足距离**才能跨半屏（上一次断言拖得不够远，是断言错不是代码错）');
{
  const { captured, dom, sandbox } = runInSandbox('?dsh-mini=1');
  const ex = captured.factory(makeRequire([]));
  const unmount = ex.mountBall();
  const ball = dom.doc.getElementById(ex.BALL_ID);

  // 从默认（右侧 1140）拖到左半屏：需要 dx < -(1082-600) ≈ -482
  ball.dispatch('pointerdown', { clientX: 1140, clientY: 400, preventDefault() {} });
  ball.dispatch('pointermove', { clientX: 300, clientY: 400, preventDefault() {} });
  const midLeft = parseFloat(ball.style.left);
  check('拖到左半屏后 left 落到左侧区间', midLeft < (sandbox.innerWidth || 1200) / 2, `left=${midLeft}`);
  ball.dispatch('pointerup', { clientX: 300, clientY: 400, preventDefault() {} });
  check('松手后吸附到**左**边缘',
    Math.abs(parseFloat(ball.style.left) - ex.ballSideLeft('left')) < 0.5,
    `left=${ball.style.left} 期望=${ex.ballSideLeft('left')}`);
  check('吸附后的位置被写进 localStorage（下次打开能恢复）',
    ex.readBallPos() !== null && ex.readBallPos().side === 'left',
    JSON.stringify(ex.readBallPos()));

  // 反向：拖回右侧
  ball.dispatch('pointerdown', { clientX: 300, clientY: 400, preventDefault() {} });
  ball.dispatch('pointermove', { clientX: 1100, clientY: 400, preventDefault() {} });
  ball.dispatch('pointerup', { clientX: 1100, clientY: 400, preventDefault() {} });
  check('拖回右侧后吸附到**右**边缘',
    Math.abs(parseFloat(ball.style.left) - ex.ballSideLeft('right')) < 0.5,
    `left=${ball.style.left}`);
  unmount();
}

console.log('\n[F] ★★ 事故回归（2026-10-11）：可选 UI 失败**绝不能**让宿主 web 启动失败');
{
  // ## 事故经过（真实，非假设）
  //
  //   用户在应用内点按钮触发前端 bundle 重载，恰好读到我**编辑过程中的中间态**
  //   （`apply()` 已引用 BALL_PARAM，但 BALL_PARAM 的定义还没写进去）⇒
  //   宿主判定该 entry 未 activate ⇒ 整个应用弹「应用无法启动或已意外停止」。
  //
  //   profile 的 node_modules 是 **symlink 指向开发树** ⇒ 编辑开发树 = 立即影响
  //   运行中的宿主（含中间态）。这不是能靠"小心一点"避免的，**必须靠代码防御**。
  //
  // ## 断言策略：**注入故障**，看 apply 是否仍不抛
  //
  //   做法：破坏 apply 会用到的东西，断言 apply 依然不抛异常。
  //   这才是真断言（断言"副作用/返回值"），不是"源码含某字符串"。

  // ① 让 mountBall 失败（模拟球组件内部炸）⇒ apply 必须不抛
  {
    const { captured, dom } = runInSandbox('');
    const ex = captured.factory(makeRequire([]));
    // 注入故障：document.body.appendChild 抛错
    const origAppend = dom.doc.body.appendChild;
    dom.doc.body.appendChild = function () { throw new Error('注入故障：appendChild 失败'); };
    let threw = null;
    try { ex.apply({ slots: makeSlotsStub().slots }); } catch (e) { threw = e; }
    dom.doc.body.appendChild = origAppend;
    check('球挂载失败时 apply **不抛异常**（否则宿主判定 entry 未激活、应用打不开）',
      threw === null, threw ? threw.name + ': ' + threw.message : '');
  }

  // ② 让 slots.inject 失败（模拟官方 slot 契约变化）⇒ apply 必须不抛
  {
    const { captured } = runInSandbox('');
    const ex = captured.factory(makeRequire([]));
    let threw = null;
    try {
      ex.apply({ slots: { inject() { throw new Error('注入故障：inject 失败'); }, register() { return () => {}; } } });
    } catch (e) { threw = e; }
    check('角标注册失败时 apply **不抛异常**', threw === null, threw ? threw.name + ': ' + threw.message : '');
  }

  // ③ 让整个 ctx.slots 是残缺对象 ⇒ apply 必须不抛
  {
    const { captured } = runInSandbox('');
    const ex = captured.factory(makeRequire([]));
    let threw = null;
    try { ex.apply({ slots: {} }); } catch (e) { threw = e; }
    check('ctx.slots 残缺时 apply **不抛异常**', threw === null, threw ? threw.name + ': ' + threw.message : '');
  }

  // ④ ctx 整体为 undefined ⇒ apply 必须不抛（最极端的宿主契约变化）
  {
    const { captured } = runInSandbox('');
    const ex = captured.factory(makeRequire([]));
    let threw = null;
    try { ex.apply(undefined); } catch (e) { threw = e; }
    check('ctx 为 undefined 时 apply **不抛异常**', threw === null, threw ? threw.name + ': ' + threw.message : '');
  }

  // ⑤ 真调用 isBallDisabled（逃生开关的判据本身也要被验，不能只验 apply 里的间接效果）
  {
    const off = runInSandbox('?dsh-ball=0').captured.factory(makeRequire([]));
    const on = runInSandbox('?dsh-ball=1').captured.factory(makeRequire([]));
    const none = runInSandbox('').captured.factory(makeRequire([]));
    check('isBallDisabled() 在 ?dsh-ball=0 时返回 true', off.isBallDisabled() === true);
    check('isBallDisabled() 在 ?dsh-ball=1 时返回 false', on.isBallDisabled() === false);
    check('isBallDisabled() 无参数时返回 false', none.isBallDisabled() === false);
    check('BALL_PARAM 已导出且为字符串', typeof none.BALL_PARAM === 'string' && none.BALL_PARAM.length > 0);
  }
}

console.log('\n[G] ★★ 用户实测回归：点球**绝不能整页跳转**，必须给出可见的页面内小窗');
{
  // ## 用户原话（2026-10-11，逐字）
  //   「点了这个小窗口的按钮之后，什么都没有发生啊。就是主界面刷新了一下，
  //     转了半天，就回到无事发生的状态了，也没有别的小窗口弹出」
  //
  //   逐字对上旧代码：`isPipAvailable()` 为真（API 存在）但 `requestWindow` 被拒
  //   ⇒ catch ⇒ `toggleMiniMode()` ⇒ `location.assign('?dsh-mini=1')` ⇒ **整页重载**。
  //
  //   三环境对照实测（同机同 Electron 44）：
  //     · about:blank  API 不存在
  //     · 纯净 http 页  API 存在，真实点击 **开窗成功**
  //     · **DSH 宿主页** API 存在，真实点击 **被拒**（featurePolicy 不允许 PiP）
  //   ⇒ 在 DSH 里该 API **实际不可用**，降级分支＝**用户唯一会走到的路径**。

  // ① ★ 判据修正（2026-10-11 第二次）：**featurePolicy 不是可用性判据**
  //
  //   我曾经加过 `allowsFeature('document-picture-in-picture') === false ⇒ 不可用`，
  //   那是**错判据**，实测两份证据：
  //     · 纯净 http 页：allowsFeature = false，但 requestWindow **RESOLVED（真开窗）**
  //     · DSH 宿主页：allowsFeature = false，requestWindow REJECTED
  //   **两者都是 false** ⇒ 该 API 无法区分能用/不能用，拿它做判据会把
  //   **本来能用**的环境也禁掉。现改为只看 API 存在性。
  {
    const { captured, sandbox } = runInSandbox('');
    sandbox.documentPictureInPicture = { requestWindow: function () { return Promise.resolve({}); } };
    // 故意给一个"说不允许"的 featurePolicy —— 旧实现会返回 false，新实现必须仍返回 true
    sandbox.document.featurePolicy = { allowsFeature: () => false };
    const ex = captured.factory(makeRequire([]));
    check('★ featurePolicy 说"不允许"时 isPipAvailable() 仍返回 true（该 API 不能做判据）',
      ex.isPipAvailable() === true, '实际 ' + String(ex.isPipAvailable()));
  }
  // ①b API 不存在 ⇒ false（防"恒 true"）
  {
    const { captured, sandbox } = runInSandbox('');
    // 沙箱里本就没有 documentPictureInPicture；显式确保它是 undefined
    delete sandbox.documentPictureInPicture;
    const ex = captured.factory(makeRequire([]));
    check('无 documentPictureInPicture 时 isPipAvailable() 返回 false',
      ex.isPipAvailable() === false, '实际 ' + String(ex.isPipAvailable()));
  }
  // ①c API 在但没有 requestWindow ⇒ false
  {
    const { captured, sandbox } = runInSandbox('');
    sandbox.documentPictureInPicture = {};
    const ex = captured.factory(makeRequire([]));
    check('API 存在但无 requestWindow 时返回 false',
      ex.isPipAvailable() === false, '实际 ' + String(ex.isPipAvailable()));
  }

  // ②③④ 降级路径：真调用 toggleInPageWindow
  {
    const { captured, dom, sandbox } = runInSandbox('');
    // ★ 装「一旦被调用就记录」的导航函数，用于断言降级**不会**整页跳转
    const navCalls = [];
    sandbox.location.assign = (u) => { navCalls.push('assign:' + u); };
    sandbox.location.replace = (u) => { navCalls.push('replace:' + u); };
    sandbox.location.reload = () => { navCalls.push('reload'); };
    const ex = captured.factory(makeRequire([]));

    const box1 = ex.toggleInPageWindow();
    check('toggleInPageWindow() 真返回了一个 DOM 节点', !!box1);
    check('页面里确实插入了浮层（按 id 可查到）',
      dom.doc.getElementById('dsh-mini-window-float') !== null);
    check('浮层里有 iframe（内容靠 iframe 载入，不搬 React DOM）',
      !!(box1 && typeof box1.querySelector === 'function' && box1.querySelector('iframe')));
    check('★ 降级**没有**调用 location.assign/replace/reload（不再整页跳转）',
      navCalls.length === 0, JSON.stringify(navCalls));
    check('浮层带 role=dialog 与 aria-label（可访问性）',
      !!box1 && box1.getAttribute('role') === 'dialog' && !!box1.getAttribute('aria-label'));

    const box2 = ex.toggleInPageWindow();
    check('再点一次返回 null（toggle 语义）', box2 === null);
    check('再点一次后浮层已移除', dom.doc.getElementById('dsh-mini-window-float') === null);
  }

  // ④ 防回退：整条激活路径都不得整页跳转
  {
    const { captured, sandbox } = runInSandbox('');
    const navCalls = [];
    sandbox.location.assign = (u) => { navCalls.push('assign:' + u); };
    sandbox.location.replace = (u) => { navCalls.push('replace:' + u); };
    sandbox.location.reload = () => { navCalls.push('reload'); };
    sandbox.documentPictureInPicture = {
      requestWindow: function () { return Promise.reject(new Error('NotAllowedError')); },
    };
    const ex = captured.factory(makeRequire([]));
    let err = null;
    try { ex.openPipWindow().catch(() => {}); } catch (e) { err = e; }
    check('openPipWindow 被拒时不抛异常（内部已 catch、返回 null）', err === null, err ? err.message : '');
    check('★ 全路径下 location.assign/replace/reload 均未被调用',
      navCalls.length === 0, JSON.stringify(navCalls));
  }
}

console.log('\n[H] ★★★ 核心需求回归：小窗必须**能脱离宿主应用**（window.open 真窗口）');
{
  // ## 用户原话（2026-10-11，逐字）
  //   「小窗调出后…**无法被拖离至原来的 Electron 应用之外**」
  //   「**我在做小窗插件，要是小窗脱离不了原本的软件，那我做的是什么？**」
  //
  //   ⇒ **"能脱离宿主应用"是小窗的定义性需求**。
  //     · DOM 浮层      —— **物理上不可能**（它就是页面里的 div）
  //     · Document PiP  —— 本机 DSH 被拒（且它也无法拖出应用外）
  //     · **window.open** —— **实测可行**
  //
  //   实测证据（真宿主页面 + CDP 真实点击）：
  //     window.open 返回窗口对象、closed=false；Electron 主进程侧窗口数 0→2、新增 [2,1]
  //   ⇒ 由 Electron 壳开成**真 BrowserWindow**：可拖出、可缩放、有系统关闭按钮、零下载。

  // ① 真窗口开得出来（真调用，断言返回非 null）
  {
    const { captured, sandbox } = runInSandbox('');
    const opened = [];
    sandbox.open = (url, name, feats) => {
      opened.push({ url: String(url || ''), name: String(name || ''), feats: String(feats || '') });
      // 返回一个「窗口对象」桩
      return { closed: false, close() { this.closed = true; }, addEventListener() {} };
    };
    const ex = captured.factory(makeRequire([]));
    const w = ex.openRealWindow();
    check('openRealWindow() 真返回了一个窗口对象', !!w && typeof w === 'object');
    check('window.open 被调用且带尺寸参数（width=440/height=680）',
      opened.length === 1 && /width=440/.test(opened[0].feats) && /height=680/.test(opened[0].feats),
      JSON.stringify(opened[0] || null));
    check('★ 带 resizable=yes（用户要求"能调整大小"）',
      opened.length === 1 && /resizable=yes/.test(opened[0].feats),
      JSON.stringify(opened[0] && opened[0].feats));
    check('窗口名每次不同（否则第二次点击只会聚焦旧窗、不开新窗）',
      opened.length === 1 && opened[0].name.indexOf('dsh_mini_') === 0 && opened[0].name.length > 'dsh_mini_'.length);
  }

  // ② toggle：再点一次必须**关闭**已有窗口，且不得继续降级
  {
    const { captured, sandbox, dom } = runInSandbox('');
    const opened = [];
    sandbox.open = () => { const o = { closed: false, close() { this.closed = true; }, addEventListener() {} }; opened.push(o); return o; };
    const ex = captured.factory(makeRequire([]));
    const w1 = ex.openRealWindow();
    check('第一次调用开窗', !!w1);
    const w2 = ex.openRealWindow();
    check('★ 第二次调用返回 null（toggle 关闭）', w2 === null);
    check('★ 第二次调用真的把窗口 close() 了', w1.closed === true);
    check('第二次调用**没有**再开一个新窗口（opened 仍为 1）', opened.length === 1, 'opened=' + opened.length);
  }

  // ③ 被拦截（返回 null）⇒ 不得抛异常
  {
    const { captured, sandbox } = runInSandbox('');
    sandbox.open = () => null;   // 模拟弹窗拦截
    const ex = captured.factory(makeRequire([]));
    let threw = null;
    try { ex.openRealWindow(); } catch (e) { threw = e; }
    check('window.open 被拦截时 openRealWindow() 不抛异常', threw === null, threw ? threw.message : '');
    check('被拦截时返回 null', ex.openRealWindow() === null);
  }

  // ④ window.open 本身抛错 ⇒ 不得抛出去
  {
    const { captured, sandbox } = runInSandbox('');
    sandbox.open = () => { throw new Error('模拟 open 抛错'); };
    const ex = captured.factory(makeRequire([]));
    let threw = null;
    try { ex.openRealWindow(); } catch (e) { threw = e; }
    check('window.open 抛错时 openRealWindow() 仍不抛异常', threw === null, threw ? threw.message : '');
  }

  // ⑤ 优先级：真窗口可用时**不得**走浮层（这是本次重排的核心）
  {
    const { captured, sandbox, dom } = runInSandbox('');
    sandbox.open = () => ({ closed: false, close() {}, addEventListener() {} });
    const ex = captured.factory(makeRequire([]));
    ex.openRealWindow();   // 开真窗口
    // 此时不应有浮层（浮层只在真窗口开不出来时才用）
    check('★ 真窗口可用时**不创建**页面内浮层',
      dom.doc.getElementById('dsh-mini-window-float') === null);
  }
}

console.log('\n[I] ★★ 批次22：companion 同款界面 + host 真窗口桥');
{
  // ## 用户原话（2026-10-11，逐字）
  //   「把现在这个现成的，就是之前那个 electron 包里面的**实现方法**和那些
  //     **展示的界面**，直接搬到现在这个小窗子上面」
  //   「我说的是之前 electron 小窗的那个界面啊」
  //   并确认：要「复刻 companion 小窗的全部」+「置顶做成可切换的」
  //
  // ## 搬的内容（照抄 companion/renderer/panel.html，非自创）
  //   · 55px 顶栏（--topbar-h: 55px）
  //   · T1 最小化 / T2 置顶(可切换) / T3 侧栏 / T7 紧凑浮窗 / T8 更多
  //   · 「更多」菜单 4 项：界面缩放 / 重新加载 / 回到主界面 / 关闭小窗
  //   · 实现方法：host 侧 Electron BrowserWindow（零下载，用宿主自带的）

  // ① 路由前缀一致性（前端 ↔ host 各写一份 ⇒ 必须断言它们相等，防"半修"）
  {
    const { captured } = runInSandbox('');
    const ex = captured.factory(makeRequire([]));
    check('HOST_ROUTE_PREFIX 已导出且以 / 开头',
      typeof ex.HOST_ROUTE_PREFIX === 'string' && ex.HOST_ROUTE_PREFIX.startsWith('/'),
      String(ex.HOST_ROUTE_PREFIX));
    // ★ 与 host 侧真值比对（读文件，不是"源码含字符串"——比的是两边是否**相同**）
    const hostSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'host-routes.js'), 'utf8');
    const m = /export const ROUTE_PREFIX = '([^']+)'/.exec(hostSrc);
    check('★ 前端 HOST_ROUTE_PREFIX === host 侧 ROUTE_PREFIX（改一处不改另一处会失联）',
      !!m && m[1] === ex.HOST_ROUTE_PREFIX, `host=${m && m[1]} client=${ex.HOST_ROUTE_PREFIX}`);
  }

  // ② callHostWindow：真调用（打桩 fetch），断言 URL / method / 返回解析
  {
    const { captured, sandbox } = runInSandbox('');
    const calls = [];
    sandbox.location = { origin: 'http://127.0.0.1:19387', href: 'http://127.0.0.1:19387/' };
    sandbox.fetch = async (url, init) => {
      calls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body });
      return { ok: true, json: async () => ({ ok: true, open: true, pinned: false }) };
    };
    const ex = captured.factory(makeRequire([]));
    pending.push((async () => {
      const r = await ex.callHostWindow('toggle');
      check('callHostWindow 真返回解析后的对象',
        !!r && r.open === true && r.pinned === false, JSON.stringify(r));
      check('callHostWindow 打到正确的 URL（origin + 前缀 + action）',
        calls.length === 1 && calls[0].url === 'http://127.0.0.1:19387/dsh-mini-window/toggle',
        JSON.stringify(calls[0] || null));
      check('callHostWindow 对 toggle 用 POST', calls.length === 1 && calls[0].method === 'POST', JSON.stringify(calls[0] || null));
      // 负路径：state 必须用 GET
      calls.length = 0;
      await ex.callHostWindow('state');
      check('callHostWindow 对 state 用 GET（读状态不该有副作用）',
        calls.length === 1 && calls[0].method === 'GET', JSON.stringify(calls[0] || null));
    })());
  }

  // ③ callHostWindow 的负路径：网络失败 / 非 2xx / fetch 不存在 ⇒ 都必须返回 null 且不抛
  {
    const { captured, sandbox } = runInSandbox('');
    sandbox.fetch = async () => { throw new Error('网络炸了'); };
    const ex = captured.factory(makeRequire([]));
    pending.push((async () => {
      let threw = null, r = 'unset';
      try { r = await ex.callHostWindow('open'); } catch (e) { threw = e; }
      check('fetch 抛错时 callHostWindow 不抛且返回 null', threw === null && r === null, `threw=${threw} r=${JSON.stringify(r)}`);
    })());
  }
  {
    const { captured, sandbox } = runInSandbox('');
    sandbox.fetch = async () => ({ ok: false, json: async () => ({}) });
    const ex = captured.factory(makeRequire([]));
    pending.push((async () => {
      const r = await ex.callHostWindow('open');
      check('非 2xx 时 callHostWindow 返回 null（视为 host 不可用）', r === null, JSON.stringify(r));
    })());
  }
  {
    const { captured, sandbox } = runInSandbox('');
    delete sandbox.fetch;
    const ex = captured.factory(makeRequire([]));
    pending.push((async () => {
      let threw = null;
      try { await ex.callHostWindow('open'); } catch (e) { threw = e; }
      check('无 fetch 时 callHostWindow 不抛（老环境降级）', threw === null, threw ? threw.message : '');
    })());
  }

  // ④ mountMiniTopbar：真调用，断言节点结构与 5 个按钮都存在
  {
    const { captured, sandbox, dom } = runInSandbox('?dsh-mini=1');
    sandbox.fetch = async () => ({ ok: true, json: async () => ({ ok: true, open: false, pinned: true }) });
    const ex = captured.factory(makeRequire([]));
    const ok = ex.mountMiniTopbar();
    check('mountMiniTopbar() 真返回 true', ok === true, String(ok));
    const bar = dom.doc.getElementById(ex.TOPBAR_ID);
    check('顶栏节点已在 DOM 里', !!bar, String(!!bar));
    check('顶栏 role = toolbar', !!bar && bar.getAttribute('role') === 'toolbar', bar && bar.getAttribute('role'));
    // 五个按钮（T1 最小化 / T2 置顶 / T3 侧栏 / T7 紧凑 / T8 更多）
    const ids = ['-min', '-pin', '-side', '-compact', '-more'].map((s) => ex.TOPBAR_ID + s);
    const missing = ids.filter((i) => !dom.doc.getElementById(i));
    check('★ companion 同款的 5 个按钮全部存在（min/pin/side/compact/more）',
      missing.length === 0, '缺少：' + JSON.stringify(missing));
    // 幂等性：再挂一次不该产生第二个顶栏
    const before = dom.created.length;
    ex.mountMiniTopbar();
    const bars = dom.created.filter((n) => n.id === ex.TOPBAR_ID).length;
    check('mountMiniTopbar 幂等（重复调用不重复挂载顶栏）', bars === 1, `顶栏节点数=${bars}（created 由 ${before} → ${dom.created.length}）`);
  }

  // ⑤ 顶栏按钮的**真实副作用**（不是"有按钮"就算完）
  {
    // T2 置顶：点一下必须打 host 路由 /pin，且把 host 返回的 pinned 反映到 class
    const { captured, sandbox, dom } = runInSandbox('?dsh-mini=1');
    const hits = [];
    sandbox.location = { origin: 'http://127.0.0.1:19387', href: 'http://127.0.0.1:19387/' };
    sandbox.fetch = async (url, init) => {
      hits.push(String(url).replace('http://127.0.0.1:19387', ''));
      const action = String(url).split('/').pop();
      if (action === 'pin') return { ok: true, json: async () => ({ ok: true, open: true, pinned: false }) };
      return { ok: true, json: async () => ({ ok: true, open: true, pinned: true }) };
    };
    const ex = captured.factory(makeRequire([]));
    ex.mountMiniTopbar();
    const pinBtn = dom.doc.getElementById(ex.TOPBAR_ID + '-pin');
    pending.push((async () => {
      pinBtn.dispatch({ type: 'click', preventDefault() {}, stopPropagation() {} });
      await new Promise((r) => setTimeout(r, 30));
      check('★ 点 T2 置顶按钮真的打了 host /pin 路由',
        hits.includes('/dsh-mini-window/pin'), JSON.stringify(hits));
      check('★ host 返回 pinned=false 后按钮 class 同步去掉 active',
        !pinBtn.classList.contains('active'), JSON.stringify(pinBtn.classList._set || null));
    })());
  }
  {
    // T1/T7 也必须真的打路由（防"按钮存在但没接线"这类半修）
    const { captured, sandbox, dom } = runInSandbox('?dsh-mini=1');
    const hits = [];
    sandbox.location = { origin: 'http://127.0.0.1:19387', href: 'http://127.0.0.1:19387/' };
    sandbox.fetch = async (url) => {
      hits.push(String(url).split('/').pop());
      return { ok: true, json: async () => ({ ok: true, open: true, pinned: true }) };
    };
    const ex = captured.factory(makeRequire([]));
    ex.mountMiniTopbar();
    pending.push((async () => {
      dom.doc.getElementById(ex.TOPBAR_ID + '-min')
        .dispatch({ type: 'click', preventDefault() {}, stopPropagation() {} });
      dom.doc.getElementById(ex.TOPBAR_ID + '-compact')
        .dispatch({ type: 'click', preventDefault() {}, stopPropagation() {} });
      await new Promise((r) => setTimeout(r, 30));
      check('★ 点 T1 最小化真的打了 host /minimize', hits.includes('minimize'), JSON.stringify(hits));
      check('★ 点 T7 紧凑浮窗真的打了 host /compact', hits.includes('compact'), JSON.stringify(hits));
    })());
  }

  // ⑥ T3 侧栏：优先用 ctx.layout.toggleSidebar；没有则退回点官方 DOM 开关
  {
    const { captured, sandbox, dom } = runInSandbox('?dsh-mini=1');
    let toggled = 0;
    const ex = captured.factory(makeRequire([]));
    // 装一个官方开关元素（模拟 DSH 的 sidebar-toggle）
    const el = dom.doc.createElement('button');
    el.setAttribute('data-dsh-responsive-part', 'sidebar-toggle');
    el.tagName = 'BUTTON';
    el.click = () => { toggled++; };
    dom.body.appendChild(el);
    const ok = ex.openSidebarViaCtx();
    check('★ openSidebarViaCtx() 在没有 ctx.layout 时**真点了官方 DOM 开关**',
      ok === true && toggled === 1, `ok=${ok} toggled=${toggled}`);
  }
  {
    // 负路径：连官方开关都没有 ⇒ 返回 false，不抛
    const { captured, dom } = runInSandbox('?dsh-mini=1');
    const ex = captured.factory(makeRequire([]));
    let threw = null, r = 'unset';
    try { r = ex.openSidebarViaCtx(); } catch (e) { threw = e; }
    check('无官方开关时 openSidebarViaCtx 返回 false 且不抛',
      threw === null && r === false, `threw=${threw} r=${JSON.stringify(r)}`);
  }

  // ⑦ 「更多」菜单：真调用，断言 4 项菜单内容
  {
    const { captured, sandbox, dom } = runInSandbox('?dsh-mini=1');
    sandbox.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
    const ex = captured.factory(makeRequire([]));
    const opened = ex.toggleMiniMenu();
    check('toggleMiniMenu() 首次调用返回 true（展开）', opened === true, String(opened));
    const menu = dom.doc.getElementById(ex.MENU_ID);
    check('菜单节点已在 DOM 里', !!menu);
    const ids = ['-zoom-out', '-zoom-in', '-reload', '-main', '-close'].map((s) => ex.MENU_ID + s);
    const missing = ids.filter((i) => !dom.doc.getElementById(i));
    check('★ 菜单含 companion 同款的缩放/重载/回主界面/关闭 5 个控件',
      missing.length === 0, '缺少：' + JSON.stringify(missing));
    const again = ex.toggleMiniMenu();
    check('再点一次收起菜单（返回 false 且节点移除）',
      again === false && dom.doc.getElementById(ex.MENU_ID) === null, `again=${again}`);
  }

  // ⑧ 缩放真有副作用（companion 的 zoom 是 webview zoomFactor；前端只能改 zoom）
  {
    const { captured, sandbox, dom } = runInSandbox('?dsh-mini=1');
    sandbox.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
    const ex = captured.factory(makeRequire([]));
    ex.toggleMiniMenu();
    const zIn = dom.doc.getElementById(ex.MENU_ID + '-zoom-in');
    const zOut = dom.doc.getElementById(ex.MENU_ID + '-zoom-out');
    zIn.dispatch({ type: 'click', stopPropagation() {} });
    const after1 = sandbox.__dshMiniZoom;
    check('★ 点放大真的改了缩放值（110%）', after1 === 1.1, String(after1));
    zOut.dispatch({ type: 'click', stopPropagation() {} });
    check('点缩小回到 100%', sandbox.__dshMiniZoom === 1, String(sandbox.__dshMiniZoom));
    // clamp 负路径
    for (let i = 0; i < 10; i++) zOut.dispatch({ type: 'click', stopPropagation() {} });
    check('★ 缩放有下限 clamp（不低于 0.6）', sandbox.__dshMiniZoom === 0.6, String(sandbox.__dshMiniZoom));
  }
}

console.log('\n[J] ★★★ 真 DSH 实测回归：球必须走 Companion，绝不能再造假窗口');
{
  // ## 用户原话（2026-10-11，逐字）
  //   「默认调起的是兜底形式，就是在页面里面的那种，并没有新建一个小窗口」
  //   「之后一直卡在加载页面」
  //
  // ## 在**真 DSH 应用**里逐条实测的结论（我前两批都判断错了）
  //   | 路径 | 结果 |
  //   |---|---|
  //   | host 侧 import('electron') | ❌ host 是 Node 子进程（PID 68420） |
  //   | window.open() | ❌ 主进程 7 处 setWindowOpenHandler 全 deny |
  //   | Document PiP | ❌ 权限策略拒绝 |
  //   | dshPlatform.open | ❌ 只接受 usage/top-up |
  //   | 页面内 iframe 浮层 | ⚠️ 拖不出去，且**载入 DSH 会一直转圈** |
  //   ⇒ 只有 Companion（独立 Electron）能开真窗口。

  // ① Companion 优先：点了球必须打 /companion 路由
  {
    const { captured, sandbox } = runInSandbox('');
    const hits = [];
    sandbox.location = { origin: 'http://127.0.0.1:19387', href: 'http://127.0.0.1:19387/' };
    sandbox.fetch = async (url) => {
      hits.push(String(url).split('/').pop());
      return { ok: true, json: async () => ({ ok: true, launched: true }) };
    };
    const ex = captured.factory(makeRequire([]));
    pending.push((async () => {
      const ok = await ex.callCompanion();
      check('callCompanion() 真打了 host /companion 路由', hits.includes('companion'), JSON.stringify(hits));
      check('callCompanion() 在 host 回 ok+launched 时返回 true', ok === true, String(ok));
    })());
  }
  // ①b 负路径：host 说没装 ⇒ 必须返回 false（不能假装成功）
  {
    const { captured, sandbox } = runInSandbox('');
    sandbox.fetch = async () => ({ ok: true, json: async () => ({ ok: false, launched: false, hint: '没找到 Companion' }) });
    const ex = captured.factory(makeRequire([]));
    pending.push((async () => {
      const ok = await ex.callCompanion();
      check('★ host 说没装 Companion 时 callCompanion() 返回 false（不假装成功）', ok === false, String(ok));
    })());
  }
  // ①c 负路径：网络失败也必须 false 且不抛
  {
    const { captured, sandbox } = runInSandbox('');
    sandbox.fetch = async () => { throw new Error('炸了'); };
    const ex = captured.factory(makeRequire([]));
    pending.push((async () => {
      let threw = null, r = 'unset';
      try { r = await ex.callCompanion(); } catch (e) { threw = e; }
      check('fetch 抛错时 callCompanion() 不抛且返回 false', threw === null && r === false, `threw=${threw} r=${JSON.stringify(r)}`);
    })());
  }

  // ② 说明框：**绝不能含 iframe**（那正是"一直转圈"的根因）
  {
    const { captured, sandbox, dom } = runInSandbox('');
    const ex = captured.factory(makeRequire([]));
    const shown = ex.showWindowUnavailableNotice();
    check('showWindowUnavailableNotice() 真返回 true', shown === true, String(shown));
    const box = dom.doc.getElementById(ex.NOTICE_ID);
    check('说明框已在 DOM 里', !!box);
    check('说明框 role = dialog', !!box && box.getAttribute('role') === 'dialog', box && box.getAttribute('role'));
    // ★★ 核心断言：不能再有 iframe（用户实测"一直卡在加载"就是它）
    check('★★ 说明框里**没有 iframe**（不再造转圈的假窗口）',
      !!box && box.querySelectorAll('iframe').length === 0,
      'iframe 数=' + (box ? box.querySelectorAll('iframe').length : 'n/a'));
    // 文案要如实说明（含 Companion 字样）
    // ⚠️ 桩的 innerHTML 是**普通字符串属性、不解析成子节点**，而标题文字在
    //   `title.textContent` 里 ⇒ 必须**递归收集整棵子树的文本**才能查到。
    //   （只查 box.innerHTML 会漏 ⇒ 断言无辜变红，本项目第 4 次栽在桩语义上。）
    const collectText = (n) => {
      let s = String(n.textContent || '') + String(n.innerHTML || '');
      for (const c of n.childNodes || []) s += ' ' + collectText(c);
      return s;
    };
    const txt = box ? collectText(box) : '';
    check('★ 说明框如实提到 Companion（唯一能开独立小窗的路径）', /Companion/i.test(txt),
      '实际文本=' + txt.slice(0, 120));
    // 幂等：再点收起
    const again = ex.showWindowUnavailableNotice();
    check('再点一次收起说明框（toggle 语义）',
      again === false && dom.doc.getElementById(ex.NOTICE_ID) === null, `again=${again}`);
  }

  // ③ ★★ 核心回归：Companion 不可用时，**不得**再走 window.open / iframe 浮层
  {
    const { captured, sandbox, dom } = runInSandbox('');
    let openCalled = 0;
    sandbox.location = { origin: 'http://127.0.0.1:19387', href: 'http://127.0.0.1:19387/' };
    sandbox.open = () => { openCalled++; return { closed: false, close() {}, addEventListener() {} }; };
    sandbox.fetch = async () => ({ ok: false, json: async () => ({ ok: false, launched: false }) });
    const ex = captured.factory(makeRequire([]));
    pending.push((async () => {
      await ex.onBallActivateForTest();
      await new Promise((r) => setTimeout(r, 40));
      check('★★ Companion 不可用时**没有**调用 window.open（前两批的错误路径）',
        openCalled === 0, 'window.open 被调了 ' + openCalled + ' 次');
      check('★★ Companion 不可用时**没有**创建 iframe 浮层（那是"一直转圈"的根因）',
        dom.doc.getElementById('dsh-mini-window-float') === null);
      check('★ Companion 不可用时给出了**如实说明框**（而不是假窗口）',
        dom.doc.getElementById(ex.NOTICE_ID) !== null);
    })());
  }
}

console.log('\n[E3] PiP 打开失败必须**优雅降级**（不抛错、返回 null）');
{
  const { captured, sandbox } = runInSandbox('?dsh-mini=1');
  const ex = captured.factory(makeRequire([]));

  // ⚠️ 本文件是 .cjs（CommonJS）⇒ **不能用顶层 await**。
  //   改为把 Promise 收进数组，在文件末尾统一 await 后再判定。
  const rejects = () => Promise.reject(new Error('not allowed'));
  sandbox.documentPictureInPicture = { requestWindow: rejects };
  pending.push((async () => {
    let threw = false, r = 'unset';
    try { r = await ex.openPipWindow(); } catch { threw = true; }
    check('requestWindow reject 时 openPipWindow 不抛错且返回 null',
      threw === false && r === null, `threw=${threw} r=${JSON.stringify(r)}`);
  })());

  // 完全没有该 API
  delete sandbox.documentPictureInPicture;
  pending.push((async () => {
    let threw = false, r2 = 'unset';
    try { r2 = await ex.openPipWindow(); } catch { threw = true; }
    check('无 PiP API 时 openPipWindow 返回 null（降级到页面内模式）',
      threw === false && r2 === null, `threw=${threw} r=${JSON.stringify(r2)}`);
  })());
}

// ---- 收尾：先跑完所有异步断言，再统计（.cjs 无顶层 await 的替代写法）----
(async () => {
  try {
    await Promise.all(pending);
  } catch (e) {
    failures++;
    console.log(`  FAIL  异步断言组抛错  ← ${e && e.message}`);
  }

  console.log(`\n=== 结果：${failures === 0 ? '全绿 PASS' : failures + ' 项失败 FAIL'} ===`);
  process.exit(failures === 0 ? 0 : 1);
})();
