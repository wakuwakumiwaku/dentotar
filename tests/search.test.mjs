import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSearchIndex, normalize, search } from '../src/domain.js';

// The pre-optimization ranking is retained as an independent behavior oracle.
function reference(index, query = '', { chapter = '', favorites = null } = {}) {
  const q = normalize(query), tokens = q.split(' ').filter(Boolean), compact = q.replaceAll('.', '');
  return index.filter(row => (!chapter || row.position.chapter === chapter)
    && (!favorites || favorites.has(row.position.code))
    && tokens.every(token => row.haystack.includes(token) || row.code.replaceAll('.', '').includes(token)))
    .map(row => ({ row, score: !q ? 0 : row.code === q || row.code.replaceAll('.', '') === compact ? 0
      : row.code.startsWith(q) ? 1 : row.title.startsWith(q) ? 2
        : tokens.every(t => row.title.includes(t)) ? 3 : 4 }))
    .sort((a, b) => a.score - b.score || a.row.position.code.localeCompare(b.row.position.code, 'de-CH', { numeric: true }))
    .map(item => item.row.position);
}
const queries = ['', '4', '4.0', '40000', '4.0000', 'Röntgen', 'roentgen', 'Anästhesie', 'implantat', 'zähne', 'Labor', 'nicht', '4.0300', 'D.yyyy', 'unbekanntxyz'];

function assertParity(positions, contexts) {
  const before = JSON.stringify(positions), index = buildSearchIndex(positions);
  for (const query of queries) for (const context of contexts) {
    const expected = reference(index, query, context), actual = search(index, query, context);
    assert.deepEqual(actual.map(p => p.code), expected.map(p => p.code));
    actual.forEach((p, i) => assert.equal(p, expected[i], 'retain original reference, order and complete record'));
  }
  assert.equal(JSON.stringify(positions), before, 'never mutate source rows');
}

test('optimized search preserves full-catalog ordering with chapter and favorite combinations', async t => {
  const catalog = JSON.parse(await readFile(new URL('../public/data/catalog.json', import.meta.url), 'utf8'));
  const favorites = new Set(catalog.positions.slice(0, 25).map(p => p.code));
  const contexts = [{}, ...catalog.chapters.slice(0, 3).map(chapter => ({ chapter: chapter.id })),
    { favorites }, { favorites: new Set() }, { chapter: catalog.positions[0].chapter, favorites }];
  assertParity(catalog.positions, contexts);
  t.diagnostic(`${catalog.positions.length} source rows, ${queries.length * contexts.length} full-order parity cases`);
});

test('numeric collation ties, suffixes and changed favorite membership preserve source order', () => {
  const positions = ['4.02', '4.2', '4.001.M', '4.001.LP', '4.1', 'A.2'].map((code, i) => ({ code,
    title: i % 2 ? 'Röntgen Leistung' : 'Zähne Untersuchung', notes: 'Anästhesie 4.0000', chapter: i % 2 ? '01' : '02' }));
  assertParity(positions, [{}, { chapter: '01' }, { favorites: new Set(positions.map(p => p.code)) }]);
  const index = buildSearchIndex(positions), favorites = new Set([positions[0].code]);
  assert.deepEqual(search(index, '', { favorites }), [positions[0]]);
  favorites.clear(); favorites.add(positions[3].code);
  assert.deepEqual(search(index, '', { favorites }), [positions[3]]);
});
