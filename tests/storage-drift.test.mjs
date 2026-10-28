import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as domain from '../src/domain.js';
import * as catalogs from '../src/catalog.js';

const key = 'dentotar.workspace.v1';
const seed = title => JSON.stringify({ ...domain.createState(), plan: { title, lines: [] } });

// Run hydrate, persist and the real title-input handler. Only platform boundaries
// are synthetic; native two-page storage and downloads are checked in browser.mjs.
async function app(initial = null) {
  let raw = initial, readError = false, writeError = false;
  const writes = [], elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: '', textContent: '', hidden: true,
      dataset: {}, classList: { toggle() {} }, setAttribute() {},
      addEventListener(type, fn) { this[type] = fn; } });
    return elements.get(selector);
  };
  const context = vm.createContext({ ...domain, ...catalogs, structuredClone, performance,
    document: { querySelector: element, querySelectorAll: () => [], body: { dataset: {} }, addEventListener() {} },
    window: { addEventListener() {} }, localStorage: {
      getItem(k) { assert.equal(k, key); if (readError) throw new Error('synthetic read failure'); return raw; },
      setItem(k, value) { assert.equal(k, key); if (writeError) throw new Error('synthetic quota'); writes.push(value); raw = value; }
    }, setTimeout: () => 1, clearTimeout() {} });
  const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.replace(/^import[\s\S]*?from '\.\/catalog\.js';\n/, '')
    .replace(/boot\(\)\.catch\(error => showCatalogStart\(error\.message\)\);\s*$/, '')
    + '\nhydrate(); bindEvents();', context);
  return {
    edit(title) { element('#plan-title').input({ target: { value: title } }); },
    raw: () => raw, external(value) { raw = value; }, writes,
    exported: () => JSON.parse(vm.runInContext('JSON.stringify(exportPlan(state, "synthetic"))', context)),
    status: () => element('#save-status').textContent,
    warning: () => !element('#storage-warning').hidden,
    failRead() { readError = true; }, failWrite() { writeError = true; }
  };
}

for (const [name, initial, external] of [
  ['replacement', seed('Original'), seed('Other tab')],
  ['removal', seed('Original'), null],
  ['first external creation', null, seed('Other tab')]
]) test(`pre-event storage ${name} cannot be overwritten by a local edit`, async () => {
  const a = await app(initial);
  a.external(external);
  a.edit('Local unsaved work');
  assert.equal(a.raw(), external, 'external raw bytes must survive an edit before storage-event delivery');
  assert.equal(a.writes.length, 0, 'drift must refuse the actual write');
  assert.equal(a.warning(), true);
  assert.match(a.status(), /pausiert|Nicht gespeichert/);
  assert.equal(a.exported().plan.title, 'Local unsaved work', 'the refused write must remain exportable');
  a.edit('Later transient work');
  assert.equal(a.raw(), external); assert.equal(a.writes.length, 0);
  assert.equal(a.exported().plan.title, 'Later transient work');
  const reloaded = await app(external);
  assert.equal(reloaded.exported().plan.title, external === null ? 'Neue Zusammenstellung' : 'Other tab');
  reloaded.edit('Deliberate edit after reload');
  assert.equal(JSON.parse(reloaded.raw()).plan.title, 'Deliberate edit after reload');
});

test('absent and populated storage permit repeated owned writes', async () => {
  for (const initial of [null, seed('Original')]) {
    const a = await app(initial);
    for (const title of ['First own edit', 'Second own edit']) {
      a.edit(title); assert.equal(JSON.parse(a.raw()).plan.title, title);
      assert.equal(a.warning(), false); assert.match(a.status(), /Automatisch/);
    }
    assert.equal(a.writes.length, 2);
  }
});

test('invalid input does not advance the storage baseline', async () => {
  const initial = seed('Original'), a = await app(initial);
  a.edit('x'.repeat(161)); assert.equal(a.raw(), initial); assert.equal(a.writes.length, 0);
  a.edit('Corrected'); assert.equal(JSON.parse(a.raw()).plan.title, 'Corrected');
});

test('corrupt initial storage remains protected', async () => {
  const a = await app('{broken raw');
  a.edit('Transient recovery work'); assert.equal(a.raw(), '{broken raw');
  assert.equal(a.writes.length, 0); assert.equal(a.warning(), true);
  assert.equal(a.exported().plan.title, 'Transient recovery work');
});

test('a storage read failure before writing cannot overwrite the previous state', async () => {
  const initial = seed('Original'), a = await app(initial);
  a.failRead(); a.edit('Transient after read failure');
  assert.equal(a.raw(), initial); assert.equal(a.writes.length, 0); assert.equal(a.warning(), true);
  assert.equal(a.exported().plan.title, 'Transient after read failure');
});

test('a failed write preserves previous raw bytes and exportable local work', async () => {
  const initial = seed('Original'), a = await app(initial);
  a.failWrite(); a.edit('Transient after quota failure');
  assert.equal(a.raw(), initial); assert.equal(a.writes.length, 0); assert.equal(a.warning(), true);
  assert.equal(a.exported().plan.title, 'Transient after quota failure');
});
