import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixed, decimal, moneyCents, normalize, buildSearchIndex, search, defaultPoints,
  createState, validateState, validatePlan, exportPlan, importPlan, calculatePlan, csvCell, planCSV } from '../src/domain.js';

// Synthetic fixtures, not a distributed tariff extract.
const service = (overrides = {}) => ({ code: '4.9001', title: 'Prüfung synthetisch', shortTitle: null,
  chapter: '01', section: '01.01', socialPoints: 10.1, privateMin: 8, privateMax: 12,
  coverage: 'UV/MV/IV', notes: 'Röntgen und Zähne', kind: 'service', excludes: [], members: [], packages: [], ...overrides });
const line = (overrides = {}) => ({ id: 'test-line', code: '4.9001', quantity: 1, points: null, note: '', ...overrides });
const stateWith = (...lines) => { const state = createState(); state.plan.lines = lines; return state; };

test('decimal parsing is exact and accepts comma', () => {
  assert.equal(fixed('73,20'), 7320n); assert.equal(decimal(7320n), '73.20');
  assert.equal(fixed('0.0001', 4), 1n);
});
test('invalid decimal syntax never silently coerces', () => {
  for (const value of ['', '-1', '1e2', '1a', '1.234', '1,2,3', null, NaN, Infinity]) assert.throws(() => fixed(value));
});
test('line currency uses half-up cents, not binary floats', () => {
  assert.equal(moneyCents('19.20', '1.1', 2), 4224);
  assert.equal(moneyCents('1', '0.005'), 1);
  assert.equal(moneyCents('1', '0.0049'), 0);
  assert.equal(moneyCents('0', '1'), 0);
});
test('round once per line after quantity multiplication', () => {
  assert.equal(moneyCents('1', '0.005', 2), 1);
});
test('rate and quantity bounds are enforced', () => {
  for (const r of ['0', '-1', '1001', 'abc']) assert.throws(() => moneyCents(1, r));
  for (const q of [0, -1, 1.5, 1000, NaN]) assert.throws(() => moneyCents(1, '1', q));
});
test('search handles umlauts, spaces and compact position code', () => {
  const rows = buildSearchIndex([service(), service({ code: '4.9002', title: 'Andere Leistung' })]);
  assert.equal(search(rows, ' ROENTGEN   zaehne ').length, 2);
  assert.equal(search(rows, '49001')[0].code, '4.9001');
  assert.equal(normalize('ÄÖÜß'), 'aeoeuess');
});
test('search ranking prefers exact code and title before note-only matches', () => {
  const rows = buildSearchIndex([service({ code: '4.9002', notes: '4.9001' }), service()]);
  assert.equal(search(rows, '4.9001')[0].code, '4.9001');
});
test('chapter and favorites filters compose with query', () => {
  const a = service(), b = service({ code: '4.9002', chapter: '02' });
  assert.deepEqual(search(buildSearchIndex([a, b]), '', { chapter: '01', favorites: new Set([b.code]) }), []);
});
test('private reference and profile values stay inside source range', () => {
  assert.equal(defaultPoints(service(), 'private'), 10.1);
  assert.equal(defaultPoints(service(), 'private', 'min'), 8);
  assert.equal(defaultPoints(service(), 'private', 'max'), 12);
  assert.equal(defaultPoints(service({ socialPoints: 100 }), 'private'), 10);
});
test('missing social values are not private values or zeros', () => {
  const row = service({ socialPoints: null });
  assert.equal(defaultPoints(row, 'social'), null);
  assert.equal(defaultPoints(row, 'private'), 10);
});
test('real zero values are distinct from unavailable values', () => {
  assert.equal(defaultPoints(service({ socialPoints: 0 }), 'social'), 0);
  const s = stateWith(line()); s.mode = 'social';
  const result = calculatePlan(s, [service({ socialPoints: 0 })]);
  assert.equal(result.complete, true); assert.equal(result.totalCents, 0);
});
test('missing PP range cannot be calculated privately', () => {
  const result = calculatePlan(stateWith(line()), [service({ privateMin: null, privateMax: null })]);
  assert.equal(result.complete, false); assert.equal(result.lines[0].amountCents, null);
});
test('plan total is sum of rounded line cents', () => {
  const s = stateWith(line(), line({ id: 'second', quantity: 3 }));
  s.taxPointValue = '1.13';
  const result = calculatePlan(s, [service()]);
  assert.equal(result.totalCents, 4565); // 11.41 + 34.24
  assert.equal(result.pointsTotal, '40.40');
});
test('custom private points are preserved when social mode is selected', () => {
  const s = stateWith(line({ points: '11.50' }));
  assert.equal(calculatePlan(s, [service()]).totalCents, 1150);
  s.mode = 'social'; assert.equal(calculatePlan(s, [service()]).totalCents, 1010);
  assert.equal(s.plan.lines[0].points, '11.50');
});
test('custom points outside private range are invalid, not clamped', () => {
  const result = calculatePlan(stateWith(line({ points: '100' })), [service()]);
  assert.equal(result.complete, false); assert.equal(result.totalCents, 0);
  assert.match(result.lines[0].errors[0], /ausserhalb/);
});
test('unknown imported codes are retained and make subtotal incomplete', () => {
  const s = stateWith(line({ code: 'unknown' }), line({ id: 'valid' }));
  const result = calculatePlan(s, [service()]);
  assert.equal(result.lines.length, 2); assert.equal(result.complete, false); assert.equal(result.totalCents, 1010);
});
test('explicit exclusions emit one pair warning', () => {
  const a = service({ excludes: ['4.9002'] }), b = service({ code: '4.9002', excludes: ['4.9001'] });
  const result = calculatePlan(stateWith(line(), line({ id: 'second', code: b.code })), [a, b]);
  assert.equal(result.warnings.length, 1); assert.match(result.warnings[0], /nicht kumulierbar/);
});
test('package plus included member warns about double billing', () => {
  const packageRow = service({ code: '4.9001.LP', kind: 'package', members: ['4.9001'] });
  const result = calculatePlan(stateWith(line(), line({ id: 'package', code: packageRow.code })), [service(), packageRow]);
  assert.equal(result.warnings.length, 1); assert.match(result.warnings[0], /Doppelverrechnung/);
});
test('state validation projects an allowlisted schema', () => {
  const s = createState(); s.unexpected = 'ignore';
  assert.equal('unexpected' in validateState(s), false);
  assert.deepEqual(validateState(s), createState());
});
test('malformed state and duplicate line IDs fail before replacement', () => {
  assert.throws(() => validateState({}));
  assert.throws(() => validatePlan({ title: 'bad', lines: [line(), line()] }));
  assert.throws(() => validatePlan({ title: 'bad', lines: [line({ quantity: 0 })] }));
  assert.throws(() => validatePlan({ title: 'bad', lines: [line({ points: '-1' })] }));
  assert.throws(() => validateState({ ...createState(), taxPointValue: 'garbage' }));
});
test('JSON plan roundtrip is lossless and reports version mismatch', () => {
  const s = stateWith(line({ points: '11.50', note: '<literal> & Ü' }));
  const exported = exportPlan(s, '2025.1');
  const incoming = importPlan(JSON.parse(JSON.stringify(exported)), '2025.1');
  assert.deepEqual(incoming.plan, s.plan); assert.equal(incoming.versionMismatch, false);
  assert.equal(importPlan(exported, 'future').versionMismatch, true);
  assert.throws(() => importPlan({ ...exported, schemaVersion: 999 }, '2025.1'));
});
test('export and import do not mutate supplied state', () => {
  const s = stateWith(line()); const before = JSON.stringify(s);
  const incoming = importPlan(exportPlan(s, 'test'), 'test'); incoming.plan.lines[0].quantity = 9;
  assert.equal(JSON.stringify(s), before);
});
test('CSV quotes delimiters and neutralizes spreadsheet formulas', () => {
  assert.equal(csvCell('a;"b'), '"a;""b"');
  for (const text of ['=1+1', '+cmd', '-1', '@SUM(A1)', '  =1', '\t=1']) assert.ok(csvCell(text).startsWith('"\''));
});
test('CSV carries mode, precision, source version and warnings', () => {
  const s = stateWith(line()); const csv = planCSV(s, calculatePlan(s, [service()]), 'synthetic');
  assert.ok(csv.startsWith('\ufeff')); assert.match(csv, /synthetic/); assert.match(csv, /10.10/);
  assert.match(csv, /0.01 CHF/); assert.match(csv, /Privatpatienten/);
});
test('fixed CHF amounts are multiplied by quantity, never the taxpoint value', () => {
  const row = service({ socialPoints: null, privateMin: null, privateMax: null,
    kind: 'material', amountsCHF: { social: 12.34, private: 12.34 } });
  const s = stateWith(line({ quantity: 3 })); s.taxPointValue = '2.5';
  const result = calculatePlan(s, [row]);
  assert.equal(result.complete, true); assert.equal(result.totalCents, 3702);
  assert.equal(result.pointsTotal, '0.00'); assert.equal(result.lines[0].amountCHF, 12.34);
  s.mode = 'social'; assert.equal(calculatePlan(s, [row]).totalCents, 3702);
  assert.match(planCSV(s, result, 'test'), /CHF fix je Einheit/);
});
test('fixed zero CHF is not missing, while open material amounts remain unavailable', () => {
  const row = service({ socialPoints: null, privateMin: null, privateMax: null,
    amountsCHF: { social: 0, private: null } });
  const s = stateWith(line()); s.mode = 'social';
  assert.equal(calculatePlan(s, [row]).complete, true);
  s.mode = 'private'; assert.equal(calculatePlan(s, [row]).complete, false);
});
test('a private TP override cannot silently change a CHF-fixed item', () => {
  const row = service({ amountsCHF: { private: 12.34 } });
  assert.equal(calculatePlan(stateWith(line({ points: '10' })), [row]).complete, false);
});
test('invalid global rate makes even empty or fixed-only outputs explicitly incomplete', () => {
  const empty = createState(); empty.taxPointValue = 'invalid';
  assert.equal(calculatePlan(empty, []).complete, false);
  const row = service({ socialPoints: null, privateMin: null, privateMax: null, amountsCHF: { private: 5 } });
  const s = stateWith(line()); s.taxPointValue = '0';
  const result = calculatePlan(s, [row]);
  assert.equal(result.complete, false); assert.equal(result.totalCents, 500);
  assert.ok(result.settingsErrors.length); assert.throws(() => planCSV(s, result, 'test'));
});
test('incomplete CSV export is refused', () => {
  const s = stateWith(line({ code: 'missing' }));
  assert.throws(() => planCSV(s, calculatePlan(s, []), 'test'));
});
