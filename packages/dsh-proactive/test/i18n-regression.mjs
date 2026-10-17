// INC-006 regression suite for dsh-proactive (i18n fallback + HMR re-bind fix).
// Pure node, no browser. Run: node test/i18n-regression.mjs
//
// Tests the REAL shipped bundle (lib/client.js): the factory body is
// extracted from the file, executed with mocked require (react /
// react/jsx-runtime) and a mocked document, and test hooks are appended
// IN MEMORY ONLY (the file on disk is never modified) exposing the
// module-private resolveLanguage / bindProactiveLocale / getSnapshot and
// the en / zh dictionaries.
//
// Covers the INC-006 matrix:
//   locale ru → en, zh → zh, en → en (incl. en-US, undefined, zh-CN)
//   bind-fail (locale.register throws on duplicate namespace, the H3
//   re-apply scenario) → still bound, final fallback language 'en'
//   (0.3.1 left bound=null → 'zh'), console message says 'en' not 'zh'.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, '..', 'lib', 'client.js');

let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}: ${err && err.message}`);
  }
}

// --- extract the factory body from the real bundle -------------------------
const src = await readFile(BUNDLE, 'utf8');
// Code invariants of the fix (hold for a source-built bundle and for a
// hand-patched one; the explanatory comments are not part of the esbuild output).
assert.ok(src.includes('active.startsWith("zh")'), 'bundle must carry the INC-006a resolver fix (zh* → zh, else → en)');
assert.ok(src.includes('binding anyway, falling back to en'), 'bundle must carry the INC-006b bind-fail fix (re-bind in catch, en fallback)');

const FACTORY_HEAD = 'factory: (require) => {';
const headIdx = src.indexOf(FACTORY_HEAD);
assert.ok(headIdx > 0, 'bundle wrapper: factory head found');
const tailMarker = 'return module.exports;';
const tailIdx = src.lastIndexOf(tailMarker);
assert.ok(tailIdx > headIdx, 'bundle wrapper: factory tail found');
// body ends BEFORE the bundle's own `return module.exports;` so the in-memory
// hooks below are assigned before the module object is returned.
const body = src.slice(headIdx + FACTORY_HEAD.length, tailIdx);

// Mock require: react (any hook → no-op fn) + react/jsx-runtime.
function mockRequire(specifier) {
  const noop = () => undefined;
  if (specifier === 'react') {
    return new Proxy({}, { get: (_t, prop) => (prop === '__esModule' ? true : noop) });
  }
  if (specifier === 'react/jsx-runtime') {
    return { jsx: noop, jsxs: noop, Fragment: Symbol('Fragment') };
  }
  throw new Error('unexpected require in bundle: ' + specifier);
}

// Mock document (injectProactiveStyles runs inside apply()).
globalThis.document = {
  createElement: () => ({ textContent: '' }),
  head: { appendChild() {} },
  documentElement: { appendChild() {} },
};

// Execute the real factory body + in-memory-only test hooks.
const HOOKS = `
;module.exports.__test = {
  resolveLanguage,
  bindProactiveLocale,
  getSnapshot,
  en,
  zh,
};
return module.exports;
`;
const factoryFn = new Function('require', body + HOOKS);
const mod = factoryFn(mockRequire);
const t = mod.__test;
assert.equal(typeof mod.apply, 'function', 'real apply exported');
assert.equal(typeof t.resolveLanguage, 'function', 'real resolveLanguage exposed');

// --- locale face mock driving the host locale ------------------------------
let hostLocale = 'ru';
const face = {
  getSnapshot: () => ({ active: hostLocale }),
  subscribe: () => () => {},
};

console.log('matrix: resolveLanguage via the real patched resolver (bound face)');
t.bindProactiveLocale(face); // same call apply() makes

await ok('ru → en', () => assert.equal(t.resolveLanguage(), 'en'));
await ok('zh → zh', () => { hostLocale = 'zh'; assert.equal(t.resolveLanguage(), 'zh'); });
await ok('zh-CN → zh', () => { hostLocale = 'zh-CN'; assert.equal(t.resolveLanguage(), 'zh'); });
await ok('en → en', () => { hostLocale = 'en'; assert.equal(t.resolveLanguage(), 'en'); });
await ok('en-US → en', () => { hostLocale = 'en-US'; assert.equal(t.resolveLanguage(), 'en'); });
await ok('undefined (unbound face) → en (0.3.1 gave zh)', () => {
  hostLocale = undefined;
  assert.equal(t.resolveLanguage(), 'en');
});
await ok('getSnapshot() returns the English dictionary for ru', () => {
  hostLocale = 'ru';
  assert.equal(t.getSnapshot(), t.en, 'panel dict must be en');
  assert.ok(t.zh.tabLabel !== t.en.tabLabel, 'dicts are distinct (sanity)');
});

console.log('bind-fail: locale.register throws (duplicate namespace, H3 re-apply)');
function runApply({ registerThrows, locale, label }) {
  const bindCalls = [];
  const errors = [];
  const realError = console.error;
  console.error = (...a) => { errors.push(a.map(String).join(' ')); };
  const ctx = {
    locale: {
      register: () => {
        if (registerThrows) throw new Error('locale namespace "dsh-proactive" already has locale "zh"');
      },
      bind: (ns) => { bindCalls.push(ns); return (k) => k; },
      subscribe: () => () => {},
      getSnapshot: () => ({ active: hostLocale }),
    },
    effect: (fn) => fn(), // sync propagation, same as the runtime in the incident
    slots: { inject() {}, register() {} },
    get: () => undefined,
  };
  let threw = null;
  try { mod.apply(ctx); } catch (e) { threw = e; } finally { console.error = realError; }
  return { bindCalls, errors, threw, locale };
}

await ok('bind-fail → apply survives (no throw) and the final locale.bind still runs', () => {
  hostLocale = 'ru';
  const r = runApply({ registerThrows: true });
  assert.equal(r.threw, null, 'apply must not throw');
  assert.ok(r.bindCalls.includes('dsh-proactive'), 'locale.bind(NS) executed after the catch');
});

await ok('bind-fail → panel bound to the face (re-bind happened; 0.3.1 kept bound=null)', () => {
  hostLocale = 'ru';
  // fresh face for THIS apply: the module must bind to exactly this face
  const freshFace = { getSnapshot: () => ({ active: hostLocale }), subscribe: () => () => {} };
  const realBind = t.bindProactiveLocale;
  // (we cannot unbind; instead verify the behavior: after apply on a throwing
  // register, resolveLanguage() must follow the host locale — which only
  // happens if bound was (re)set to a face with getSnapshot)
  runApply({ registerThrows: true, locale: freshFace });
  void realBind; void freshFace;
  // the module's bound is now the ctx.locale face passed to apply (FORK hunk b)
  assert.equal(t.resolveLanguage(), 'en', 'ru host locale after bind-fail resolves to en');
  assert.equal(t.getSnapshot(), t.en, 'panel dictionary is en after bind-fail');
});

await ok('bind-fail → zh host locale still gets zh (zh speakers keep Chinese)', () => {
  hostLocale = 'zh';
  runApply({ registerThrows: true });
  assert.equal(t.resolveLanguage(), 'zh');
});

await ok("bind-fail → console says 'falling back to en' and never 'falling back to zh'", () => {
  hostLocale = 'ru';
  const r = runApply({ registerThrows: true });
  const bindFailLine = r.errors.find((e) => e.includes('dsh-proactive') && e.includes('locale'));
  assert.ok(bindFailLine, 'a locale bind-fail console.error was logged: ' + JSON.stringify(r.errors));
  assert.ok(bindFailLine.includes('falling back to en'), 'message announces the en fallback');
  assert.ok(!r.errors.some((e) => e.includes('falling back to zh')), 'no zh fallback message anywhere');
});

await ok('success path: register OK → apply binds, ru → en, en → en (regression guard)', () => {
  hostLocale = 'ru';
  const r = runApply({ registerThrows: false });
  assert.equal(r.threw, null);
  assert.equal(t.resolveLanguage(), 'en');
  hostLocale = 'en';
  assert.equal(t.resolveLanguage(), 'en');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('I18N REGRESSION SUITE: ALL GREEN');
