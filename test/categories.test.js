import test from 'node:test';
import assert from 'node:assert/strict';
import { inferCategory } from '../server/categories.js';
import { createTorznabProvider } from '../server/providers.js';

test('inferCategory spots video releases in Chinese and English titles', () => {
  assert.equal(
    inferCategory('【高清剧集网发布 www.DDHDTV.com】无耻之徒(美版) 第十一季[全12集][中文字幕].Shameless.U.S.S11.1080p'),
    'video',
  );
  assert.equal(inferCategory('Casino 赌场 1995 1080p BluRay'), 'video');
  assert.equal(inferCategory('葬送的芙莉莲 S01E28 简繁内封'), 'video');
  assert.equal(inferCategory('地球脉动 III 纪录片 4K HDR'), 'video');
});

test('inferCategory spots software, books and audio', () => {
  assert.equal(inferCategory('某某办公软件 2025 破解版 安装包'), 'software');
  assert.equal(inferCategory('Windows 11 专业版 激活工具'), 'software');
  assert.equal(inferCategory('三体全集 epub mobi kindle'), 'books');
  assert.equal(inferCategory('鬼吹灯 精校版小说'), 'books');
  assert.equal(inferCategory('周杰伦 最伟大的作品 FLAC 无损音乐'), 'audio');
  assert.equal(inferCategory('Some Band 2024 album mp3'), 'audio');
});

test('inferCategory stays conservative without strong signals', () => {
  assert.equal(inferCategory('随便一个资源名字 xyz'), 'other');
  assert.equal(inferCategory(''), 'other');
  assert.equal(inferCategory(null), 'other');
  // Watermark-only hints do not qualify.
  assert.equal(
    inferCategory('[美剧库官网 www.meijuku.cn]无耻之徒.Shameless(美版) 1-7季【关注微信公众号：美剧叔】'),
    'other',
  );
});

test('torznab applies title inference only when the indexer reports "other"', async () => {
  const RSS = (title, categoryAttr) => `<?xml version="1.0"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <item>
      <title>${title}</title>
      <link>magnet:?xt=urn:btih:${'b'.repeat(40)}&dn=x</link>
      <pubDate>2024-01-01</pubDate>
      ${categoryAttr}
    </item>
  </channel>
</rss>`;
  const fetcherFor = (xml) => async () => new Response(xml);
  const base = { url: 'http://indexer.local/api', key: 'k' };
  const inferred = await createTorznabProvider({
    ...base,
    fetcher: fetcherFor(RSS('无耻之徒 第十一季 1080p', '')),
  }).search({ q: '无耻之徒', category: 'all', page: 1, limit: 20 });
  assert.equal(inferred.items[0].category, 'video');
  const kept = await createTorznabProvider({
    ...base,
    fetcher: fetcherFor(
      RSS('无耻之徒 第十一季 1080p', '<torznab:attr name="category" value="8000"/>'),
    ),
  }).search({ q: '无耻之徒', category: 'all', page: 1, limit: 20 });
  assert.equal(kept.items[0].category, 'video', 'title inference rescues explicit "other" too');
  const untouched = await createTorznabProvider({
    ...base,
    fetcher: fetcherFor(
      RSS('某讲座录音 2024', '<torznab:attr name="category" value="3000"/>'),
    ),
  }).search({ q: '讲座', category: 'all', page: 1, limit: 20 });
  assert.equal(untouched.items[0].category, 'audio', 'indexer-reported category wins');
});
