import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiBayProvider } from '../server/apibay.js';
import { createApp } from '../server/index.js';
import { createStore } from '../server/store.js';
import { once } from 'node:events';
const hash = '0123456789abcdef0123456789abcdef01234567';
const row = {
  id: '123456',
  name: 'The Queen of News S01E22 2023 2160p',
  info_hash: hash,
  category: '212',
  seeders: '2',
  size: '1200',
  num_files: '2',
  added: '1700000000',
};
const query = { q: 'Queen of News', category: 'all', page: 1, limit: 20, sort: 'relevance' };
test('ApiBay maps real schema and rejects unrelated trending fallback for Chinese input', async () => {
  const provider = createApiBayProvider(async () => Response.json([row]));
  const match = await provider.search(query);
  assert.equal(match.items[0].hash, hash);
  assert.equal(match.items[0].category, 'video');
  assert.equal(match.items[0].seeders, 2);
  assert.equal((await provider.search({ ...query, q: '新闻女王' })).items.length, 0);
  assert.equal((await provider.search({ ...query, category: 'audio' })).items.length, 0);
});
test('ApiBay excludes no-results sentinel, deduplicates and paginates filtered results', async () => {
  const provider = createApiBayProvider(async () =>
    Response.json([
      row,
      row,
      { ...row, id: '123457', info_hash: 'f'.repeat(40) },
      { id: '0', info_hash: '0'.repeat(40), name: 'No results returned' },
    ]),
  );
  const first = await provider.search({ ...query, limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.hasMore, true);
  assert.equal((await provider.search({ ...query, limit: 1, page: 2 })).hasMore, false);
});
test('ApiBay details work without prior search and expose file provenance', async () => {
  const provider = createApiBayProvider(async (url) =>
    Response.json(String(url).includes('/f.php') ? [{ name: ['episode.mkv'], size: [1200] }] : row),
  );
  const detail = await provider.detail('123456');
  assert.equal(detail.files[0].name, 'episode.mkv');
  assert.equal(detail.files[0].size, 1200);
  assert.match(detail.fileListSource, /上游/);
  await assert.rejects(provider.detail('../private'));
});
test('ApiBay preserves magnetic detail if optional file listing fails', async () => {
  const provider = createApiBayProvider(async (url) =>
    String(url).includes('/f.php') ? new Response('', { status: 404 }) : Response.json(row),
  );
  const detail = await provider.detail('123456');
  assert.ok(detail.magnet);
  assert.ok(detail.detailNote);
});

test('provider registry accepts numeric detail IDs and rejects invalid and unconfigured sources', async () => {
  const provider = createApiBayProvider(async (url) =>
    Response.json(String(url).includes('/f.php') ? [] : row),
  );
  const store = createStore(':memory:');
  const { server } = createApp({ store, externalProviders: [provider] });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/resource?id=apibay:123456')).status, 200);
    assert.equal((await fetch(base + '/api/resource?id=apibay:nope')).status, 400);
    assert.equal((await fetch(base + '/api/search?q=x&source=unknown')).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});
