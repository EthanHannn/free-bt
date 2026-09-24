import { categories } from './store.js';

export function searchParams(params) {
  const q = (params.get('q') || '').normalize('NFKC').trim();
  if (!q || q.length > 160) throw new Error('请输入 1–160 个字符的关键词');
  const category = params.get('category') || 'all';
  const sort = params.get('sort') || 'relevance';
  const source = params.get('source') || 'all';
  const page = Number(params.get('page') || 1);
  if (
    !Object.hasOwn(categories, category) ||
    !['relevance', 'newest'].includes(sort) ||
    !/^[a-z][a-z0-9-]{0,30}$/.test(source)
  )
    throw new Error('筛选条件无效');
  if (!Number.isInteger(page) || page < 1 || page > 100) throw new Error('页码需要在 1–100 之间');
  return { q, category, sort, source, page, limit: 20 };
}

export function createSearch(providers, ttl = 120_000) {
  const cache = new Map();
  const inflight = new Map();
  return async function search(query) {
    const chosen = providers.filter((p) => query.source === 'all' || p.id === query.source);
    if (!chosen.length) throw new Error('该数据源尚未启用');
    const key = JSON.stringify(query);
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return { ...cached.value, cached: true };
    if (inflight.has(key)) return inflight.get(key);
    const run = (async () => {
      const start = performance.now();
      const results = await Promise.all(
        chosen.map(async (provider) => {
          try {
            return { provider, result: await provider.search(query) };
          } catch {
            return { provider, error: '连接失败或超时，请检查网络、代理和数据源配置后重试' };
          }
        }),
      );
      const unique = new Map();
      const sources = results.map(({ provider, result, error }) => {
        for (const item of result?.items || []) {
          const identity = item.hash || item.id;
          const previous = unique.get(identity);
          if (previous) previous.sources = [...new Set([...previous.sources, item.sourceName])];
          else unique.set(identity, { ...item, sources: [item.sourceName] });
        }
        return {
          id: provider.id,
          name: provider.name,
          state: error ? 'error' : 'ok',
          error,
          count: result?.items.length || 0,
          total: result?.total ?? null,
          hasMore: result?.hasMore || false,
          note: result?.note,
        };
      });
      const items = [...unique.values()];
      if (query.sort === 'newest')
        items.sort((a, b) => (Date.parse(b.added) || 0) - (Date.parse(a.added) || 0));
      const value = {
        items,
        sources,
        page: query.page,
        hasMore: sources.some((s) => s.hasMore) && query.page < 100,
        failed: sources.every((s) => s.state === 'error'),
        partial: sources.some((s) => s.state === 'error'),
        elapsed: Math.round(performance.now() - start),
        cached: false,
      };
      // Failures must be retryable immediately.
      if (!value.partial) {
        cache.set(key, { value, expires: Date.now() + ttl });
        if (cache.size > 100) cache.delete(cache.keys().next().value);
      }
      return value;
    })();
    inflight.set(key, run);
    try {
      return await run;
    } finally {
      inflight.delete(key);
    }
  };
}
