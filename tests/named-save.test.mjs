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
  const context = vm.createContext({ ...domain, ...catalogs, structuredClone, performance, Blob,
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
    + '\nhydrate(); bindEvents(); catalog = { version: "synthetic", positions: [], chapters: [], sections: [] }; index = []; lookup = []; chapterLookup = new Map(); sectionLookup = new Map(); syncFields(); renderCalculator();', context);
  return {
    state: () => JSON.parse(vm.runInContext('JSON.stringify(state)', context)), raw: () => raw, writes,
    attempts: () => attempts, fail(value) { fail = value; }, external(value) { raw = value; },
    click(selector, dataset = {}) { return element(selector).click({ target: { closest: () => ({ dataset }) } }); },
    edit(title) { element('#plan-title').input({ target: { value: title } }); },
    html: selector => element(selector).innerHTML, toast: () => element('#toast').textContent,
    status: () => element('#save-status').textContent,
    async exported() { element('#json-export').click(); return JSON.parse(await downloads.at(-1).text()); },
    async import(payload) { const input = element('#import-file'); input.files = [{ size: 100, text: async () => JSON.stringify(payload) }]; await input.change({ target: input }); }
  };
}

for (const boundary of ['quota', 'read', 'drift', 'locked']) {
  test(`failed named save at ${boundary} does not publish a phantom snapshot or consume a slot`, async () => {
    const a = await app();
    if (boundary === 'quota' || boundary === 'read') a.fail(boundary);
    if (boundary === 'drift') a.external(JSON.stringify({ ...seed(), plan: { title: 'Other tab', lines: [] } }));
    if (boundary === 'locked') { a.fail('quota'); a.edit('Memory-only active draft'); }
    const before = a.state(), raw = a.raw(), writes = a.writes.length;
    for (let i = 0; i <= domain.LIMITS.savedPlans; i++) a.click('#save-plan');
    a.click('#saved-button');
    assert.deepEqual(a.state(), before, 'persist refusal must leave the complete active workspace and named list unchanged');
    assert.equal(a.raw(), raw, 'previous raw storage bytes must survive');
    assert.equal(a.writes.length, writes);
    assert.doesNotMatch(a.html('#saved-content'), /<h3>(?:Active draft|Memory-only active draft)<\/h3>/,
      'failed snapshot must not be offered as a named saved plan');
    assert.match(a.toast(), /nicht.*gespeichert/i, 'the initiating save action must explicitly report refusal');
    assert.match(a.toast(), /JSON/);
    assert.doesNotMatch(a.toast(), /Maximal/);
    const exported = await a.exported();
    assert.deepEqual(exported.plan, before.plan, 'current unsaved draft must remain exportable through the real click handler');
    assert.equal(exported.mode, before.mode);
    assert.equal(a.attempts(), boundary === 'quota' || boundary === 'locked' ? 1 : 0);
  });
}

test('successful named save is one durable deep snapshot and supports restore/reset/export/import', async () => {
  const a = await app(), before = a.state();
  a.click('#save-plan');
  assert.equal(a.writes.length, 1); assert.deepEqual(JSON.parse(a.raw()), a.state());
  const saved = a.state().savedPlans.at(-1);
  assert.deepEqual(saved.plan, before.plan); assert.equal(a.state().savedPlans.length, 2);
  assert.deepEqual(a.state().savedPlans[0], before.savedPlans[0]);
  assert.deepEqual(a.state().favorites, before.favorites);
  assert.match(a.toast(), /lokal gespeichert/);
  a.edit('New active title');
  assert.equal(a.state().savedPlans.at(-1).plan.title, 'Active draft');
  a.click('#saved-button'); a.click('#saved-content', { loadSaved: saved.id });
  assert.deepEqual(a.state().plan, saved.plan); assert.deepEqual(JSON.parse(a.raw()), a.state());
  const exported = await a.exported();
  a.click('#clear-plan'); assert.equal(a.state().plan.lines.length, 0);
  await a.import(exported);
  assert.deepEqual(a.state().plan, before.plan); assert.deepEqual(JSON.parse(a.raw()), a.state());
  const reloaded = await app(JSON.parse(a.raw()));
  assert.deepEqual(reloaded.state(), a.state());
});

test('restoring a saved plan retains its settings and copy isolation', async () => {
  const a = await app(), saved = a.state().savedPlans[0];
  a.click('#saved-content', { loadSaved: saved.id });
  for (const field of ['mode', 'privateLevel', 'taxPointValue', 'plan']) assert.deepEqual(a.state()[field], saved[field]);
  a.edit('Changed restored draft'); assert.deepEqual(a.state().savedPlans[0], saved);
});

test('invalid input and full capacity continue refusing before any write', async () => {
  const invalid = await app(); invalid.edit('x'.repeat(161));
  const before = invalid.state(); invalid.click('#save-plan');
  assert.deepEqual(invalid.state(), before); assert.equal(invalid.attempts(), 0);
  const initial = seed(); initial.savedPlans = Array.from({ length: domain.LIMITS.savedPlans }, () => snapshot());
  const full = await app(initial); full.click('#save-plan');
  assert.deepEqual(full.state(), initial); assert.equal(full.attempts(), 0); assert.match(full.toast(), /Maximal/);
});

test('ordinary memory-only editing and valid imports remain available after storage refusal', async () => {
  const a = await app(), initial = a.raw();
  a.fail('quota'); a.edit('Memory-only draft');
  const exported = await a.exported(); exported.plan.title = 'Intentional memory-only import';
  await a.import(exported);
  assert.equal(a.state().plan.title, exported.plan.title); assert.equal(a.raw(), initial);
  assert.match(a.toast(), /Import nur im Arbeitsspeicher/);
  assert.deepEqual((await a.exported()).plan, exported.plan);
  const before = a.state(); a.click('#save-plan');
  assert.deepEqual(a.state(), before, 'memory-only import must not bypass named-save refusal');
});
