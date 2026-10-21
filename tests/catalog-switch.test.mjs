import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const expected = [
  ['DENTOTAR', 'https://wakuwakumiwaku.github.io/dentotar/'],
  ['MiGeL', 'https://wakuwakumiwaku.github.io/migel/'],
  ['Spezialitätenliste', 'https://wakuwakumiwaku.github.io/spezialitaetenliste/'],
];

test('catalog switch links all three catalogs and identifies only the current page', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const nav = html.match(/<nav\b[^>]*class="catalog-switch"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(nav, 'A visible catalog-switch navigation must be present');
  const links = [...nav[1].matchAll(/<a\b([^>]*)>([^<]+)<\/a>/g)];
  assert.equal(links.length, expected.length);
  expected.forEach(([label, url], i) => {
    assert.equal(links[i][2], label);
    assert.ok(links[i][1].includes(`href="${url}"`));
    assert.equal(links[i][1].includes('aria-current="page"'), i === 0);
  });
  assert.match(nav[0], /aria-label="Katalog wechseln"/);
});
