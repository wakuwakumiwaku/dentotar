import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseCatalog, validateCatalog, safeSourceURL, MAX_CATALOG_BYTES } from '../src/catalog.js';
import { buildPages, PAGE_FILES } from '../scripts/build-pages.mjs';

// Deliberately fictional fixture, not source tariff data.
const fixture = () => ({ schemaVersion: 1, version: 'test',
  sources: [{ id: 'tariff-pdf', title: 'Test source', url: 'https://example.org/test.pdf' }],
  chapters: [{ id: 'T', title: 'Test chapter', notes: '' }], sections: [{ id: 'T.1', title: 'Test section', notes: '' }],
  positions: [{ code: 'TEST.1', title: 'Fictional test item', shortTitle: null, kind: 'service', chapter: 'T', section: 'T.1',
    socialPoints: 10, privateMin: 8, privateMax: 12, amountsCHF: { social: null, private: null },
    notes: '', excludes: [], members: [], packages: [], sourcePage: 1 }], notices: [] });

test('catalog parser preserves source bytes semantically and never normalizes identifiers', () => {
  const data = fixture();
  assert.deepEqual(parseCatalog(JSON.stringify(data)), data);
  assert.equal(validateCatalog(data), data);
  data.positions[0].code = ' TEST.1';
  assert.throws(() => validateCatalog(data), /Katalogformat/);
});

test('catalog rejects plans, broken JSON, duplicate codes, malformed arrays and versions', () => {
  for (const data of [null, [], { kind: 'dentotar-plan', schemaVersion: 1 }, { ...fixture(), schemaVersion: 99 },
    { ...fixture(), positions: [] }, { ...fixture(), chapters: null }]) assert.throws(() => validateCatalog(data));
  assert.throws(() => parseCatalog('{broken'), /JSON/);
  const duplicate = fixture(); duplicate.positions.push(structuredClone(duplicate.positions[0]));
  assert.throws(() => validateCatalog(duplicate));
  const references = fixture(); references.positions[0].members = 'TEST.1';
  assert.throws(() => validateCatalog(references));
});

test('catalog rejects invalid, missing, reversed or over-precise amounts and unknown hierarchy', () => {
  for (const value of [undefined, '10', -1, Infinity, NaN, 1.001, 1000001]) {
    const data = fixture(); data.positions[0].socialPoints = value;
    assert.throws(() => validateCatalog(data));
  }
  const bounds = fixture(); bounds.positions[0].privateMin = 20;
  assert.throws(() => validateCatalog(bounds));
  const hierarchy = fixture(); hierarchy.positions[0].chapter = 'unknown';
  assert.throws(() => validateCatalog(hierarchy));
  const amount = fixture(); amount.positions[0].amountsCHF.private = '127 CHF';
  assert.throws(() => validateCatalog(amount));
});

test('catalog validates every nested object and source URL before activation', () => {
  for (const change of [data => data.positions.push(null), data => data.chapters.push(null),
    data => data.sections.push({ ...data.sections[0] }), data => data.sources.push(null),
    data => { data.sources[0].url = 'javascript:alert(1)'; }, data => { data.notices = [null]; },
    data => { data.positions[0].sourcePage = '../secret'; }, data => { data.positions[0].amountsCHF = []; }]) {
    const data = fixture(); change(data); assert.throws(() => validateCatalog(data));
  }
  assert.equal(safeSourceURL('javascript:alert(1)'), '#');
  assert.equal(safeSourceURL('https://user:password@example.org/'), '#');
  assert.equal(safeSourceURL('https://example.org/test.pdf'), 'https://example.org/test.pdf');
  assert.throws(() => parseCatalog(' '.repeat(MAX_CATALOG_BYTES + 1)), /20 MB/);
});

test('source checksums reject malformed values before activation and preserve valid literal hashes', () => {
  for (const checksum of [{ toString: null, valueOf: null }, {}, [], 123, true, '', 'a'.repeat(63), 'g'.repeat(64)]) {
    const data = fixture(); data.sources[0].sha256 = checksum;
    assert.throws(() => parseCatalog(JSON.stringify(data)), /Katalogformat/);
  }
  for (const checksum of [undefined, null, 'a'.repeat(64), 'ABCDEF01'.repeat(8)]) {
    const data = fixture(); data.sources[0].sha256 = checksum;
    assert.equal(parseCatalog(JSON.stringify(data)).sources[0].sha256, checksum);
  }
});

test('Pages build rejects unusable catalogs without replacing the previous build', async t => {
  for (const [name, raw] of [
    ['broken JSON', '{broken'],
    ['empty positions', JSON.stringify({ ...fixture(), positions: [] })],
    ['invalid tariff values', JSON.stringify({ ...fixture(), positions: [{ ...fixture().positions[0], privateMin: 20 }] })],
  ]) {
    await t.test(name, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'dentotar-invalid-pages-'));
      try {
        for (const [source] of PAGE_FILES) {
          await mkdir(path.dirname(path.join(root, source)), { recursive: true });
          await writeFile(path.join(root, source), source === 'index.html' ? '<html><head></head><body>Test</body></html>' : `fixture ${source}`);
        }
        const catalogPath = path.join(root, 'public/data/catalog.json');
        await writeFile(catalogPath, JSON.stringify(fixture()));
        const output = await buildPages(root);
        const before = await Promise.all(PAGE_FILES.map(([, target]) => readFile(path.join(output, target))));
        await writeFile(catalogPath, raw);
        await assert.rejects(() => buildPages(root), /JSON|Katalogformat/);
        for (const [i, [, target]] of PAGE_FILES.entries()) {
          assert.deepEqual(await readFile(path.join(output, target)), before[i], target);
        }
        assert.equal(await readFile(path.join(output, '.nojekyll'), 'utf8'), '');
        assert.equal(await readFile(catalogPath, 'utf8'), raw);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
});

test('Pages build includes the authorized catalog and PDFs but excludes unrelated private files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dentotar-pages-'));
  const dataFiles = ['data/catalog.json', 'data/source-tariff.pdf', 'data/source-shorttext.pdf'];
  try {
    for (const [source] of PAGE_FILES) {
      await mkdir(path.dirname(path.join(root, source)), { recursive: true });
      await writeFile(path.join(root, source), source === 'index.html' ? '<html><head></head><body>Test</body></html>' : `fixture ${source}`);
    }
    await mkdir(path.join(root, 'public/data'), { recursive: true });
    await writeFile(path.join(root, 'public/data/catalog.json'), JSON.stringify(fixture()));
    for (const file of dataFiles.slice(1)) await writeFile(path.join(root, 'public', file), '%PDF-1.4 fictional unit-test document');
    for (const file of ['public/data/private-plan.json', 'public/data/local-extra.pdf', 'public/private-plan.json', 'dist-pages/old-private.json']) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), 'PRIVATE_CANARY_DO_NOT_PUBLISH');
    }
    const output = await buildPages(root);
    const files = [];
    async function walk(folder, prefix = '') {
      for (const item of await readdir(folder, { withFileTypes: true })) {
        const relative = prefix + item.name;
        if (item.isDirectory()) await walk(path.join(folder, item.name), relative + '/'); else files.push(relative);
      }
    }
    await walk(output);
    assert.deepEqual(files.sort(), [...new Set([...PAGE_FILES.map(([, target]) => target), ...dataFiles, '.nojekyll'])].sort());
    assert.match(await readFile(path.join(output, 'index.html'), 'utf8'), /name="dentotar-catalog" content="hosted"/);
    assert.match(await readFile(path.join(output, 'index.html'), 'utf8'), /connect-src 'self'/);
    assert.ok(!(await readFile(path.join(output, 'index.html'), 'utf8')).includes('content="local-file"'));
    for (const file of files) assert.ok(!(await readFile(path.join(output, file), 'utf8')).includes('PRIVATE_CANARY'));
    for (const file of dataFiles) assert.deepEqual(await readFile(path.join(output, file)), await readFile(path.join(root, 'public', file)));
    await buildPages(root);
    assert.equal(await readFile(path.join(root, 'public/private-plan.json'), 'utf8'), 'PRIVATE_CANARY_DO_NOT_PUBLISH');
  } finally { await rm(root, { recursive: true, force: true }); }
});
