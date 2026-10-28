import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as domain from '../src/domain.js';
import * as catalogs from '../src/catalog.js';

// Execute the actual application handlers with a minimal DOM, not a copied importer.
// Native file inputs, dialogs and reload are additionally covered by import-race-browser.mjs.
async function app() {
  const elements = new Map(), storage = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: '', textContent: '', hidden: false,
      dataset: {}, classList: { toggle() {} }, setAttribute() {}, addEventListener(type, fn) { this[type] = fn; } });
    return elements.get(selector);
  };
  const context = vm.createContext({ ...domain, ...catalogs, structuredClone, performance,
    document: { querySelector: element, querySelectorAll: () => [], body: { dataset: {} }, addEventListener() {} },
    window: { addEventListener() {} }, localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    confirm: () => true, setTimeout: () => 1, clearTimeout() {} });
  const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.replace(/^import[\s\S]*?from '\.\/catalog\.js';\n/, '')
    .replace(/boot\(\)\.catch\(error => showCatalogStart\(error\.message\)\);\s*$/, '')
    + '\ncatalog = { version: "test", positions: [], chapters: [], sections: [] }; index = []; lookup = []; chapterLookup = new Map(); sectionLookup = new Map(); bindEvents();', context);
  const input = element('#import-file');
  const start = name => {
    let resolve, reject;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    input.value = name;
    const done = input.change({ target: Object.assign(input, { files: [{ size: 100, text: () => pending }] }) });
    return { done, resolve, reject };
  };
  const payload = title => JSON.stringify({ kind: 'dentotar-plan', schemaVersion: 1, catalogVersion: 'test',
    mode: 'private', privateLevel: 'reference', taxPointValue: '1.00', plan: { title, lines: [] } });
  return { start, payload, input, title: () => element('#plan-title').value,
    toast: () => element('#toast').textContent, raw: () => storage.get('dentotar.workspace.v1') };
}

test('a slow earlier import cannot overwrite the newer selection or persisted plan', async () => {
  const a = await app(), slow = a.start('slow.json'), latest = a.start('latest.json');
  latest.resolve(a.payload('Newest plan')); await latest.done;
  assert.match(a.toast(), /importiert und lokal gespeichert/);
  const before = a.raw();
  slow.resolve(a.payload('Stale plan')); await slow.done;
  assert.equal(a.title(), 'Newest plan', 'late file read must not replace the newer imported plan');
  assert.equal(a.raw(), before, 'late file read must not overwrite localStorage');
});

test('stale read rejection and malformed JSON cannot replace the current success message', async () => {
  for (const reject of [false, true]) {
    const a = await app(), slow = a.start('slow.json'), latest = a.start('latest.json');
    latest.resolve(a.payload('Newest plan')); await latest.done;
    assert.match(a.toast(), /importiert und lokal gespeichert/);
    const before = a.raw(), message = a.toast();
    if (reject) slow.reject(new Error('old read failed')); else slow.resolve('{broken');
    await slow.done;
    assert.equal(a.toast(), message, 'an obsolete read must not announce a failure for the current import');
    assert.equal(a.raw(), before);
  }
});

test('stale finally cannot clear the newer file input while its read is pending', async () => {
  const a = await app(), slow = a.start('slow.json'), latest = a.start('latest.json');
  slow.resolve(a.payload('Stale plan')); await slow.done;
  assert.equal(a.input.value, 'latest.json');
  assert.equal(a.raw(), undefined, 'no obsolete selection should persist while the latest is pending');
  latest.resolve(a.payload('Newest plan')); await latest.done;
  assert.equal(a.input.value, ''); assert.equal(a.title(), 'Newest plan');
});

test('a rejected latest selection does not resurrect an older valid read', async () => {
  const a = await app(), seed = a.start('seed.json');
  seed.resolve(a.payload('Original plan')); await seed.done;
  assert.match(a.toast(), /importiert und lokal gespeichert/);
  const before = a.raw(), slow = a.start('slow.json'), latest = a.start('invalid.json');
  latest.resolve('{broken'); await latest.done;
  assert.match(a.toast(), /Import abgelehnt/);
  slow.resolve(a.payload('Stale plan')); await slow.done;
  assert.equal(a.title(), 'Original plan'); assert.equal(a.raw(), before);
});
