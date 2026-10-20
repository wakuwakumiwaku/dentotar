import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createAppServer, acceptsGzip } from '../scripts/serve.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dentotar-http-'));
  await mkdir(path.join(root, 'public/data'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<!doctype html><html lang="de">Synthetic fixture</html>');
  await writeFile(path.join(root, 'public/data/catalog.json'), JSON.stringify({ fixture: 'synthetic '.repeat(1000) }));
  const server = createAppServer({ root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { root, url: `http://127.0.0.1:${server.address().port}` };
}

test('gzip negotiation respects explicit q=0 including wildcard', () => {
  for (const value of ['gzip', 'br, gzip;q=0.5', '*;q=1']) assert.equal(acceptsGzip(value), true);
  for (const value of ['', 'br', 'gzip;q=0', 'gzip;q=0,*;q=1', 'gzip;q=wat', 'gzip;q=2']) assert.equal(acceptsGzip(value), false);
});
test('serves only allowlisted assets with security headers', async t => {
  const { url } = await fixture(t);
  const response = await fetch(url);
  assert.equal(response.status, 200); assert.match(await response.text(), /Synthetic fixture/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const suffix of ['/package.json', '/.env', '/sources/', '/scripts/serve.mjs', '/..%2fpackage.json']) {
    assert.equal((await fetch(url + suffix)).status, 404, suffix);
  }
});
test('POST is refused and HEAD has no response body', async t => {
  const { url } = await fixture(t);
  assert.equal((await fetch(url, { method: 'POST', body: 'no write' })).status, 405);
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
});
test('host gate prevents DNS-rebinding access', async t => {
  const { url } = await fixture(t);
  // Node fetch can rewrite Host to match its URL; exercise the actual HTTP header.
  const status = await new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Host: 'untrusted.invalid' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
  assert.equal(status, 403);
});
test('compressed and raw representations have separate validators', async t => {
  const { url } = await fixture(t);
  const compressed = await fetch(url + '/data/catalog.json', { headers: { 'accept-encoding': 'gzip' } });
  const raw = await fetch(url + '/data/catalog.json', { headers: { 'accept-encoding': 'gzip;q=0, *;q=1' } });
  assert.equal(compressed.headers.get('content-encoding'), 'gzip');
  assert.equal(raw.headers.get('content-encoding'), null);
  assert.equal(compressed.headers.get('vary'), 'Accept-Encoding');
  assert.notEqual(compressed.headers.get('etag'), raw.headers.get('etag'));
  assert.equal(await compressed.text(), await raw.text());
  const unchanged = await fetch(url + '/data/catalog.json', { headers: { 'accept-encoding': 'gzip', 'if-none-match': compressed.headers.get('etag') } });
  assert.equal(unchanged.status, 304);
});
test('source metadata changes invalidate the static cache', async t => {
  const { root, url } = await fixture(t);
  const old = await (await fetch(url)).text();
  await writeFile(path.join(root, 'index.html'), 'Fresh synthetic content');
  assert.notEqual(await (await fetch(url)).text(), old);
});
test('symlinks outside the served root are refused', async t => {
  const { root, url } = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'dentotar-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'private.txt'), 'protected synthetic value');
  await rm(path.join(root, 'index.html'));
  await symlink(path.join(outside, 'private.txt'), path.join(root, 'index.html'));
  assert.equal((await fetch(url)).status, 403);
});
