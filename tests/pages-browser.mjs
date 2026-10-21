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
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
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
  await check('Pages subpath loads a usable local-file start without requesting tariff files', async () => {
    await page.goto(origin);
    await page.waitForFunction(() => ['waiting', 'error', 'true'].includes(document.body.dataset.ready));
    assert.equal(await page.getAttribute('body', 'data-ready'), 'waiting');
    assert.ok(await page.locator('#catalog-open').isVisible());
    assert.equal(await page.locator('#workspace').isVisible(), false);
    assert.equal(await rawState(), null);
    assert.ok(!requests.some(request => request.url.includes('/data/')));
    await page.locator('#sources-button').click();
    assert.ok(await page.locator('#sources-dialog').isVisible());
    await page.locator('#sources-dialog [data-close]').click();
    await capture('pages-start-desktop');
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await capture(`pages-start-${width}`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await check('malformed and plan-only files are rejected without changing workspace; native picker retries', async () => {
    const bad = path.join(OUT, 'invalid.json'); await writeFile(bad, '{not-json');
    await page.locator('#catalog-file').setInputFiles(bad);
    await page.locator('#catalog-error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#catalog-error').textContent(), /JSON/);
    assert.equal(await rawState(), null);
    const plan = path.join(OUT, 'plan-not-catalog.json'); await writeFile(plan, '{"kind":"dentotar-plan","schemaVersion":1}');
    await page.locator('#catalog-file').setInputFiles(plan);
    await page.waitForFunction(() => document.querySelector('#catalog-error').textContent.includes('Katalogformat'));
    assert.equal(await rawState(), null);
    const badChecksum = structuredClone(catalog);
    badChecksum.sources[0].sha256 = { toString: null, valueOf: null };
    const checksumFile = path.join(OUT, 'bad-checksum.json'); await writeFile(checksumFile, JSON.stringify(badChecksum));
    await page.locator('#catalog-file').setInputFiles(checksumFile);
    await page.waitForFunction(() => !document.querySelector('#catalog-open').disabled && !document.querySelector('#catalog-error').hidden);
    assert.match(await page.locator('#catalog-error').textContent(), /Katalogformat/);
    assert.equal(await page.getAttribute('body', 'data-ready'), 'waiting');
    assert.equal(await rawState(), null);
    // Headless Camoufox suppresses filechooser events even for direct trusted input clicks.
    // Observe the real opener wiring, then select through the actual native file input.
    await page.locator('#catalog-file').evaluate(el => el.addEventListener('click', () => { el.dataset.pickerRequested = 'true'; }, { once: true }));
    await page.locator('#catalog-open').click();
    assert.equal(await page.locator('#catalog-file').getAttribute('data-picker-requested'), 'true');
    await page.locator('#catalog-file').setInputFiles(catalogPath);
    await page.waitForFunction(() => document.body.dataset.ready === 'true');
    assert.equal(await page.locator('.tariff-row').count(), Math.min(50, catalog.positions.length));
    assert.match(await page.locator('#catalog-total').textContent(), new RegExp(String(catalog.positions.length)));
  });
  await check('imported real catalog supports search, calculation, original notes and official PDF links', async () => {
    await page.locator('#search').fill('4.0000');
    await page.locator('[data-add="4.0000"]').click();
    assert.equal(await page.locator('#total-amount').textContent(), '73.20');
    await page.locator('[data-note]').fill('Pages Testnotiz');
    await page.locator('#results [data-detail="4.0000"]').click();
    assert.match(await page.locator('.original-notes').first().textContent(), /12 Monaten/);
    const links = await page.locator('#detail-content .detail-links a').evaluateAll(nodes => nodes.map(node => node.href));
    assert.ok(links.every(link => link.startsWith('https://')));
    assert.ok(links.some(link => link.includes('#page=')));
    await page.locator('#detail-dialog [data-close]').click();
    await page.locator('#sources-button').click();
    assert.ok(!(await page.locator('#source-content a').evaluateAll(nodes => nodes.map(node => node.href))).some(link => link.includes('/dentotar/data/')));
    await page.locator('#sources-dialog [data-close]').click();
    await page.locator('#toast').waitFor({ state: 'hidden' });
    await page.locator('#search').fill('');
    await capture('pages-loaded-desktop');
  });
  await check('Pages produces real JSON/CSV downloads and reload preserves plan before catalog reselection', async () => {
    for (const [button, name] of [['#json-export', 'plan.json'], ['#csv-export', 'plan.csv']]) {
      const next = page.waitForEvent('download'); await page.locator(button).click();
      const file = path.join(OUT, name); await (await next).saveAs(file);
      assert.match(await readFile(file, 'utf8'), /Pages Testnotiz/);
    }
    const before = await rawState();
    await page.reload(); await page.waitForFunction(() => document.body.dataset.ready === 'waiting');
    assert.equal(await rawState(), before);
    await page.locator('#catalog-file').setInputFiles(catalogPath);
    await page.waitForFunction(() => document.body.dataset.ready === 'true');
    assert.equal(await rawState(), before);
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
  await check('catalog selection never uploads data, creates external requests, or requests missing local PDFs', async () => {
    assert.ok(requests.every(request => ['GET', 'HEAD'].includes(request.method) && request.bytes === 0));
    assert.ok(requests.every(request => request.url.startsWith(origin)));
    assert.ok(!requests.some(request => request.url.includes('/data/')));
    assert.deepEqual(errors, []);
  });
  console.log(JSON.stringify({ status: 'pass', cases: cases.length, output: OUT, origin }, null, 2));
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
}
