import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createAppServer } from '../scripts/serve.mjs';
import { checkImportRaces } from './import-race-browser.mjs';

// Optional native QA. No browser/runtime dependencies are shipped with the application.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = path.join(ROOT, '.local', 'qa', new Date().toISOString().replaceAll(':', '-'));
await mkdir(OUT, { recursive: true });
const playwright = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href) : await import('playwright-core');
const executablePath = process.env.CAMOUFOX_EXECUTABLE || path.join(os.homedir(), '.cache/camoufox/camoufox');
const catalog = JSON.parse(await readFile(path.join(ROOT, 'public/data/catalog.json'), 'utf8'));
const server = createAppServer({ root: ROOT });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const report = { engine: 'Camoufox / Firefox, headless', origin, catalogVersion: catalog.version,
  positions: catalog.positions.length, cases: [], errors: [], networkErrors: [], screenshots: [], searchTimingsMs: [] };
const tracked = new Set();
const track = page => {
  if (tracked.has(page)) return;
  tracked.add(page);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') report.errors.push(msg.text()); });
  page.on('response', response => { if (response.status() >= 400) report.networkErrors.push({ url: response.url(), status: response.status() }); });
};
async function context(options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
  ctx.on('page', track); return ctx;
}
async function ready(page) {
  await page.goto(origin);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  assert.match(await page.title(), /DENTOTAR/);
}
async function check(name, action) {
  const start = performance.now();
  try { await action(); report.cases.push({ name, status: 'pass', elapsedMs: Math.round(performance.now() - start) }); console.log(`PASS ${name}`); }
  catch (error) { report.cases.push({ name, status: 'fail', error: error.stack }); throw error; }
}
async function query(page, text) { await page.locator('#search').fill(text); }
async function screenshot(page, name) {
  const target = path.join(OUT, name + '.png');
  await page.screenshot({ path: target, fullPage: false }); report.screenshots.push(target);
}
async function noOverflow(page) {
  const box = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(box.document <= box.viewport, JSON.stringify(box));
}
async function answerDialog(page, accept, action) {
  const nextDialog = page.waitForEvent('dialog');
  const pendingAction = action();
  const dialog = await nextDialog;
  await (accept ? dialog.accept() : dialog.dismiss());
  await pendingAction;
}
async function add(page, code) { await query(page, code); await page.locator(`#results [data-add="${code}"]`).click(); }
const rawState = page => page.evaluate(() => localStorage.getItem('dentotar.workspace.v1'));
const waitText = async (page, selector, text) => { await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text }); };

try {
  browser = await playwright.firefox.launch({ executablePath, headless: true });
  const ctx = await context(); const page = await ctx.newPage();
  await check('full catalog loads and paginates without dropping rows', async () => {
    await ready(page);
    assert.equal(await page.locator('.tariff-row').count(), Math.min(50, catalog.positions.length));
    assert.match(await page.locator('#results-count').textContent(), new RegExp(String(catalog.positions.length)));
    await page.locator('#load-more').click(); assert.equal(await page.locator('.tariff-row').count(), 100);
    const ids = await page.locator('.tariff-row').evaluateAll(rows => rows.map(row => row.dataset.code));
    assert.equal(new Set(ids).size, ids.length);
  });
  await check('native search, no-match and exact-position ranking', async () => {
    await query(page, '4.0000'); assert.equal(await page.locator('.tariff-row').first().getAttribute('data-code'), '4.0000');
    await query(page, 'qzz-not-a-real-service'); assert.equal(await page.locator('.tariff-row').count(), 0);
    for (const q of ['roentgen', 'anaesthesie', '4.0500', 'implantat', '4.0000']) {
      await query(page, q); assert.ok(await page.locator('.tariff-row').count() > 0);
      report.searchTimingsMs.push({ query: q, renderMs: parseFloat(await page.locator('#search-timing').textContent()) });
    }
  });
  await check('details preserve original text and PDF provenance', async () => {
    await page.locator('#results [data-detail="4.0000"]').click();
    assert.ok(await page.locator('#detail-dialog').isVisible());
    assert.match(await page.locator('.original-notes').first().textContent(), /12 Monaten/);
    assert.ok(await page.locator('#detail-content a[href*="source-tariff.pdf#page="]').count());
    await screenshot(page, 'details-desktop');
    await page.locator('#detail-dialog [data-close]').click();
  });
  await check('favorite filter and category are real interactive filters', async () => {
    await page.locator('#results [data-favorite="4.0000"]').click();
    await page.locator('#favorites-filter').click(); assert.equal(await page.locator('.tariff-row').count(), 1);
    await page.locator('#all-filter').click();
    await query(page, ''); await page.locator('#chapter-nav [data-chapter="02"]').click();
    assert.ok((await page.locator('.tariff-row').count()) > 0);
    const expected = catalog.positions.filter(p => p.chapter === '02').length;
    assert.match(await page.locator('#results-count').textContent(), new RegExp(String(expected)));
    await page.locator('#chapter-nav [data-chapter=""]').click();
  });
  await check('assembly recalculates amount, quantity and custom PP points', async () => {
    await add(page, '4.0000'); assert.equal(await page.locator('#total-amount').textContent(), '73.20');
    await page.locator('[data-quantity]').fill('2'); await page.locator('[data-quantity]').press('Tab');
    assert.equal(await page.locator('#total-amount').textContent(), '146.40');
    await page.locator('[data-points]').fill('70'); await page.locator('[data-points]').press('Tab');
    assert.equal(await page.locator('#total-amount').textContent(), '140.00');
    await page.locator('#tax-point').fill('1.10'); assert.equal(await page.locator('#total-amount').textContent(), '154.00');
    await page.locator('[data-note]').fill('Zahn 11, Sitzung 1');
    await page.locator('#plan-title').fill('QA Zusammenstellung');
  });
  await check('immediate note edits, changes and clearing reach native CSV and real print DOM', async () => {
    await page.evaluate(() => { window.__originalPrint = window.print; window.print = () => {}; });
    const observations = [];
    let iteration = 0;
    for (const note of ['Zahn 21 Sitzung 2', 'Zahn 31 geändert', '']) {
      await page.locator('[data-note]').fill(note);
      const nextDownload = page.waitForEvent('download');
      await page.locator('#csv-export').click();
      const target = path.join(OUT, `immediate-note-${iteration++}.csv`);
      await (await nextDownload).saveAs(target);
      const row = (await readFile(target, 'utf8')).split('\r\n').find(text => text.startsWith('"4.0000";'));
      await page.locator('#print-plan').click();
      observations.push({ expected: note, csvLastCell: row?.split(';').at(-1),
        printedNotes: await page.locator('#printout tbody tr').first().locator('small').allTextContents() });
    }
    await page.evaluate(() => { window.print = window.__originalPrint; delete window.__originalPrint; });
    await page.locator('[data-note]').fill('Zahn 11, Sitzung 1');
    report.immediateNoteObservations = observations;
    for (const observation of observations) {
      assert.equal(observation.csvLastCell, `"${observation.expected}"`, JSON.stringify(observations));
      assert.deepEqual(observation.printedNotes, observation.expected ? [observation.expected] : [], JSON.stringify(observations));
    }
  });
  await check('fixed CHF material is labelled and does not scale with taxpoint value', async () => {
    const code = '4.8250.M';
    await add(page, code);
    const fixedLine = page.locator('.plan-line').filter({ has: page.locator(`[data-detail="${code}"]`) });
    assert.match(await fixedLine.textContent(), /CHF je Einheit · fix/);
    assert.equal(await fixedLine.locator('[data-points]').inputValue(), '127.00');
    assert.ok(await fixedLine.locator('[data-points]').getAttribute('readonly') !== null);
    await page.locator('#tax-point').fill('2.50');
    assert.match(await fixedLine.locator('.line-amount').textContent(), /127.00/);
    await page.locator('#tax-point').fill('1.10');
    await fixedLine.locator('[data-remove]').click();
  });
  await check('invalid rates and out-of-range PP points never produce a complete total', async () => {
    const before = await rawState(page);
    await page.locator('#tax-point').fill('oops');
    assert.ok(await page.locator('#rate-error').isVisible()); assert.ok(await page.locator('#csv-export').isDisabled());
    assert.equal(await rawState(page), before);
    await page.locator('#tax-point').fill('1.10');
    await page.locator('[data-points]').fill('999'); await page.locator('[data-points]').press('Tab');
    assert.match(await page.locator('#total-label').textContent(), /unvollständig/);
    await page.locator('[data-reset-points]').click();
  });
  await check('non-cumulation and package-member warnings are surfaced', async () => {
    await add(page, '4.0020');
    assert.match(await page.locator('#plan-warnings').textContent(), /nicht kumulierbar/);
    await page.locator('#social-mode').click();
    await add(page, '4.0000.LP');
    assert.match(await page.locator('#plan-warnings').textContent(), /Doppelverrechnung/);
  });
  await check('private-only disinfection is not priced as zero in social tariff', async () => {
    await query(page, '4.0300');
    assert.ok(await page.locator('#results [data-add="4.0300"]').isDisabled());
    await page.locator('#private-mode').click();
    assert.ok(await page.locator('#results [data-add="4.0300"]').isEnabled());
    await page.locator('#results [data-add="4.0300"]').click();
    await page.locator('#social-mode').click();
    assert.match(await page.locator('#total-label').textContent(), /unvollständig/);
    const line = page.locator('.plan-line').filter({ has: page.locator('[data-detail="4.0300"]') });
    assert.match(await line.textContent(), /Nicht als 0 CHF/);
    await page.locator('#private-mode').click();
    const packageLine = page.locator('.plan-line').filter({ has: page.locator('[data-detail="4.0000.LP"]') });
    await packageLine.locator('[data-remove]').click();
  });
  await check('native reload restores exact lines, mode, rate, notes and favorites', async () => {
    const before = await rawState(page); const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    await page.reload(); await page.waitForFunction(() => document.body.dataset.ready === 'true');
    assert.equal(await rawState(page), before); assert.ok(await page.evaluate(() => performance.timeOrigin) > timeOrigin);
    assert.equal(await page.locator('#tax-point').inputValue(), '1.10');
    assert.equal(await page.locator('#plan-title').inputValue(), 'QA Zusammenstellung');
    assert.ok((await page.locator('#plan-lines').textContent()).includes('4.0000'));
    assert.equal(await page.locator('[data-note]').first().inputValue(), 'Zahn 11, Sitzung 1');
  });
  let exportPath;
  await check('JSON and CSV are actual browser downloads with expected bytes', async () => {
    const jsonDownload = page.waitForEvent('download'); await page.locator('#json-export').click();
    const downloaded = await jsonDownload; exportPath = path.join(OUT, 'native-export.json'); await downloaded.saveAs(exportPath);
    const data = JSON.parse(await readFile(exportPath, 'utf8'));
    assert.equal(data.plan.title, 'QA Zusammenstellung'); assert.equal(data.kind, 'dentotar-plan');
    const csvDownload = page.waitForEvent('download'); await page.locator('#csv-export').click();
    const csv = await csvDownload; const csvPath = path.join(OUT, 'native-export.csv'); await csv.saveAs(csvPath);
    assert.match(await readFile(csvPath, 'utf8'), /Gesamtsumme CHF/);
  });
  await check('save and reopen a named plan through native dialog confirmation', async () => {
    await page.locator('#save-plan').click(); await page.locator('#saved-button').click();
    assert.equal(await page.locator('.saved-item').count(), 1);
    await answerDialog(page, true, () => page.locator('[data-load-saved]').click());
    assert.ok(!(await page.locator('#saved-dialog').isVisible()));
  });
  await check('real file-picker import restores exported data; invalid import preserves state', async () => {
    const importCtx = await context(); const imported = await importCtx.newPage(); await ready(imported);
    await imported.locator('#import-file').setInputFiles(exportPath);
    await waitText(imported, '#plan-count', '3');
    assert.equal(await imported.locator('#plan-title').inputValue(), 'QA Zusammenstellung');
    const before = await rawState(imported);
    const malformed = path.join(OUT, 'malformed.json'); await writeFile(malformed, '{"kind":"dentotar-plan","schemaVersion":999}');
    await imported.locator('#import-file').setInputFiles(malformed);
    await waitText(imported, '#toast', 'Import abgelehnt'); assert.equal(await rawState(imported), before);
    // Real confirm cancellation followed by deliberate acceptance, not patched product callbacks.
    await answerDialog(imported, false, () => imported.locator('#import-file').setInputFiles(exportPath));
    await imported.waitForFunction(() => document.querySelector('#import-file').value === '');
    assert.equal(await rawState(imported), before);
    await answerDialog(imported, true, () => imported.locator('#import-file').setInputFiles(exportPath));
    await imported.waitForFunction(() => document.querySelector('#import-file').value === '');
    await waitText(imported, '#toast', 'importiert');
    await importCtx.close();
  });
  await check('desktop, tablet and narrow/mobile layouts do not overflow', async () => {
    await query(page, '');
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width < 800 ? 844 : 1000 });
      if (width <= 820) await page.locator('#catalog-tab').click();
      await noOverflow(page);
      await screenshot(page, `catalog-${width}`);
      if (width <= 820) {
        await page.locator('#plan-tab').click(); await noOverflow(page);
        assert.ok(await page.locator('#tax-point').isVisible());
        await page.locator('#csv-export').scrollIntoViewIfNeeded();
        await screenshot(page, `plan-${width}`);
        await page.locator('#catalog-tab').click();
      }
    }
  });
  await check('mobile modal stays inside viewport and preserves original notes', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await query(page, '4.0000');
    await page.locator('#results [data-detail="4.0000"]').click();
    const rect = await page.locator('#detail-dialog').boundingBox();
    assert.ok(rect.x >= 0 && rect.width <= 390); await noOverflow(page); await screenshot(page, 'details-390');
    await page.locator('#detail-dialog [data-close]').click();
  });
  await check('corrupt local storage is not overwritten by a user action', async () => {
    const corrupt = await context();
    await corrupt.addInitScript(() => localStorage.setItem('dentotar.workspace.v1', '{broken raw state'));
    const p = await corrupt.newPage(); await ready(p);
    assert.ok(await p.locator('#storage-warning').isVisible());
    await add(p, '4.0000'); assert.equal(await rawState(p), '{broken raw state');
    const native = p.waitForEvent('download'); await p.locator('#raw-backup').click();
    const backup = await native; const target = path.join(OUT, 'corrupt-before-image.txt'); await backup.saveAs(target);
    assert.equal(await readFile(target, 'utf8'), '{broken raw state'); await corrupt.close();
  });
  await check('storage write failure retains in-memory calculation and offers truthful export', async () => {
    const blocked = await context();
    await blocked.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'dentotar.workspace.v1') throw new DOMException('synthetic quota failure', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    const p = await blocked.newPage(); await ready(p); await add(p, '4.0000');
    assert.ok(await p.locator('#storage-warning').isVisible());
    assert.equal(await p.locator('#total-amount').textContent(), '73.20'); assert.equal(await rawState(p), null);
    const native = p.waitForEvent('download'); await p.locator('#json-export').click();
    await (await native).saveAs(path.join(OUT, 'quota-failure-export.json')); await blocked.close();
  });
  await check('another tab pauses automatic writes instead of losing concurrent changes', async () => {
    const concurrent = await context(); const one = await concurrent.newPage(); await ready(one);
    const two = await concurrent.newPage(); await ready(two);
    await add(two, '4.0000'); await one.locator('#storage-warning').waitFor({ state: 'visible' });
    const before = await rawState(one); await add(one, '4.0020'); assert.equal(await rawState(one), before);
    await concurrent.close();
  });
  await check('obsolete plan reads cannot overwrite a newer native import or its persisted reload', async () => {
    const isolated = await context();
    try {
      report.importRaceObservations = [];
      await checkImportRaces(await isolated.newPage(), origin, report.importRaceObservations);
    } finally { await isolated.close(); }
  });
  await check('print stylesheet isolates a complete source-labelled print view', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    // Intercept only the platform print dialog. The real click builds the real print DOM.
    await page.evaluate(() => { window.print = () => { window.__printCalled = true; }; });
    await page.locator('#print-plan').click(); assert.ok(await page.evaluate(() => window.__printCalled));
    await page.emulateMedia({ media: 'print' });
    assert.ok(await page.locator('#printout').isVisible()); assert.ok(!(await page.locator('.workspace').isVisible()));
    assert.equal(await page.locator('#printout tbody tr').count(), 3);
    await screenshot(page, 'print-view'); await page.emulateMedia({ media: 'screen' });
  });
  assert.deepEqual(report.errors, []); assert.deepEqual(report.networkErrors, []);
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.failure = error.stack; process.exitCode = 1; }
finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length,
    passed: report.cases.filter(c => c.status === 'pass').length, output: OUT, failure: report.failure }, null, 2));
}
