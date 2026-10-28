import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import * as domain from '../src/domain.js';
import * as catalogs from '../src/catalog.js';

// Offline ownership model: parse the actual rendered plan markup and invoke the
// registered delegated handlers. This is not a native keyboard/caret oracle.
function makeDOM() {
  let document, focusCalls = 0;
  const decode = text => text.replace(/&(amp|lt|gt|quot|#39);/g,
    (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name]);
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
      this.attributes = {}; this.dataset = new Proxy({}, { set: (data, key, value) => {
        data[key] = String(value);
        this.attributes['data-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())] = String(value);
        return true;
      } }); this.events = {}; this.hidden = false;
      this.value = ''; this.selectionStart = 0; this.selectionEnd = 0; this._text = '';
      this.classList = { toggle() {} };
    }
    get isConnected() { return this === document.body || Boolean(this.parentNode?.isConnected); }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
    remove() {
      if (!this.parentNode) return;
      if (this.contains(document.activeElement)) document.activeElement = document.body;
      this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null;
    }
    set textContent(text) { for (const child of [...this.children]) child.remove(); this._text = String(text); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(html) {
      this.textContent = '';
      const stack = [this];
      for (const token of html.match(/<[^>]+>|[^<]+/g) || []) {
        if (token.startsWith('</')) { stack.pop(); continue; }
        if (!token.startsWith('<')) { stack.at(-1)._text += decode(token); continue; }
        const [, tag] = /^<([\w-]+)/.exec(token);
        const node = new Element(tag);
        for (const match of token.slice(tag.length + 1).matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
          node.setAttribute(match[1], decode(match[2] ?? ''));
        }
        stack.at(-1).append(node);
        if (!['input', 'br', 'use'].includes(tag) && !token.endsWith('/>')) stack.push(node);
      }
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
      if (name === 'value') this.value = String(value);
      if (name === 'class') this.className = String(value);
    }
    getAttribute(name) { return this.attributes[name] ?? null; }
    matches(selector) {
      if (selector.startsWith('.')) return (this.className || '').split(/\s+/).includes(selector.slice(1));
      const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
      if (attribute) return this.getAttribute(attribute[1]) !== null
        && (attribute[2] === undefined || this.getAttribute(attribute[1]) === attribute[2]);
      return this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) ?? null; }
    addEventListener(type, fn) { (this.events[type] ??= []).push(fn); }
    fire(type, event = {}) {
      for (let node = this; node; node = node.parentNode) {
        for (const fn of node.events[type] ?? []) fn({ target: this, ...event });
      }
    }
    focus() { focusCalls++; document.activeElement = this; }
    click() { this.fire('click'); }
  }
  const roots = new Map();
  document = new Element('#document'); document.body = new Element('body');
  document.body.parentNode = document; document.children = [document.body]; document.activeElement = document.body;
  document.querySelector = selector => {
    if (!selector.startsWith('#')) return null;
    const descendant = document.body.querySelectorAll(`[id="${selector.slice(1)}"]`)[0];
    if (descendant) return descendant;
    if (!roots.has(selector)) { const node = new Element(); roots.set(selector, node); document.body.append(node); }
    return roots.get(selector);
  };
  document.querySelectorAll = () => []; // Native dialogs are outside this fixture boundary.
  document.createElement = tag => new Element(tag);
  return { document, element: selector => document.querySelector(selector), focusCalls: () => focusCalls };
}

const service = (extra = {}) => ({ code: '4.9001', title: 'Synthetische Leistung', chapter: '01', section: '01.01',
  socialPoints: 10.1, privateMin: 8, privateMax: 12, excludes: [], members: [], packages: [], ...extra });
const line = (extra = {}) => ({ id: 'first', code: '4.9001', quantity: 1, points: null, note: '', ...extra });
const fmt = cents => new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
async function app(lines = [line()], positions = [service()]) {
  const dom = makeDOM(), storage = new Map(), downloads = [], window = new dom.document.constructor('window');
  // Reconciliation adapter for the exact622 persistence boundary: seed a valid
  // raw workspace, then let actual hydrate() establish its read baseline. Never
  // assign storageRaw, unlock storage, or bypass the real compare/write path.
  const initial = domain.createState(); initial.plan.lines = structuredClone(lines);
  storage.set('dentotar.workspace.v1', JSON.stringify(initial));
  window.print = () => { window.prints = (window.prints || 0) + 1; };
  const context = vm.createContext({ ...domain, ...catalogs, structuredClone, performance, Map, Set,
    document: dom.document, window, crypto: { randomUUID }, downloads,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    confirm: () => true, setTimeout: () => 1, clearTimeout() {} });
  const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const imports = /^import[\s\S]*?from '\.\/catalog\.js';\n/;
  const boot = /boot\(\)\.catch\(error => showCatalogStart\(error\.message\)\);\s*$/;
  assert.ok(imports.test(source)); assert.ok(boot.test(source));
  vm.runInContext(source.replace(imports, '').replace(boot, ''), context);
  context.fixturePositions = positions;
  const run = code => vm.runInContext(code, context);
  run(`hydrate(); catalog = { version: 'synthetic', positions: fixturePositions, chapters: [], sections: [] };
    index = buildSearchIndex(catalog.positions); lookup = new Map(catalog.positions.map(p => [p.code, p]));
    chapterLookup = new Map(); sectionLookup = new Map();
    download = (name, content, type) => downloads.push({ name, content, type }); bindEvents(); renderCalculator(); persist();`);
  assert.equal(run('storageLocked'), false, 'valid fixture hydration and initial write must remain acknowledged');
  assert.equal(run('storageRaw'), storage.get('dentotar.workspace.v1'), 'actual persistence must own its current raw baseline');
  const controls = () => dom.element('#plan-lines').querySelectorAll('input');
  const field = (name, id = 'first') => dom.element('#plan-lines').querySelector(`[data-${name}="${id}"]`);
  const change = (input, value) => { input.value = value; input.fire('change'); };
  const raw = () => storage.get('dentotar.workspace.v1');
  return { ...dom, run, storage, downloads, window, controls, field, change, raw,
    stored: () => JSON.parse(raw()), click: id => dom.element(id).click() };
}
function sameControls(a, before) {
  const after = a.controls();
  assert.equal(after.length, before.length);
  before.forEach((input, i) => {
    assert.ok(after[i] === input, 'nonstructural edit must preserve the existing plan input identity');
    assert.equal(input.isConnected, true);
  });
}

test('quantity commits retain every rendered control at the 200-line limit', async () => {
  const count = domain.LIMITS.lines;
  const a = await app(Array.from({ length: count }, (_, i) => line({ id: i ? `line-${i}` : 'first' })));
  const before = a.controls(), quantity = a.field('quantity'), pointsDraft = a.field('points', 'line-1');
  pointsDraft.value = '11,'; // An unrelated uncommitted draft must not be normalized by another row.
  const note = a.field('note', 'line-1'); note.value = 'Zahn <11> & Sitzung'; note.fire('input');
  note.selectionStart = 5; note.selectionEnd = 9; quantity.focus();
  for (const value of ['2', '3', '2']) {
    a.change(quantity, value); sameControls(a, before);
    assert.equal(a.document.activeElement, quantity);
    assert.equal(pointsDraft.value, '11,'); assert.equal(note.value, 'Zahn <11> & Sitzung');
    assert.equal(note.selectionStart, 5); assert.equal(note.selectionEnd, 9);
    assert.equal(a.stored().plan.lines[0].quantity, Number(value));
    assert.equal(a.element('#total-amount').textContent, fmt((count - 1) * 1010 + Number(value) * 1010));
    assert.equal(a.element('#csv-export').disabled, false);
  }
  a.run("addPosition('4.9001')");
  assert.equal(a.run('state.plan.lines.length'), count, 'adding an existing code only increments its quantity');
  a.run("state.plan.lines.forEach(l => { l.note = 'separate'; }); addPosition('4.9001')");
  assert.equal(a.run('state.plan.lines.length'), count, 'the structural add path must still enforce 200 lines');
});

test('invalid quantity and TP drafts remain editable with live errors and recover in place', async () => {
  const a = await app(), before = a.controls(), quantity = a.field('quantity'), points = a.field('points');
  const saved = a.raw();
  for (const value of ['', '0', '1.5', '1000']) {
    quantity.focus(); a.change(quantity, value); sameControls(a, before);
    assert.equal(quantity.value, value); assert.equal(a.raw(), saved);
    assert.match(a.element('#total-label').textContent, /unvollständig/);
    assert.equal(a.element('#csv-export').disabled, true);
    assert.equal(a.element('#plan-lines').querySelectorAll('.line-error').length, 1);
    assert.equal(a.element('#plan-lines').querySelector('.line-amount').textContent, '—');
  }
  a.change(quantity, '2'); assert.equal(a.element('#total-amount').textContent, '20.20');
  assert.equal(a.element('#plan-lines').querySelector('.line-amount').textContent, 'CHF 20.20');
  const valid = a.raw();
  for (const value of ['', '11,', '-1']) {
    points.focus(); points.selectionStart = value.length; points.selectionEnd = value.length;
    a.change(points, value); sameControls(a, before);
    assert.equal(points.value, value); assert.equal(a.document.activeElement, points);
    assert.equal(points.selectionStart, value.length); assert.equal(points.selectionEnd, value.length);
    assert.equal(points.getAttribute('aria-invalid'), 'true'); assert.equal(a.raw(), valid);
    assert.equal(a.element('#plan-lines').querySelectorAll('.line-error').length, 1);
    assert.equal(a.element('#csv-export').disabled, true);
  }
  a.change(points, '999'); sameControls(a, before);
  assert.match(a.element('#plan-lines').querySelector('.line-error').textContent, /ausserhalb/);
  assert.equal(a.element('#total-amount').textContent, '0.00');
  // Preserve the existing storage contract: syntactically valid out-of-range TP
  // survive reload, but calculation/CSV remain incomplete until corrected.
  assert.equal(a.stored().plan.lines[0].points, '999');
  a.change(points, '11,50'); sameControls(a, before);
  assert.equal(a.element('#total-amount').textContent, '23.00');
  assert.equal(a.element('#plan-lines').querySelector('.line-amount').textContent, 'CHF 23.00');
  assert.equal(a.element('#total-points').textContent, '23.00 TP');
  assert.equal(points.getAttribute('aria-invalid'), 'false');
  assert.equal(a.element('#plan-lines').querySelectorAll('.line-error').length, 0);
  assert.equal(a.element('#plan-lines').querySelectorAll('[data-reset-points]').length, 1);
  assert.equal(a.element('#csv-export').disabled, false);
  assert.equal(a.stored().plan.lines[0].points, '11,50');
});

test('a blur-time change never refocuses its old field or detaches the intended next control', async () => {
  const a = await app(), before = a.controls(), quantity = a.field('quantity'), points = a.field('points'), note = a.field('note');
  points.focus(); const calls = a.focusCalls();
  a.change(quantity, '2'); sameControls(a, before);
  assert.equal(a.document.activeElement, points); assert.equal(a.focusCalls(), calls);
  note.focus(); note.selectionStart = 2; note.selectionEnd = 4;
  a.change(points, '11.50'); sameControls(a, before);
  assert.equal(a.document.activeElement, note); assert.equal(a.focusCalls(), calls + 1);
  assert.equal(note.selectionStart, 2); assert.equal(note.selectionEnd, 4);
});

test('real CSV and print handlers calculate fresh quantity, TP and immediate note edits', async () => {
  const a = await app(), before = a.controls();
  a.change(a.field('quantity'), '2'); a.change(a.field('points'), '11,50'); sameControls(a, before);
  for (const note of ['Zahn <21> & Sitzung', 'ersetzt', '']) {
    a.field('note').value = note; a.field('note').fire('input');
    a.click('#csv-export'); a.click('#print-plan');
    const csv = a.downloads.at(-1).content;
    assert.match(csv, /"4.9001";"Synthetische Leistung";"2";"11,50";"";"23.00";/);
    assert.ok(csv.includes(domain.csvCell(note) + '\r\n'));
    const table = a.element('#printout').querySelector('tbody');
    assert.ok(table.textContent.includes('23.00'));
    assert.deepEqual(table.querySelectorAll('small').map(node => node.textContent), note ? [note] : []);
    assert.equal(a.stored().plan.lines[0].note, note); sameControls(a, before);
  }
  assert.equal(a.window.prints, 3);
});

test('settings, resets and structural edits still redraw with overrides and CHF readonly intact', async () => {
  const fixed = service({ code: '4.9002.M', amountsCHF: { private: 12.34, social: 12.34 } });
  const a = await app([line({ points: '11.50' }), line({ id: 'fixed', code: fixed.code })], [service(), fixed]);
  const before = a.controls(), fixedPoints = a.field('points', 'fixed');
  assert.equal(fixedPoints.getAttribute('readonly'), ''); assert.equal(fixedPoints.value, '12.34');
  a.change(a.field('quantity', 'fixed'), '3'); sameControls(a, before);
  assert.equal(a.element('#total-amount').textContent, '48.52');
  a.element('#tax-point').value = '2.50'; a.element('#tax-point').fire('input');
  assert.notEqual(a.field('points'), before[1]); assert.equal(before[1].isConnected, false);
  assert.equal(a.element('#total-amount').textContent, '65.77');
  assert.equal(a.field('points', 'fixed').value, '12.34');
  a.element('#private-level').value = 'max'; a.element('#private-level').fire('change');
  assert.equal(a.field('points').value, '11.50');
  a.click('#social-mode'); assert.equal(a.field('points').getAttribute('readonly'), '');
  assert.equal(a.field('points').value, '10.1'); assert.equal(a.stored().plan.lines[0].points, '11.50');
  a.click('#private-mode'); assert.equal(a.field('points').getAttribute('readonly'), null);
  a.element('#plan-lines').querySelector('[data-reset-points="first"]').click();
  assert.equal(a.field('points').value, '12'); assert.equal(a.stored().plan.lines[0].points, null);
  a.element('#plan-lines').querySelector('[data-remove="fixed"]').click();
  assert.equal(a.stored().plan.lines.length, 1);
});

test('nonstructural edits keep raw-storage and external-storage write locks', async () => {
  for (const corrupt of [true, false]) {
    const a = await app(), before = a.controls();
    if (corrupt) { a.storage.set('dentotar.workspace.v1', '{broken raw'); a.run('hydrate()'); }
    else a.run("window.fire('storage', { key: 'dentotar.workspace.v1', storageArea: localStorage })");
    const raw = a.raw();
    a.change(a.field('quantity'), '2'); sameControls(a, before);
    assert.equal(a.element('#total-amount').textContent, '20.20'); assert.equal(a.raw(), raw);
    assert.match(a.element('#save-status').textContent, /Nicht gespeichert/);
    if (corrupt) {
      a.element('#raw-backup').click(); assert.equal(a.downloads.at(-1).content, '{broken raw');
    }
  }
});

test('recalculating retains unknown plan rows and exclusion/package warnings', async () => {
  const other = service({ code: '4.9002', excludes: ['4.9001'] });
  const pack = service({ code: '4.9001.LP', kind: 'package', members: ['4.9001'] });
  const a = await app([line(), line({ id: 'other', code: other.code }),
    line({ id: 'pack', code: pack.code }), line({ id: 'unknown', code: 'unknown' })], [service(), other, pack]);
  const before = a.controls();
  a.change(a.field('quantity'), '2'); sameControls(a, before);
  assert.equal(a.element('#total-amount').textContent, '40.40');
  assert.equal(a.element('#csv-export').disabled, true);
  assert.match(a.element('#total-label').textContent, /unvollständig/);
  assert.match(a.element('#plan-warnings').textContent, /nicht kumulierbar/);
  assert.match(a.element('#plan-warnings').textContent, /Doppelverrechnung/);
  a.change(a.field('quantity', 'unknown'), '2'); sameControls(a, before);
  const unknown = a.element('#plan-lines').querySelector('[data-line="unknown"]');
  assert.match(unknown.querySelector('.line-error').textContent, /nicht im geladenen Katalog/);
  assert.equal(unknown.querySelector('.line-amount').textContent, '—');
  assert.equal(a.stored().plan.lines.at(-1).code, 'unknown');
});
