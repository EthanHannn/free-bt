// Push magnets to a local download client (qBittorrent WebUI or aria2 RPC).
// Credentials stay server-side in .env; the feature is absent when unconfigured.
import { parseMagnet } from './torrent.js';

const TIMEOUT = 15_000;

function validEndpoint(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin + url.pathname.replace(/\/$/, '') : null;
  } catch {
    return null;
  }
}

export function createDownloader(env = process.env, fetcher = fetch) {
  const type = String(env.DOWNLOADER_TYPE || '').toLowerCase();
  const base = validEndpoint(env.DOWNLOADER_URL || '');
  if (!type || !base) return null;
  if (!['qbittorrent', 'aria2'].includes(type))
    throw new Error('DOWNLOADER_TYPE 仅支持 qbittorrent 或 aria2');

  if (type === 'qbittorrent') {
    let cookie = null;
    const login = async () => {
      const response = await fetcher(`${base}/api/v2/auth/login`, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          username: env.DOWNLOADER_USER || 'admin',
          password: env.DOWNLOADER_PASSWORD || '',
        }),
      });
      const text = await response.text();
      const setCookie = response.headers.getSetCookie?.() || [];
      cookie = setCookie.map((entry) => entry.split(';')[0]).join('; ') || null;
      if (!response.ok || !cookie || !text.includes('Ok'))
        throw new Error('qBittorrent 登录失败，请检查地址与账号密码');
    };
    const add = async (magnet) => {
      const response = await fetcher(`${base}/api/v2/torrents/add`, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: new URLSearchParams({ urls: magnet }),
      });
      return response;
    };
    return {
      name: 'qBittorrent',
      async push(value) {
        const magnet = parseMagnet(value).magnet;
        if (!cookie) await login();
        let response = await add(magnet);
        if (response.status === 403) {
          cookie = null;
          await login();
          response = await add(magnet);
        }
        const text = await response.text();
        if (!response.ok || !text.includes('Ok'))
          throw new Error(`qBittorrent 返回 HTTP ${response.status}`);
      },
    };
  }

  return {
    name: 'aria2',
    async push(value) {
      const parsed = parseMagnet(value);
      const params = [[parsed.magnet]];
      if (env.DOWNLOADER_TOKEN) params.unshift(`token:${env.DOWNLOADER_TOKEN}`);
      const response = await fetcher(`${base}/jsonrpc`, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'free-bt',
          method: 'aria2.addUri',
          params,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.error)
        throw new Error(data?.error?.message || `aria2 返回 HTTP ${response.status}`);
    },
  };
}
