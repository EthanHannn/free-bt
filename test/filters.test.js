import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/index.js';
import { createSearch, searchParams } from '../server/search.js';
import { createStore } from '../server/store.js';

const hash = 'a'.repeat(40);
const magnet = `magnet:?xt=urn:btih:${hash}&dn=test`;

function providerWith(items) {
  return {
    id: 'x',
    name: 'X',
    async search() {
      return { items, total: items.length, hasMore: false };
    },
  };
}

const base = { q: 'test', category: 'all', source: 'all', page: 1, limit: 20, literal: true };

test('seeders sort orders by count with unknown seeders last', async () => {
  const search = createSearch([
    providerWith([
      { id: 'x:a', hash: 'a'.repeat(40), name: 'test a', sourceName: 'X', seeders: 5 },
      { id: 'x:b', hash: 'b'.repeat(40), name: 'test b', sourceName: 'X', seeders: 900 },
      { id: 'x:c', hash: 'c'.repeat(40), name: 'test c', sourceName: 'X', seeders: null },
    ]),
  ]);
  const result = await search({ ...base, sort: 'seeders' });
  assert.deepEqual(
    result.items.map((i) => i.name),
    ['test b', 'test a', 'test c'],
  );
});

test('size and time filters drop non-matching and unknown-valued items', async () => {
  const now = Date.now();
  const item = (id, name, size, added) => ({
    id: `x:${id}`,
    hash: id.repeat(40).slice(0, 40),
    name,
    sourceName: 'X',
    size,
    added,
  });
  const search = createSearch([
    providerWith([
      item('a', 'test small', 500 * 1024 ** 2, new Date(now - 2 * 864e5).toISOString()),
      item('b', 'test medium', 5 * 1024 ** 3, new Date(now - 20 * 864e5).toISOString()),
      item('c', 'test large', 30 * 1024 ** 3, new Date(now - 200 * 864e5).toISOString()),
      item('d', 'test unknown-size', null, new Date(now - 1 * 864e5).toISOString()),
      item('e', 'test unknown-date', 100, 'not-a-date'),
    ]),
  ]);
  const small = await search({ ...base, sort: 'relevance', size: 'small', time: 'all' });
  assert.deepEqual(
    small.items.map((i) => i.name).sort(),
    ['test small', 'test unknown-date'],
  );
  assert.equal(small.filtered, 3);
  const large = await search({ ...base, sort: 'relevance', size: 'large', time: 'all' });
  assert.deepEqual(
    large.items.map((i) => i.name),
    ['test large'],
  );
  const week = await search({ ...base, sort: 'relevance', size: 'all', time: 'week' });
  assert.deepEqual(
    week.items.map((i) => i.name).sort(),
    ['test small', 'test unknown-size'],
  );
  const unfiltered = await search({ ...base, sort: 'relevance', size: 'all', time: 'all' });
  assert.equal(unfiltered.items.length, 5);
  assert.equal(unfiltered.filtered, undefined);
});

test('searchParams validates the new filter and sort values', () => {
  for (const params of ['q=x&sort=popular', 'q=x&size=huge', 'q=x&time=century'])
    assert.throws(() => searchParams(new URLSearchParams(params)), /筛选条件无效/);
  const parsed = searchParams(new URLSearchParams('q=x&sort=seeders&size=medium&time=month'));
  assert.equal(parsed.sort, 'seeders');
  assert.equal(parsed.size, 'medium');
  assert.equal(parsed.time, 'month');
});

test('POST /api/download pushes enriched magnets; other POSTs stay 405', async () => {
  const store = createStore(':memory:');
  store.put({ magnet, category: 'video' });
  const pushed = [];
  const { server } = createApp({
    store,
    externalProviders: [],
    downloader: { name: 'fake', push: async (value) => pushed.push(value) },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) =>
    fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    const sources = await (await fetch(`${baseUrl}/api/sources`)).json();
    assert.deepEqual(sources.downloader, { configured: true, name: 'fake' });

    const ok = await post('/api/download', { id: `local:${hash}` });
    assert.equal(ok.status, 200);
    const payload = await ok.json();
    assert.equal(payload.ok, true);
    assert.match(pushed[0], new RegExp(`btih:${hash}`));
    assert.match(pushed[0], /tr=/, '推送的磁力应附带注入的 Tracker');

    assert.equal((await post('/api/download', { id: '!!bad' })).status, 400);
    const missing = await post('/api/download', { id: `local:${'b'.repeat(40)}` });
    assert.equal(missing.status, 404);
    assert.equal((await post('/api/search', { q: 'x' })).status, 405);
    const oversized = await fetch(`${baseUrl}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'x'.repeat(5000) }),
    });
    assert.equal(oversized.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});

test('POST /api/download returns 501 when no downloader is configured', async () => {
  const store = createStore(':memory:');
  const { server } = createApp({ store, externalProviders: [], downloader: null });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: `local:${hash}` }),
    });
    assert.equal(response.status, 501);
    const sources = await (await fetch(`${baseUrl}/api/sources`)).json();
    assert.equal(sources.downloader.configured, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});
