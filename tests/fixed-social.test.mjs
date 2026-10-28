import test from 'node:test';
import assert from 'node:assert/strict';
import {createState, calculatePlan, exportPlan, importPlan, planCSV} from '../src/domain.js';

// Entirely synthetic tariff values; no source price is edited or inferred.
const row = {code: 'synthetic.M', title: 'Synthetic fixed material', socialPoints: null,
  privateMin: null, privateMax: null, amountsCHF: {social: 12.34, private: 12.34},
  excludes: [], members: [], packages: [], kind: 'material'};
function state() {
  const value = createState();
  value.mode = 'social'; value.taxPointValue = '7.5';
  value.plan.lines = [{id: 'fixed-line', code: row.code, quantity: 3, points: '10.00', note: 'Synthetic private override'}];
  return value;
}
test('social fixed CHF ignores but retains the private TP override across portable roundtrip', () => {
  const value = state(), before = structuredClone(value);
  const result = calculatePlan(value, [row]);
  assert.equal(result.complete, true, 'a private TP override cannot invalidate a known social CHF amount');
  assert.equal(result.totalCents, 3702); assert.equal(result.pointsTotal, '0.00');
  assert.deepEqual(result.lines[0].errors, []); assert.equal(result.lines[0].points, null);
  assert.equal(result.lines[0].overridePoints, '10.00');
  assert.match(planCSV(value, result, 'synthetic'), /37.02/);
  assert.deepEqual(importPlan(exportPlan(value, 'synthetic'), 'synthetic').plan, value.plan);
  assert.deepEqual(value, before, 'calculation and export must not erase a private override');
});
test('social zero-CHF fixed lines with retained overrides are complete, not missing', () => {
  const result = calculatePlan(state(), [{...row, amountsCHF: {social: 0, private: 12.34}}]);
  assert.equal(result.complete, true); assert.equal(result.totalCents, 0);
});
test('switching back to private mode still refuses the retained override on a fixed item', () => {
  const value = state(); value.mode = 'private';
  const result = calculatePlan(value, [row]);
  assert.equal(result.complete, false); assert.equal(result.totalCents, 0);
  assert.match(result.lines[0].errors[0], /CHF-Fixbeträge/);
  assert.throws(() => planCSV(value, result, 'synthetic'));
  value.mode = 'social';
  assert.equal(calculatePlan(value, [row]).complete, true);
  assert.equal(value.plan.lines[0].points, '10.00');
});
test('an override does not invent a missing social amount or taxpoints', () => {
  const result = calculatePlan(state(), [{...row, amountsCHF: {social: null, private: 12.34}}]);
  assert.equal(result.complete, false); assert.equal(result.totalCents, 0);
  assert.match(result.lines[0].errors[0], /Keine UV/);
});
test('private fixed lines without overrides retain the ordinary fixed-CHF calculation', () => {
  const value = state(); value.mode = 'private'; value.plan.lines[0].points = null;
  const result = calculatePlan(value, [row]);
  assert.equal(result.complete, true); assert.equal(result.totalCents, 3702);
});
test('invalid TPW still marks a social fixed-only plan incomplete', () => {
  const value = state(); value.taxPointValue = '0';
  const result = calculatePlan(value, [row]);
  assert.equal(result.complete, false); assert.equal(result.totalCents, 3702);
  assert.ok(result.settingsErrors.length);
});
