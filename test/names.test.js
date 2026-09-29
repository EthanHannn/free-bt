import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chainResolvers,
  createNameResolver,
  createTmdbResolver,
  normalizedTitle,
  matchesName,
} from '../server/names.js';
import { createSearch } from '../server/search.js';

test('title matching normalizes traditional Chinese, punctuation and release separators', () => {
  assert.equal(normalizedTitle('很便宜，千里馬超市'), normalizedTitle('很便宜千里马超市'));
  assert.ok(matchesName('The.Queen.of.NEWS.S01E22', 'The Queen of News', true));
  assert.ok(!matchesName('Queen - News of the World', 'The Queen of News', true));
});

test('live metadata schema resolves exact title and does not merge a sequel', async () => {
  let calls = 0;
  const resolver = createNameResolver({
    fetcher: async () => {
      calls++;
      return Response.json({
        query: {
          pages: [
            {
              pageid: 1,
              title: '新聞女王',
              index: 1,
              langlinks: [{ lang: 'en', title: 'The Queen of News' }],
            },
            {
              pageid: 2,
              title: '新聞女王2',
              index: 2,
              langlinks: [{ lang: 'en', title: 'The Queen of News 2' }],
            },
          ],
        },
      });
    },
  });
  const result = await resolver('新闻女王');
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.queries, ['新闻女王', 'The Queen of News', '新聞女王']);
  assert.ok((await resolver('新聞女王')).queries.includes('The Queen of News'));
  assert.equal(calls, 1);
});

test('ambiguous, unrelated and unavailable metadata never silently replace the query', async () => {
  const resolver = createNameResolver({
    fetcher: async () =>
      Response.json({
        query: {
          pages: [
            {
              pageid: 1,
              title: '三體 (小說)',
              langlinks: [{ lang: 'en', title: 'The Three-Body Problem (novel)' }],
            },
            {
              pageid: 2,
              title: '三體 (電視劇)',
              langlinks: [{ lang: 'en', title: 'Three-Body (TV series)' }],
            },
          ],
        },
      }),
  });
  assert.equal((await resolver('三体')).status, 'ambiguous');
  assert.deepEqual((await resolver('三体')).queries, ['三体', '三體']);
  const failed = createNameResolver({ fetcher: async () => new Response('', { status: 403 }) });
  assert.equal((await failed('新闻女王')).status, 'unavailable');
  assert.deepEqual((await failed('Linux')).queries, ['Linux']);
});

test('name expansion merges duplicate hashes and surfaces partial variant failure', async () => {
  const hash = 'a'.repeat(40);
  const search = createSearch(
    [
      {
        id: 'bt',
        name: 'BT',
        async search({ q }) {
          if (q === '新聞女王') throw new Error('offline');
          return {
            items: [
              {
                id: 'bt:1',
                hash,
                name: 'The Queen of News S01E22',
                sourceName: 'BT',
                magnet: 'magnet:x',
              },
            ],
            total: 1,
            hasMore: false,
          };
        },
      },
    ],
    120000,
    {
      resolveNames: async () => ({
        status: 'resolved',
        queries: ['新闻女王', '新聞女王', 'The Queen of News'],
      }),
    },
  );
  const result = await search({
    q: '新闻女王',
    category: 'all',
    source: 'all',
    page: 1,
    limit: 20,
    sort: 'relevance',
  });
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].matchedQueries, ['The Queen of News']);
  assert.equal(result.sources[0].state, 'partial');
  assert.equal(result.failed, false);
  assert.equal(result.partial, true);
});

test('literal searches skip the metadata service and limit expanded requests', async () => {
  let metadata = 0,
    calls = 0;
  const search = createSearch(
    [
      {
        id: 'bt',
        name: 'BT',
        async search() {
          calls++;
          return { items: [], hasMore: false, total: 0 };
        },
      },
    ],
    120000,
    {
      resolveNames: async () => {
        metadata++;
        return { status: 'resolved', queries: ['a', 'b', 'c', 'd', 'e'] };
      },
    },
  );
  const query = {
    q: '新闻女王',
    category: 'all',
    source: 'all',
    page: 1,
    limit: 20,
    sort: 'relevance',
  };
  await search({ ...query, literal: true });
  assert.equal(metadata, 0);
  assert.equal(calls, 2);
  await search(query);
  assert.equal(calls, 5);
});

test('TMDB resolves a dominant exact match and reports year', async () => {
  const resolver = createTmdbResolver({
    apiKey: 'k',
    fetcher: async () =>
      Response.json({
        results: [
          { media_type: 'tv', id: 1, name: '无耻之徒', original_name: 'Shameless', first_air_date: '2011-01-09', popularity: 300 },
          { media_type: 'tv', id: 2, name: '无耻之徒', original_name: 'Shameless UK', first_air_date: '2004-01-13', popularity: 20 },
          { media_type: 'person', id: 3, name: '无耻之徒演员' },
        ],
      }),
  });
  const result = await resolver('无耻之徒');
  assert.equal(result.status, 'resolved');
  assert.equal(result.english, 'Shameless');
  assert.equal(result.year, '2011');
  assert.deepEqual(result.queries.slice(0, 2), ['无耻之徒', 'Shameless']);
  assert.match(result.sourceUrl, /themoviedb\.org\/tv\/1/);
});

test('TMDB stays ambiguous when same-title works have comparable popularity and reports failure', async () => {
  const close = createTmdbResolver({
    apiKey: 'k',
    fetcher: async () =>
      Response.json({
        results: [
          { media_type: 'movie', id: 1, title: '同名作品', original_title: 'Same A', release_date: '2001-01-01', popularity: 50 },
          { media_type: 'movie', id: 2, title: '同名作品', original_title: 'Same B', release_date: '2002-01-01', popularity: 40 },
        ],
      }),
  });
  assert.equal((await close('同名作品')).status, 'ambiguous');
  const broken = createTmdbResolver({
    apiKey: 'k',
    fetcher: async () => new Response('', { status: 401 }),
  });
  assert.equal((await broken('同名作品')).status, 'unavailable');
});

test('chainResolvers falls back past unavailable resolvers', async () => {
  const unavailable = async () => ({ status: 'unavailable' });
  const resolved = async () => ({ status: 'resolved', queries: ['q', 'Q'] });
  assert.equal((await chainResolvers(unavailable, resolved)('q')).status, 'resolved');
  assert.equal((await chainResolvers(unavailable)('q')).status, 'unavailable');
});
