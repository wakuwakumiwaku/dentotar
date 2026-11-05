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

test('switching catalogs clears an unavailable chapter and resets pagination while preserving the plan',async()=>{
 const a=await app();a.run('globalThis.__catalog='+JSON.stringify(realCatalog)+';activateCatalog(__catalog);');
 const selected=realCatalog.positions[0].chapter;
 const retained=realCatalog.positions.find(p=>p.chapter!==selected).chapter;
 a.run('selectChapter('+JSON.stringify(selected)+');visible=150;');
 const before=a.state(),raw=a.raw();
 const incoming={...realCatalog,version:'SYNTHETIC chapter-subset QA',chapters:realCatalog.chapters.filter(c=>c.id===retained),positions:realCatalog.positions.filter(p=>p.chapter===retained)};
 a.run('activateCatalog('+JSON.stringify(incoming)+',true)');
 assert.equal(a.run('chapter'),'','removed chapter must not leave the UI silently filtering a different catalog');
 assert.equal(a.element('#chapter-select').value,'');
 assert.equal(a.run('visible'),50,'new catalog starts with its first page');
 assert.equal(a.element('#current-filter').hidden,true);
 assert.match(a.element('#results-count').textContent,new RegExp('^'+incoming.positions.length+' Treffer$'));
 assert.deepEqual(a.state(),before);assert.equal(a.raw(),raw);
});
test('a chapter still present in the replacement remains selected',async()=>{
 const a=await app();a.run('activateCatalog('+JSON.stringify(realCatalog)+');');
 const selected=realCatalog.positions[0].chapter;
 a.run('selectChapter('+JSON.stringify(selected)+');visible=150;activateCatalog('+JSON.stringify(realCatalog)+',true);');
 assert.equal(a.run('chapter'),selected);assert.equal(a.element('#chapter-select').value,selected);assert.equal(a.run('visible'),50);
});
