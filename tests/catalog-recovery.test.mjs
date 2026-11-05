import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import * as domain from '../src/domain.js';
import * as catalogs from '../src/catalog.js';

const KEY = 'dentotar.workspace.v1';
const snapshot = (title = 'Existing snapshot') => ({ id: randomUUID(), savedAt: '2026-01-01T00:00:00.000Z',
  catalogVersion: 'synthetic', mode: 'social', privateLevel: 'min', taxPointValue: '1.10',
  plan: { title, lines: [{ id: 'snapshot-line', code: 'synthetic', quantity: 2, points: null, note: 'Prior note' }] } });
const seed = () => ({ ...domain.createState(), favorites: ['synthetic'], savedPlans: [snapshot()],
  plan: { title: 'Active draft', lines: [{ id: 'active-line', code: 'synthetic', quantity: 1, points: null, note: 'Unsaved work' }] } });

// Execute the complete actual app, including save/restore/reset/import/export
// handlers. Only DOM, confirm, downloads and Storage boundaries are synthetic.
async function app(initial = seed()) {
  let raw = JSON.stringify(initial), fail = '', attempts = 0;
  const writes = [], downloads = [], elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: '', textContent: '', innerHTML: '', hidden: false,
      dataset: {}, classList: { toggle() {} }, setAttribute() {},
      addEventListener(type, fn) { this[type] = fn; }, showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(selector);
  };
  const context = vm.createContext({ ...domain, ...catalogs, structuredClone, performance, Blob, Map, Set,
    crypto: { randomUUID }, confirm: () => true, setTimeout: () => 1, clearTimeout() {},
    URL: { createObjectURL(blob) { downloads.push(blob); return 'blob:synthetic-download'; }, revokeObjectURL() {} },
    document: { querySelector: element, querySelectorAll: () => [], body: { dataset: {}, append() {} },
      addEventListener() {}, createElement: () => ({ click() {}, remove() {} }) },
    window: { addEventListener() {} }, localStorage: {
      getItem(key) { assert.equal(key, KEY); if (fail === 'read') throw new Error('synthetic read failure'); return raw; },
      setItem(key, value) { assert.equal(key, KEY); attempts++; if (fail === 'quota') throw new Error('synthetic quota'); raw = value; writes.push(value); }
    } });
  const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.replace(/^import[\s\S]*?from '\.\/catalog\.js';\r?\n/, '')
    .replace(/boot\(\)\.catch\(error => showCatalogStart\(error\.message\)\);\s*$/, '')
    + '\nhydrate(); bindEvents();', context);
  return {
    run: code => vm.runInContext(code, context), element, state: () => JSON.parse(vm.runInContext('JSON.stringify(state)', context)), raw: () => raw, writes,
    attempts: () => attempts, fail(value) { fail = value; }, external(value) { raw = value; },
    click(selector, dataset = {}) { return element(selector).click({ target: { closest: () => ({ dataset }) } }); },
    edit(title) { element('#plan-title').input({ target: { value: title } }); },
    html: selector => element(selector).innerHTML, toast: () => element('#toast').textContent,
    status: () => element('#save-status').textContent,
    async exported() { element('#json-export').click(); return JSON.parse(await downloads.at(-1).text()); },
    async import(payload) { const input = element('#import-file'); input.files = [{ size: 100, text: async () => JSON.stringify(payload) }]; await input.change({ target: input }); }
  };
}


// Real bundled data are read-only. Only file read failures below are synthetic.
const realCatalog = JSON.parse(await readFile(new URL('../public/data/catalog.json', import.meta.url)));
for (const failure of ['invalid-json', 'invalid-catalog', 'read-denied', 'too-large']) {
  test(`rejected replacement catalog keeps the active workspace usable: ${failure}`, async () => {
    const a = await app();
    a.run('globalThis.__catalog = ' + JSON.stringify(realCatalog) + '; activateCatalog(__catalog);');
    a.run('addPosition(' + JSON.stringify(realCatalog.positions[0].code) + ');');
    const before = a.state(), durable = a.raw();
    const file = {size: failure === 'too-large' ? catalogs.MAX_CATALOG_BYTES + 1 : 10,
      async text() { if (failure === 'read-denied') throw Error('Synthetic unreadable file');
        return failure === 'invalid-json' ? '{' : '{}'; }};
    const input = a.element('#catalog-file'); input.files = [file];
    await input.change({target: input});
    assert.equal(a.element('#workspace').hidden, false, 'a refused replacement must not hide the working catalog and plan');
    assert.equal(a.element('.mobile-tabs').hidden, false);
    assert.equal(a.element('#catalog-start').hidden, true);
    assert.match(a.toast(), /Katalog.*nicht|nicht.*Katalog/i);
    assert.equal(a.element('#catalog-open').disabled, false);
    assert.equal(input.value, '');
    assert.deepEqual(a.state(), before); assert.equal(a.raw(), durable);
    assert.equal(a.run('catalog.version'), realCatalog.version);
    assert.equal((await a.exported()).plan.title, before.plan.title);
    a.run('renderCatalog(); renderCalculator();');
  });
}
test('first catalog failure still offers the file-start screen; valid retry activates it', async () => {
  const a = await app(); const input = a.element('#catalog-file');
  input.files = [{size: 2, text: async () => '{}'}]; await input.change({target: input});
  assert.equal(a.element('#workspace').hidden, true); assert.equal(a.element('#catalog-start').hidden, false);
  assert.match(a.element('#catalog-error').textContent, /Katalogformat/);
  input.files = [{size: 10, text: async () => JSON.stringify(realCatalog)}]; await input.change({target: input});
  assert.equal(a.element('#workspace').hidden, false); assert.equal(a.element('#catalog-start').hidden, true);
  assert.equal(a.run('catalog.version'), realCatalog.version);
});
