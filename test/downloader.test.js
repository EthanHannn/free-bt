import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownloader } from '../server/downloader.js';

const MAGNET = `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=test`;

test('qbittorrent logs in once, caches the cookie and pushes magnets', async () => {
  const calls = [];
  const fetcher = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).endsWith('/api/v2/auth/login'))
      return new Response('Ok.', { headers: { 'set-cookie': 'SID=abc; HttpOnly; path=/' } });
    return new Response('Ok.');
  };
  const dl = createDownloader(
    {
      DOWNLOADER_TYPE: 'qbittorrent',
      DOWNLOADER_URL: 'http://nas.local:8080/',
      DOWNLOADER_USER: 'admin',
      DOWNLOADER_PASSWORD: 'secret',
    },
    fetcher,
  );
  assert.equal(dl.name, 'qBittorrent');
  await dl.push(MAGNET);
  await dl.push(MAGNET);
  const logins = calls.filter((c) => c.url.includes('auth/login'));
  const adds = calls.filter((c) => c.url.includes('torrents/add'));
  assert.equal(logins.length, 1, 'cookie 应被缓存，只登录一次');
  assert.equal(adds.length, 2);
  assert.equal(adds[0].opts.headers.Cookie, 'SID=abc');
  assert.match(adds[0].opts.body.toString(), /^urls=/);
});

test('qbittorrent re-logs in after a 403 and retries the add', async () => {
  let adds = 0;
  let logins = 0;
  const fetcher = async (url) => {
    if (String(url).endsWith('/api/v2/auth/login')) {
      logins++;
      return new Response('Ok.', { headers: { 'set-cookie': `SID=s${logins}` } });
    }
    adds++;
    return adds === 1 ? new Response('Forbidden', { status: 403 }) : new Response('Ok.');
  };
  const dl = createDownloader(
    { DOWNLOADER_TYPE: 'qbittorrent', DOWNLOADER_URL: 'http://nas.local:8080' },
    fetcher,
  );
  await dl.push(MAGNET);
  assert.equal(logins, 2);
  assert.equal(adds, 2);
});

test('qbittorrent surfaces login and push failures', async () => {
  const badLogin = createDownloader(
    { DOWNLOADER_TYPE: 'qbittorrent', DOWNLOADER_URL: 'http://nas.local:8080' },
    async () => new Response('Fails.'),
  );
  await assert.rejects(() => badLogin.push(MAGNET), /登录失败/);
  const badAdd = createDownloader(
    { DOWNLOADER_TYPE: 'qbittorrent', DOWNLOADER_URL: 'http://nas.local:8080' },
    async (url) =>
      String(url).includes('auth/login')
        ? new Response('Ok.', { headers: { 'set-cookie': 'SID=x' } })
        : new Response('error', { status: 500 }),
  );
  await assert.rejects(() => badAdd.push(MAGNET), /HTTP 500/);
});

test('aria2 sends addUri with and without token and reports RPC errors', async () => {
  const bodies = [];
  const dl = createDownloader(
    { DOWNLOADER_TYPE: 'aria2', DOWNLOADER_URL: 'http://nas.local:6800', DOWNLOADER_TOKEN: 's3cret' },
    async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'free-bt', result: 'gid-1' }));
    },
  );
  assert.equal(dl.name, 'aria2');
  await dl.push(MAGNET);
  assert.equal(bodies[0].method, 'aria2.addUri');
  assert.equal(bodies[0].params[0], 'token:s3cret');
  assert.match(bodies[0].params[1][0], /^magnet:\?xt=urn:btih:/);

  const failing = createDownloader(
    { DOWNLOADER_TYPE: 'aria2', DOWNLOADER_URL: 'http://nas.local:6800' },
    async () =>
      new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 200 }),
  );
  await assert.rejects(() => failing.push(MAGNET), /Unauthorized/);
});

test('rejects invalid magnets and incomplete configuration', async () => {
  const dl = createDownloader(
    { DOWNLOADER_TYPE: 'aria2', DOWNLOADER_URL: 'http://nas.local:6800' },
    async () => new Response('{}'),
  );
  await assert.rejects(() => dl.push('https://example.org/not-a-magnet'), /magnet|hash/i);
  assert.equal(createDownloader({}, async () => {}), null);
  assert.equal(
    createDownloader({ DOWNLOADER_TYPE: 'aria2' }, async () => {}),
    null,
  );
  assert.throws(
    () => createDownloader({ DOWNLOADER_TYPE: 'wget', DOWNLOADER_URL: 'http://x' }, async () => {}),
    /qbittorrent 或 aria2/,
  );
});
