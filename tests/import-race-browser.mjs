import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createAppServer } from '../scripts/serve.mjs';

const KEY = 'dentotar.workspace.v1';
// The only browser instrumentation delays native File.text settlement. Product
// handlers, JSON validation, confirmation, rendering and localStorage stay real.
export async function checkImportRaces(page, origin, observations = []) {
  await page.goto(origin);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  const version = await page.locator('#catalog-version').textContent();
  const payload = title => JSON.stringify({ kind: 'dentotar-plan', schemaVersion: 1,
    catalogVersion: version.replace('Katalogstand ', ''), mode: 'private', privateLevel: 'reference',
    taxPointValue: '1.00', plan: { title, lines: [{ id: 'synthetic-line', code: '4.0000', quantity: 1, points: null, note: 'Synthetic import race' }] } });
  const select = (name, text) => page.locator('#import-file').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
  const raw = () => page.evaluate(key => localStorage.getItem(key), KEY);
  await page.evaluate(() => {
    window.__originalFileText = File.prototype.text;
    File.prototype.text = async function() {
      if (this.name !== 'slow.json') return window.__originalFileText.call(this);
      const text = await window.__originalFileText.call(this);
      return new Promise((resolve, reject) => { window.__heldImport = { resolve: () => resolve(text), reject: () => reject(new Error('synthetic stale read failure')) }; });
    };
  });
  const release = async reject => {
    await page.evaluate(reject => { window.__heldImport[reject ? 'reject' : 'resolve'](); delete window.__heldImport; }, reject);
    // Flush the read/parse/handler microtasks before observing state.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  };
  const dialogs = [];
  let acceptReplacement = true;
  const confirm = async dialog => { dialogs.push(dialog.message()); await (acceptReplacement ? dialog.accept() : dialog.dismiss()); };
  page.on('dialog', confirm);
  try {
    for (const stale of ['valid', 'malformed', 'rejected']) {
      await select('slow.json', stale === 'malformed' ? '{broken' : payload('Stale plan'));
      await page.waitForFunction(() => Boolean(window.__heldImport));
      await select('latest.json', payload(`Newest ${stale}`));
      await page.waitForFunction(title => document.querySelector('#plan-title').value === title, `Newest ${stale}`);
      const before = await raw(), toast = await page.locator('#toast').textContent(), confirmations = dialogs.length;
      await release(stale === 'rejected');
      const observation = { stale, before, after: await raw(), title: await page.locator('#plan-title').inputValue(),
        toastBefore: toast, toastAfter: await page.locator('#toast').textContent(), extraConfirmations: dialogs.length - confirmations };
      observations.push(observation);
      assert.equal(observation.title, `Newest ${stale}`, 'late file read must not overwrite the newer native import');
      assert.equal(observation.after, before, 'persisted plan must remain byte-identical');
      assert.equal(observation.toastAfter, toast, 'stale failures must not replace the latest import message');
      assert.equal(observation.extraConfirmations, 0, 'obsolete imports must not prompt to replace the newer plan');
    }
    for (const latest of ['invalid', 'cancelled']) {
      const before = await raw(), title = await page.locator('#plan-title').inputValue();
      await select('slow.json', payload('Stale plan'));
      await page.waitForFunction(() => Boolean(window.__heldImport));
      acceptReplacement = latest !== 'cancelled';
      await select('latest.json', latest === 'invalid' ? '{broken' : payload('Cancelled plan'));
      await page.waitForFunction(() => document.querySelector('#import-file').value === '');
      const confirmations = dialogs.length;
      await release(false);
      acceptReplacement = true;
      assert.equal(await page.locator('#plan-title').inputValue(), title);
      assert.equal(await raw(), before, 'a rejected or cancelled latest import must not resurrect an older read');
      assert.equal(dialogs.length, confirmations);
      observations.push({ stale: `latest-${latest}`, persisted: before, passed: true });
    }
    // Older settlement must not clear a newer file selection before its read completes.
    await select('slow.json', payload('Obsolete pending plan'));
    await page.waitForFunction(() => Boolean(window.__heldImport));
    await page.evaluate(() => {
      window.__firstHeldImport = window.__heldImport;
      File.prototype.text = function() { return new Promise(resolve => { window.__latestImport = () => resolve(window.__latestText); }); };
    });
    await page.evaluate(text => { window.__latestText = text; }, payload('Final persisted plan'));
    await select('pending.json', payload('Final persisted plan'));
    await page.waitForFunction(() => Boolean(window.__latestImport));
    const before = await raw();
    await page.evaluate(() => window.__firstHeldImport.resolve());
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    assert.match(await page.locator('#import-file').inputValue(), /pending\.json$/);
    assert.equal(await raw(), before);
    await page.evaluate(() => window.__latestImport());
    await page.waitForFunction(() => document.querySelector('#plan-title').value === 'Final persisted plan');
    assert.equal(await page.locator('#import-file').inputValue(), '');
    const final = await raw();
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === 'true');
    assert.equal(await page.locator('#plan-title').inputValue(), 'Final persisted plan');
    assert.equal(await raw(), final);
    assert.equal(await page.locator('[data-note]').inputValue(), 'Synthetic import race');
    observations.push({ stale: 'pending-input-and-reload', persisted: final, passed: true });
  } finally {
    page.off('dialog', confirm);
    await page.evaluate(() => { if (window.__originalFileText) File.prototype.text = window.__originalFileText; });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const out = path.join(root, '.local', 'qa', `import-race-${new Date().toISOString().replaceAll(':', '-')}`);
  await mkdir(out, { recursive: true });
  const playwright = process.env.PLAYWRIGHT_MODULE ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href) : await import('playwright-core');
  const server = createAppServer({ root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const report = { status: 'pending', observations: [], errors: [], consoleErrors: [], requestFailures: [], httpErrors: [] };
  let browser;
  try {
    browser = await playwright.firefox.launch({ headless: true,
      executablePath: process.env.CAMOUFOX_EXECUTABLE || path.join(os.homedir(), '.cache/camoufox/camoufox') });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', msg => { if (msg.type() === 'error') report.consoleErrors.push(msg.text()); });
    page.on('requestfailed', req => report.requestFailures.push({ url: req.url(), error: req.failure() }));
    page.on('response', res => { if (res.status() >= 400) report.httpErrors.push({ url: res.url(), status: res.status() }); });
    await checkImportRaces(page, `http://127.0.0.1:${server.address().port}`, report.observations);
    for (const key of ['errors', 'consoleErrors', 'requestFailures', 'httpErrors']) assert.deepEqual(report[key], [], key);
    report.status = 'pass';
  } catch (error) { report.status = 'fail'; report.failure = error.stack; process.exitCode = 1; }
  finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    report.serverClosed = !server.listening; report.browserClosed = !browser?.isConnected();
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, output: out }, null, 2));
  }
}
