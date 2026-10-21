import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { PAGE_FILES } from '../scripts/build-pages.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = path.join(ROOT, '.local/qa-pages', new Date().toISOString().replaceAll(':', '-'));
await mkdir(OUT, { recursive: true });
const playwright = process.env.PLAYWRIGHT_MODULE ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href) : await import('playwright-core');
const catalogPath = path.join(ROOT, 'public/data/catalog.json');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const allowed = new Set(PAGE_FILES.map(([, target]) => target));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.pdf': 'application/pdf' };
const requests = [], errors = [], cases = [];
let browser, server;
let origin = process.env.PAGE_ORIGIN;
if (!origin) {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = url.pathname === '/dentotar/' ? 'index.html' : url.pathname.startsWith('/dentotar/') ? url.pathname.slice(10) : '';
    if (!allowed.has(file) || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end(); return; }
    try {
      const content = await readFile(path.join(ROOT, 'dist-pages', file));
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}/dentotar/`;
}
const report = { origin, cases, requests, errors, screenshots: [] };
try {
  browser = await playwright.firefox.launch({ executablePath: process.env.CAMOUFOX_EXECUTABLE || path.join(os.homedir(), '.cache/camoufox/camoufox'), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => requests.push({ url: request.url(), method: request.method(), bytes: request.postDataBuffer()?.length || 0 }));
  page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`); });
  const check = async (name, action) => {
    try { await action(); cases.push({ name, status: 'pass' }); console.log(`PASS ${name}`); }
    catch (error) { cases.push({ name, status: 'fail', error: error.stack }); throw error; }
  };
  const capture = async name => { const file = path.join(OUT, name + '.png'); await page.screenshot({ path: file }); report.screenshots.push(file); };
  const rawState = () => page.evaluate(() => localStorage.getItem('dentotar.workspace.v1'));
  await check('Pages automatically loads the complete hosted catalog without file selection', async () => {
    await page.goto(origin);
    await page.waitForFunction(() => ['waiting', 'error', 'true'].includes(document.body.dataset.ready));
    assert.equal(await page.getAttribute('body', 'data-ready'), 'true');
    assert.equal(await page.locator('#catalog-start').isVisible(), false);
    assert.equal(await page.locator('#workspace').isVisible(), true);
    assert.equal(await page.locator('.tariff-row').count(), Math.min(50, catalog.positions.length));
    assert.equal(await page.locator('#catalog-total').textContent(), `${catalog.positions.length} Positionen`);
    assert.equal(await rawState(), null);
    assert.ok(requests.some(request => request.url === origin + 'data/catalog.json'));
    await capture('pages-auto-desktop');
  });
  await check('automatic catalog supports search, calculation, original notes and the hosted original PDFs', async () => {
    await page.locator('#search').fill('4.0000');
    await page.locator('[data-add="4.0000"]').click();
    assert.equal(await page.locator('#total-amount').textContent(), '73.20');
    await page.locator('[data-note]').fill('Pages Testnotiz');
    await page.locator('#results [data-detail="4.0000"]').click();
    assert.match(await page.locator('.original-notes').first().textContent(), /12 Monaten/);
    const pdf = await page.locator('#detail-content .detail-links a').first().getAttribute('href');
    assert.ok(new URL(pdf, origin).href.startsWith(origin + 'data/source-tariff.pdf#page='));
    await page.locator('#detail-dialog [data-close]').click();
    await page.locator('#sources-button').click();
    assert.ok((await page.locator('#source-content a').evaluateAll(nodes => nodes.map(node => node.href))).includes(origin + 'data/source-shorttext.pdf'));
    await page.locator('#sources-dialog [data-close]').click();
    for (const file of ['source-tariff.pdf', 'source-shorttext.pdf']) {
      const response = await context.request.get(origin + 'data/' + file);
      assert.equal(response.status(), 200);
      assert.match(response.headers()['content-type'], /application\/pdf/);
      assert.deepEqual(await response.body(), await readFile(path.join(ROOT, 'public/data', file)));
    }
    await page.locator('#toast').waitFor({ state: 'hidden' });
    await page.locator('#search').fill('');
    await capture('pages-loaded-desktop');
  });
  await check('Pages produces real downloads and reloads catalog plus exact saved plan without reselection', async () => {
    for (const [button, name] of [['#json-export', 'plan.json'], ['#csv-export', 'plan.csv']]) {
      const next = page.waitForEvent('download'); await page.locator(button).click();
      const file = path.join(OUT, name); await (await next).saveAs(file);
      assert.match(await readFile(file, 'utf8'), /Pages Testnotiz/);
    }
    const before = await rawState();
    await page.reload(); await page.waitForFunction(() => document.body.dataset.ready === 'true');
    assert.equal(await rawState(), before);
    assert.equal(await page.locator('#catalog-start').isVisible(), false);
    assert.equal(await page.locator('[data-note]').inputValue(), 'Pages Testnotiz');
    assert.equal(await page.locator('#total-amount').textContent(), '73.20');
  });
  await check('larger typography and high-contrast Pages layouts remain readable down to 320px', async () => {
    assert.equal(await page.locator('.row-title').first().evaluate(el => getComputedStyle(el).fontSize), '17px');
    for (const width of [1440, 1024, 900, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      if (width <= 900) await page.locator('#catalog-tab').click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      if (width === 390) await capture('pages-catalog-390');
      if (width <= 900) {
        await page.locator('#plan-tab').click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        if (width === 390) {
          await page.locator('#csv-export').scrollIntoViewIfNeeded(); await capture('pages-plan-390-bottom');
        }
      }
    }
  });
  await check('failed hosted request offers safe fallback, rejects malformed files and recovers automatic loading', async () => {
    const before = await rawState();
    const fallbackContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await fallbackContext.addInitScript(raw => {
      if (localStorage.getItem('dentotar.workspace.v1') === null) localStorage.setItem('dentotar.workspace.v1', raw);
    }, before);
    const fallback = await fallbackContext.newPage();
    fallback.on('pageerror', error => errors.push(error.message));
    report.expectedFailures = [];
    fallback.on('response', response => {
      if (response.status() === 404 && response.url() === origin + 'data/catalog.json') report.expectedFailures.push({ url: response.url(), status: 404 });
      else if (response.status() >= 400) errors.push(`Unexpected fallback HTTP ${response.status()} ${response.url()}`);
    });
    await fallback.route('**/data/catalog.json', route => route.fulfill({ status: 404, body: 'Deliberate missing-catalog test' }));
    await fallback.goto(origin);
    await fallback.waitForFunction(() => document.body.dataset.ready === 'waiting');
    assert.ok(await fallback.locator('#catalog-open').isVisible());
    assert.equal(await fallback.evaluate(() => localStorage.getItem('dentotar.workspace.v1')), before);
    const badChecksum = structuredClone(catalog); badChecksum.sources[0].sha256 = { toString: null, valueOf: null };
    for (const [name, content, message] of [['broken.json', '{not-json', /JSON/],
      ['plan-only.json', '{"kind":"dentotar-plan","schemaVersion":1}', /Katalogformat/],
      ['bad-checksum.json', JSON.stringify(badChecksum), /Katalogformat/]]) {
      const file = path.join(OUT, name); await writeFile(file, content);
      await fallback.locator('#catalog-file').setInputFiles(file);
      await fallback.waitForFunction(() => !document.querySelector('#catalog-open').disabled && !document.querySelector('#catalog-error').hidden);
      assert.match(await fallback.locator('#catalog-error').textContent(), message);
      assert.equal(await fallback.evaluate(() => localStorage.getItem('dentotar.workspace.v1')), before);
      assert.equal(await fallback.getAttribute('body', 'data-ready'), 'waiting');
    }
    // Observe actual opener wiring; headless Camoufox does not emit filechooser events.
    await fallback.locator('#catalog-file').evaluate(el => el.addEventListener('click', () => { el.dataset.pickerRequested = 'true'; }, { once: true }));
    await fallback.locator('#catalog-open').click();
    assert.equal(await fallback.locator('#catalog-file').getAttribute('data-picker-requested'), 'true');
    await fallback.locator('#catalog-file').setInputFiles(catalogPath);
    await fallback.waitForFunction(() => document.body.dataset.ready === 'true');
    assert.equal(await fallback.locator('[data-note]').inputValue(), 'Pages Testnotiz');
    assert.equal(await fallback.evaluate(() => localStorage.getItem('dentotar.workspace.v1')), before);
    await fallback.unroute('**/data/catalog.json');
    await fallback.reload(); await fallback.waitForFunction(() => document.body.dataset.ready === 'true');
    assert.equal(await fallback.locator('#catalog-start').isVisible(), false);
    assert.equal(await fallback.locator('#total-amount').textContent(), '73.20');
    assert.equal(await fallback.evaluate(() => localStorage.getItem('dentotar.workspace.v1')), before);
    assert.equal(report.expectedFailures.length, 1);
    await fallbackContext.close();
  });
  await check('public tariff reads never upload personal input or make external application requests', async () => {
    assert.ok(requests.every(request => ['GET', 'HEAD'].includes(request.method) && request.bytes === 0));
    assert.ok(requests.every(request => request.url.startsWith(origin)));
    assert.ok(requests.some(request => request.url === origin + 'data/catalog.json'));
    assert.deepEqual(errors, []);
  });
  console.log(JSON.stringify({ status: 'pass', cases: cases.length, output: OUT, origin }, null, 2));
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
}
