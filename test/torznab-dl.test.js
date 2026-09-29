import test from 'node:test';
import assert from 'node:assert/strict';
import { createTorznabProvider } from '../server/providers.js';

const RSS = (link) => `<?xml version="1.0"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <item>
      <title>无耻之徒 Shameless S01 1080p</title>
      <link>${link}</link>
      <comments>https://example.org/page</comments>
      <pubDate>2024-01-01</pubDate>
      <size>1000</size>
      <torznab:attr name="seeders" value="5"/>
    </item>
  </channel>
</rss>`;

test('torznab keeps items with same-origin download URLs and resolves magnets lazily', async () => {
  const magnet = 'magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&dn=test';
  const dl = 'http://indexer.local/dl/0magnet/?path=abc';
  const fetcher = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('http://indexer.local/api')) return new Response(RSS(dl));
    if (u === dl) {
      assert.equal(opts.redirect, 'manual');
      return new Response('', { status: 302, headers: { location: magnet } });
    }
    throw new Error('unexpected fetch: ' + u);
  };
  const provider = createTorznabProvider({ url: 'http://indexer.local/api', key: 'k', fetcher });
  const result = await provider.search({ q: '无耻之徒', category: 'all', page: 1, limit: 20 });
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.magnet, null);
  assert.equal(item.hash, null);
  assert.match(item.id, /^torznab:[a-f0-9]{40}$/);
  assert.ok(!('downloadUrl' in item), 'key-bearing download URL must not reach the client');
  assert.equal(item.sourceUrl, 'https://example.org/page');
  const detail = await provider.detail(item.id.slice('torznab:'.length));
  assert.equal(detail.hash, 'a'.repeat(40));
  assert.ok(detail.magnet.startsWith('magnet:'));
  // After resolution the item is re-keyed under the real info hash.
  const again = await provider.detail('a'.repeat(40));
  assert.equal(again.magnet, detail.magnet);
});

test('torznab skips items whose only link points to a foreign origin', async () => {
  const provider = createTorznabProvider({
    url: 'http://indexer.local/api',
    key: 'k',
    fetcher: async () => new Response(RSS('http://evil.example/dl')),
  });
  const result = await provider.search({ q: 'x', category: 'all', page: 1, limit: 20 });
  assert.equal(result.items.length, 0);
  assert.match(result.note, /已略过/);
});
