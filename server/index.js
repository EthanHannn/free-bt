import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createStore } from './store.js';
import { createArchiveProvider, createTorznabProvider } from './providers.js';
import { createSearch, searchParams } from './search.js';
import { createApiBayProvider } from './apibay.js';

const publicDir = new URL('../public/', import.meta.url);
const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

export function createApp({ store = createStore(process.env.DATA_DIR), externalProviders } = {}) {
  const providers = [
    {
      id: 'local',
      name: '本地资源库',
      description: '你导入的磁力与种子，保存在本机，按哈希去重。',
      search: (query) => store.search(query),
      detail: (hash) => store.get(hash),
    },
  ];
  if (externalProviders) providers.push(...externalProviders);
  else {
    if (process.env.APIBAY_ENABLED !== 'false') providers.push(createApiBayProvider());
    if (process.env.ARCHIVE_ENABLED !== 'false') providers.push(createArchiveProvider());
    if (process.env.TORZNAB_URL)
      providers.push(
        createTorznabProvider({
          url: process.env.TORZNAB_URL,
          key: process.env.TORZNAB_API_KEY,
          name: process.env.TORZNAB_NAME,
        }),
      );
  }
  const search = createSearch(providers);
  const details = new Map();
  const detailInflight = new Map();
  const clients = new Map();
  let active = 0;
  const json = (res, status, data) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
  };
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    let counted = false;
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD');
        return json(res, 405, { error: '不支持的请求方法' });
      }
      if (url.pathname.startsWith('/api/')) {
        const now = Date.now();
        const address = req.socket.remoteAddress;
        const client = clients.get(address);
        if (!client || client.reset <= now) clients.set(address, { count: 1, reset: now + 60_000 });
        else if (++client.count > 90) {
          res.setHeader('Retry-After', '60');
          return json(res, 429, { error: '请求过于频繁，请稍后再试' });
        }
        if (clients.size > 1000)
          for (const [key, value] of clients) if (value.reset <= now) clients.delete(key);
        if (url.pathname === '/api/health') return json(res, 200, { status: 'ok' });
        if (url.pathname === '/api/sources')
          return json(res, 200, {
            sources: providers.map((p) => ({
              id: p.id,
              name: p.name,
              description: p.description,
              count: p.id === 'local' ? store.count() : null,
              kind: p.kind || (p.id === 'torznab' ? 'bt-index' : p.id),
            })),
            torznabConfigured: providers.some((p) => p.id === 'torznab'),
          });
        if (active >= 16) return json(res, 503, { error: '正在处理较多搜索，请稍后重试' });
        active++;
        counted = true;
        if (url.pathname === '/api/search') {
          let query;
          try {
            query = searchParams(url.searchParams);
          } catch (error) {
            return json(res, 400, { error: error.message });
          }
          if (!providers.some((p) => query.source === 'all' || p.id === query.source))
            return json(res, 400, { error: '该数据源尚未启用' });
          const result = await search(query);
          return json(res, result.failed ? 502 : 200, result);
        }
        if (url.pathname === '/api/resource') {
          const id = url.searchParams.get('id') || '';
          if (!/^[a-z][a-z0-9-]{0,30}:[a-zA-Z0-9_.-]{1,200}$/.test(id))
            return json(res, 400, { error: '资源编号无效' });
          const split = id.indexOf(':');
          const provider = providers.find((p) => p.id === id.slice(0, split));
          if (!provider) return json(res, 404, { error: '数据源未启用' });
          const resourceId = id.slice(split + 1);
          const validId =
            provider.validId ||
            (provider.id === 'archive'
              ? (value) => /^[a-zA-Z0-9_.-]{1,200}$/.test(value)
              : (value) => /^[a-f\d]{40}$/.test(value));
          if (!validId(resourceId)) return json(res, 400, { error: '资源编号无效' });
          let detail = details.get(id);
          if (!detail || detail.expires <= Date.now()) {
            let promise = detailInflight.get(id);
            if (!promise) {
              promise = Promise.resolve().then(() => provider.detail(id.slice(split + 1)));
              detailInflight.set(id, promise);
            }
            let item;
            try {
              item = await promise;
            } finally {
              detailInflight.delete(id);
            }
            if (!item) return json(res, 404, { error: '资源不存在' });
            detail = { item, expires: Date.now() + 10 * 60_000 };
            details.set(id, detail);
            if (details.size > 200) details.delete(details.keys().next().value);
          }
          return json(res, 200, detail.item);
        }
        return json(res, 404, { error: '接口不存在' });
      }
      const asset = assets[url.pathname];
      if (!asset) return json(res, 404, { error: '页面不存在' });
      const data = await readFile(new URL(asset[0], publicDir));
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      if (!res.headersSent)
        json(res, 502, { error: '暂时无法读取资源，请检查数据源连接后重试，或访问原始页面' });
      else res.end();
    } finally {
      if (counted) active--;
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return { server, store };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { server, store } = createApp();
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3210);
  server.listen(port, host, () => console.log(`自由 BT 已启动：http://${host}:${port}`));
  server.on('error', (error) => {
    console.error(`启动失败：${error.code || 'UNKNOWN'}`);
    store.close();
    process.exitCode = 1;
  });
  const close = () =>
    server.close(() => {
      store.close();
      process.exit(0);
    });
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
