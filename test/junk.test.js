import test from 'node:test';
import assert from 'node:assert/strict';
import { isJunkName } from '../server/junk.js';
import { createSearch } from '../server/search.js';

test('junk detection catches emoji-wrapped ad titles with obfuscated contacts', () => {
  assert.ok(
    isJunkName('❤️【麻豆91视频网▶ k 91 v · c o m 】❤️奶气原创【无耻之徒弗兰克】最新剧情作品'),
  );
  assert.ok(isJunkName('💰兼职刷单 日入千元 💰 c o m'));
  assert.ok(
    !isJunkName(
      '【高清剧集网发布 www.DDHDTV.com】无耻之徒(美版) 第十一季[全12集][中文字幕].Shameless.U.S.S11.1080p',
    ),
  );
  assert.ok(
    !isJunkName('[美剧库官网 www.meijuku.cn]无耻之徒.Shameless(美版) 1-7季【关注微信公众号：美剧叔】'),
  );
  assert.ok(!isJunkName('Casino 赌场 1995 1080p BluRay'));
  assert.ok(!isJunkName(''));
});

test('junk filter is opt-in and reports the hidden count', async () => {
  const provider = {
    id: 'x',
    name: 'X',
    async search() {
      return {
        items: [
          { id: 'x:good', hash: 'a'.repeat(40), name: '无耻之徒 第一季', sourceName: 'X' },
          {
            id: 'x:bad',
            hash: 'b'.repeat(40),
            name: '❤️兼职刷单 加 c o m ❤️ 无耻之徒',
            sourceName: 'X',
          },
        ],
        total: 2,
        hasMore: false,
      };
    },
  };
  const search = createSearch([provider]);
  const base = {
    q: '无耻之徒',
    category: 'all',
    source: 'all',
    page: 1,
    limit: 20,
    sort: 'relevance',
    literal: true,
  };
  const off = await search({ ...base, junk: false });
  assert.equal(off.items.length, 2);
  assert.equal(off.junkHidden, undefined);
  const on = await search({ ...base, junk: true });
  assert.equal(on.items.length, 1);
  assert.equal(on.items[0].name, '无耻之徒 第一季');
  assert.equal(on.junkHidden, 1);
});
