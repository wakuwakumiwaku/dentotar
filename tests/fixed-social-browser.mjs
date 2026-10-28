import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {join, resolve} from 'node:path';
import {createAppServer} from '../scripts/serve.mjs';

export async function checkFixedSocial({browser, origin, catalog, output}) {
  // Only the public code/amount is looked up. All personal plan contents are synthetic.
  const position = catalog.positions.find(row => row.code === '4.8230.M');
  assert.ok(position && position.amountsCHF.social !== null);
  const expected = new Intl.NumberFormat('de-CH', {minimumFractionDigits: 2, maximumFractionDigits: 2})
    .format(Math.round(position.amountsCHF.social * 100) * 3 / 100);
  const receipts = [];
  for (const width of [1440, 390]) {
    const context = await browser.newContext({viewport: {width, height: 1000}, acceptDownloads: true});
    try {
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
      page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
      await page.goto(origin); await page.waitForFunction(() => document.body.dataset.ready === 'true');
      const plan = {kind: 'dentotar-plan', schemaVersion: 1, catalogVersion: catalog.version,
        mode: 'social', privateLevel: 'reference', taxPointValue: '7.5',
        plan: {title: 'Synthetic social fixed-CHF plan', lines: [{id: 'synthetic-fixed', code: position.code,
          quantity: 3, points: '10.00', note: 'Synthetic retained private TP override'}]}};
      await page.locator('#import-file').setInputFiles({name: 'synthetic-social.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(plan))});
      await page.waitForFunction(() => document.querySelectorAll('.plan-line').length === 1);
      if (width < 600) await page.locator('#plan-tab').click();
      assert.equal(await page.locator('#total-label').textContent(), 'Gesamtsumme', 'native social fixed calculation must ignore a retained private override');
      assert.equal(await page.locator('#total-amount').textContent(), expected);
      assert.equal(await page.locator('#csv-export').isEnabled(), true);
      assert.equal(await page.locator('[data-points]').getAttribute('readonly'), '');
      assert.equal(await page.locator('.line-error').count(), 0);
      const raw = await page.evaluate(() => localStorage.getItem('dentotar.workspace.v1'));
      assert.deepEqual(JSON.parse(raw).plan, plan.plan);
      const getDownload = async (selector, name) => {
        const pending = page.waitForEvent('download'); await page.locator(selector).click();
        const target = join(output, `${width}-${name}`); await (await pending).saveAs(target);
        return readFile(target, 'utf8');
      };
      const csv = await getDownload('#csv-export', 'social-fixed.csv');
      assert.ok(csv.includes(expected)); assert.ok(csv.includes('Synthetic retained private TP override'));
      const json = JSON.parse(await getDownload('#json-export', 'social-fixed.json'));
      assert.deepEqual(json.plan, plan.plan); assert.equal(json.mode, 'social');
      await page.evaluate(() => { window.print = () => { window.__fixedPrint = true; }; });
      await page.locator('#print-plan').click();
      assert.ok(await page.evaluate(() => window.__fixedPrint));
      assert.ok((await page.locator('#printout').textContent()).includes(expected));
      assert.ok(!(await page.locator('#printout').textContent()).includes('UNVOLLSTÄNDIG'));
      await page.locator('#private-mode').click();
      assert.match(await page.locator('#total-label').textContent(), /unvollständig/);
      assert.match(await page.locator('.line-error').textContent(), /CHF-Fixbeträge/);
      assert.equal(await page.locator('#csv-export').isDisabled(), true);
      assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('dentotar.workspace.v1'))).plan.lines[0].points, '10.00');
      await page.locator('#social-mode').click();
      assert.equal(await page.locator('#total-amount').textContent(), expected);
      assert.equal(await page.locator('#csv-export').isEnabled(), true);
      const durable = await page.evaluate(() => localStorage.getItem('dentotar.workspace.v1'));
      await page.reload(); await page.waitForFunction(() => document.body.dataset.ready === 'true');
      assert.equal(await page.evaluate(() => localStorage.getItem('dentotar.workspace.v1')), durable);
      assert.equal(await page.locator('#total-label').textContent(), 'Gesamtsumme');
      assert.equal(await page.locator('#total-amount').textContent(), expected);
      assert.deepEqual(errors, []);
      receipts.push({width, code: position.code, expectedCHF: expected, override: JSON.parse(durable).plan.lines[0].points, errors});
    } finally { await context.close(); }
  }
  await writeFile(join(output, 'fixed-social-native.json'), JSON.stringify(receipts, null, 2));
  return receipts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const output = process.env.DENTOTAR_QA_OUTPUT || join(root, '.local', 'fixed-social');
  await mkdir(output, {recursive: true});
  const {firefox} = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
  const catalog = JSON.parse(await readFile(join(root, 'public/data/catalog.json'), 'utf8'));
  const server = createAppServer({root}); await new Promise(r => server.listen(0, '127.0.0.1', r));
  let browser;
  try {
    browser = await firefox.launch({executablePath: process.env.BROWSER_EXECUTABLE, headless: true});
    console.log(JSON.stringify(await checkFixedSocial({browser, origin: `http://127.0.0.1:${server.address().port}`, catalog, output})));
  } finally { if (browser) await browser.close(); await new Promise(r => server.close(r)); }
}
