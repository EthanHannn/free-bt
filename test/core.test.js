import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { parseTorrent, parseMagnet, normalizeHash } from '../server/torrent.js';
import { createStore } from '../server/store.js';
import { createArchiveProvider, createTorznabProvider, fetchBytes } from '../server/providers.js';
import { createSearch, searchParams } from '../server/search.js';
import { createApp } from '../server/index.js';

const hash = '0123456789abcdef0123456789abcdef01234567';
const magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent('中文 纪录片')}`;
const query = { q: '中文', category: 'all', sort: 'relevance', source: 'all', page: 1, limit: 20 };
function encode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === 'string') return encode(Buffer.from(value));
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (Array.isArray(value))
    return Buffer.concat([Buffer.from('l'), ...value.map(encode), Buffer.from('e')]);
  return Buffer.concat([
    Buffer.from('d'),
    ...Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .flatMap(([key, val]) => [encode(key), encode(val)]),
    Buffer.from('e'),
  ]);
}
const info = {
  name: '测试文件',
  'piece length': 16384,
  pieces: Buffer.alloc(20),
  files: [
    { length: 1234, path: ['目录', '视频.mp4'] },
    { length: 24, path: ['说明.txt'] },
  ],
};
const torrent = encode({
  announce: 'udp://tracker.example:80/announce',
  'url-list': ['https://example.org/files/'],
  info,
});

test('magnet supports hexadecimal and base32 hashes, preserves trackers', () => {
  assert.equal(parseMagnet(magnet).hash, hash);
  assert.equal(parseMagnet(magnet).name, '中文 纪录片');
  assert.equal(normalizeHash('A'.repeat(32)), '0'.repeat(40));
  assert.equal(normalizeHash(hash.toUpperCase()), hash);
  assert.throws(() => parseMagnet('https://example.org/?xt=urn:btih:' + hash));
  assert.throws(() => normalizeHash('not-a-hash'));
  assert.match(parseMagnet(magnet + '&tr=udp%3A%2F%2Ftracker.example%3A80').magnet, /tr=udp/);
  const withSeeds = parseMagnet(
    magnet + '&ws=https%3A%2F%2Fexample.org%2Ffiles%2F&xs=https%3A%2F%2Fexample.org%2Ftest.torrent',
  ).magnet;
  assert.match(withSeeds, /^magnet:\?xt=urn:btih:/);
  assert.match(withSeeds, /ws=https/);
  assert.match(withSeeds, /xs=https/);
});

test('torrent hashes raw info bytes and handles UTF-8 multi-file metadata', () => {
  const parsed = parseTorrent(torrent);
  assert.equal(parsed.hash, createHash('sha1').update(encode(info)).digest('hex'));
  assert.equal(parsed.size, 1258);
  assert.equal(parsed.fileCount, 2);
  assert.equal(parsed.files[0].name, '目录/视频.mp4');
  assert.match(parsed.magnet, /tr=udp/);
  assert.match(parsed.magnet, /ws=https/);
});

test('torrent rejects truncated, oversized, duplicate, deep and malformed inputs', () => {
  for (const value of [
    torrent.subarray(0, -1),
    Buffer.from('d4:infoi1e4:infoi2ee'),
    Buffer.from('l'.repeat(70) + 'e'.repeat(70)),
    Buffer.from('d4:info100:abc'),
    Buffer.alloc(8 * 1024 * 1024 + 1),
    Buffer.concat([torrent, Buffer.from('junk')]),
    encode({ info: { name: 'a', length: -1, pieces: Buffer.alloc(20), 'piece length': 12 } }),
  ])
    assert.throws(() => parseTorrent(value));
});

test('local index searches Chinese, deduplicates hashes, filters and paginates', () => {
  const store = createStore(':memory:');
  try {
    store.put({ magnet, category: 'video', size: 2048 });
    store.put({ magnet, category: 'video', size: 4096 });
    store.put({
      magnet: magnet.replace(hash, 'f'.repeat(40)),
      name: '中文教程',
      category: 'books',
    });
    assert.equal(store.count(), 2);
    assert.equal(store.get(hash).size, 4096);
    assert.equal(store.search(query).total, 2);
    assert.equal(store.search({ ...query, q: '中文 纪录片' }).total, 1);
    assert.equal(store.search({ ...query, q: '%' }).total, 0);
    assert.equal(store.search({ ...query, q: "' OR 1=1 --" }).total, 0);
    assert.equal(store.search({ ...query, category: 'books' }).total, 1);
    assert.equal(store.search({ ...query, limit: 1 }).hasMore, true);
    assert.equal(store.search({ ...query, limit: 1, page: 2 }).hasMore, false);
  } finally {
    store.close();
  }
});

test('query validation bounds expensive queries and uses literal categories', () => {
  for (const params of [
    'q=',
    'q=x&page=-1',
    'q=x&page=101',
    'q=x&category=toString',
    'q=x&source=../unknown',
    'q=x&sort=invalid',
    `q=${'x'.repeat(161)}`,
  ])
    assert.throws(() => searchParams(new URLSearchParams(params)));
  assert.equal(searchParams(new URLSearchParams('q=中文&page=2')).page, 2);
});

test('archive uses real API field mapping and builds magnetic links from torrent bytes', async () => {
  const seen = [];
  const provider = createArchiveProvider(async (url) => {
    seen.push(String(url));
    if (String(url).includes('advancedsearch'))
      return Response.json({
        response: {
          numFound: 21,
          docs: [
            {
              identifier: 'test-resource',
              title: ['中文电影'],
              mediatype: 'movies',
              publicdate: '2026-01-01',
            },
          ],
        },
      });
    if (String(url).includes('/metadata/'))
      return Response.json({
        metadata: { title: '中文电影', mediatype: 'movies' },
        files: [{ name: 'test-resource_archive.torrent', format: 'Archive BitTorrent' }],
      });
    return new Response(torrent);
  });
  const result = await provider.search({ ...query, q: 'title:test OR all', category: 'video' });
  assert.equal(result.items[0].size, null);
  assert.equal(result.items[0].seeders, null);
  assert.equal(result.items[0].category, 'video');
  assert.equal(result.hasMore, true);
  const upstreamQuery = new URL(seen[0]).searchParams.get('q');
  assert.match(upstreamQuery, /"title:test" AND "OR" AND "all"/);
  const detail = await provider.detail('test-resource');
  assert.equal(detail.hash, parseTorrent(torrent).hash);
  assert.equal(detail.files.length, 2);
  await assert.rejects(provider.detail('../private'));
});

test('Torznab parses namespaces, leaves unknown seed count null and omits API URLs', async () => {
  const provider = createTorznabProvider({
    url: 'http://localhost:9696/1/api',
    key: 'test-private-key',
    fetcher: async (url) => {
      assert.equal(new URL(url).searchParams.get('apikey'), 'test-private-key');
      return new Response(
        `<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><torznab:response offset="0" total="1"/><item><title>中文 &amp; 测试</title><size>123</size><link>http://localhost/private?apikey=test-private-key</link><torznab:attr name="infohash" value="${hash}"/><torznab:attr name="category" value="2000"/></item></channel></rss>`,
      );
    },
  });
  const result = await provider.search(query);
  assert.equal(result.items[0].name, '中文 & 测试');
  assert.equal(result.items[0].seeders, null);
  assert.equal(result.items[0].category, 'video');
  assert.equal(result.total, 1);
  assert.equal(result.hasMore, false);
  assert.ok(!JSON.stringify(result).includes('test-private-key'));
  assert.equal((await provider.detail(hash)).hash, hash);
});

test('Torznab skips results without a hash and rejects entity definitions', async () => {
  const provider = createTorznabProvider({
    url: 'http://localhost/api',
    fetcher: async () =>
      new Response('<rss><channel><item><title>hashless</title></item></channel></rss>'),
  });
  const result = await provider.search(query);
  assert.equal(result.items.length, 0);
  assert.match(result.note, /1 条/);
  const bad = createTorznabProvider({
    url: 'http://localhost/api',
    fetcher: async () => new Response('<!DOCTYPE rss><rss/>'),
  });
  await assert.rejects(bad.search(query));
});

test('bounded upstream fetch rejects HTTP errors and excessive bodies', async () => {
  await assert.rejects(
    fetchBytes('http://test', { fetcher: async () => new Response('', { status: 500 }) }),
  );
  await assert.rejects(
    fetchBytes('http://test', { max: 5, fetcher: async () => new Response('123456') }),
  );
});

test('transient upstream failures retry once within the same timeout budget', async () => {
  let count = 0;
  const result = await fetchBytes('http://test', {
    fetcher: async () =>
      ++count === 1 ? new Response('', { status: 503 }) : new Response('recovered'),
  });
  assert.equal(result.toString(), 'recovered');
  assert.equal(count, 2);
});

test('aggregation keeps successful sources, merges known hashes and retries failed searches', async () => {
  let calls = 0;
  const providers = [
    {
      id: 'local',
      name: '本地',
      async search() {
        calls++;
        return { items: [{ id: 'local:x', hash, sourceName: '本地' }], total: 1, hasMore: false };
      },
    },
    {
      id: 'torznab',
      name: '索引器',
      async search() {
        return {
          items: [{ id: 'torznab:x', hash, sourceName: '索引器' }],
          total: 1,
          hasMore: false,
        };
      },
    },
    {
      id: 'archive',
      name: '档案',
      async search() {
        throw new Error('secret');
      },
    },
  ];
  const search = createSearch(providers);
  const result = await search(query);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].sources, ['本地', '索引器']);
  assert.equal(result.partial, true);
  assert.equal(result.failed, false);
  assert.ok(!JSON.stringify(result).includes('secret'));
  await search(query);
  assert.equal(calls, 2);
});

test('successful searches cache and coalesce parallel requests', async () => {
  let calls = 0;
  const search = createSearch([
    {
      id: 'local',
      name: '本地',
      async search() {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { items: [], total: 0, hasMore: false };
      },
    },
  ]);
  await Promise.all([search(query), search(query)]);
  const result = await search(query);
  assert.equal(calls, 1);
  assert.equal(result.cached, true);
});

test('HTTP app delivers search, detail and static assets without exposing local files', async () => {
  const store = createStore(':memory:');
  store.put({ magnet, category: 'video' });
  const { server } = createApp({ store, externalProviders: [] });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await page.text(), /自由 BT/);
    const result = await (await fetch(`${base}/api/search?q=${encodeURIComponent('中文')}`)).json();
    assert.equal(result.items[0].hash, hash);
    const detail = await (await fetch(`${base}/api/resource?id=local:${hash}`)).json();
    assert.equal(detail.hash, hash);
    for (const [path, status] of [
      ['/api/search?q=', 400],
      ['/api/search?q=x&source=torznab', 400],
      ['/api/resource?id=archive:../secret', 400],
      ['/.env', 404],
      ['/package.json', 404],
      ['/api/not-found', 404],
    ])
      assert.equal((await fetch(base + path)).status, status);
    assert.equal((await fetch(base + '/api/search?q=x', { method: 'POST' })).status, 405);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});
