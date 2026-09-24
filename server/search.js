import { categories } from './store.js';
import { basicNames, matchesName } from './names.js';

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
  return { q, category, sort, source, page, limit: 20, literal: params.get('literal') === '1' };
}

export function createSearch(
  providers,
  ttl = 120_000,
  { resolveNames = async (q) => basicNames(q) } = {},
) {
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
      const request = async (provider, term, phrase = false) => {
        try {
          return { term, result: await provider.search({ ...query, q: term, phrase }) };
        } catch {
          return { term, error: true };
        }
      };
      const primary = new Map(chosen.map((provider) => [provider.id, request(provider, query.q)]));
      const naming =
        !query.literal &&
        chosen.some((provider) => provider.id !== 'local') &&
        ['all', 'video'].includes(query.category)
          ? await resolveNames(query.q)
          : basicNames(query.q);
      const terms = [...new Set([query.q, ...(naming.queries || [])])]
        .filter((term) => typeof term === 'string' && term.length > 0 && term.length <= 160)
        .slice(0, 3);
      const results = await Promise.all(
        chosen.map(async (provider) => {
          const responses = await Promise.all(
            terms.map((term) =>
              term === query.q
                ? primary.get(provider.id)
                : request(provider, term, naming.status === 'resolved'),
            ),
          );
          const merged = new Map();
          for (const { term, result } of responses) {
            for (const item of result?.items || []) {
              if (
                !matchesName(item.name || '', term, naming.status === 'resolved') &&
                item.hash?.toLowerCase() !== term.toLowerCase()
              )
                continue;
              const identity = item.hash || item.id;
              const previous = merged.get(identity);
              if (previous)
                previous.matchedQueries = [...new Set([...previous.matchedQueries, term])];
              else merged.set(identity, { ...item, matchedQueries: [term] });
            }
          }
          const failures = responses.filter((response) => response.error).length;
          return {
            provider,
            items: [...merged.values()],
            state: failures === responses.length ? 'error' : failures ? 'partial' : 'ok',
            total: terms.length === 1 ? (responses[0].result?.total ?? null) : null,
            hasMore: responses.some((response) => response.result?.hasMore),
            note:
              [...new Set(responses.map((response) => response.result?.note).filter(Boolean))].join(
                '；',
              ) || undefined,
          };
        }),
      );
      const unique = new Map();
      const sources = results.map(({ provider, items, state, total, hasMore, note }) => {
        for (const item of items) {
          const identity = item.hash || item.id;
          const previous = unique.get(identity);
          if (previous) {
            previous.sources = [...new Set([...previous.sources, item.sourceName])];
            previous.matchedQueries = [
              ...new Set([...previous.matchedQueries, ...item.matchedQueries]),
            ];
          } else unique.set(identity, { ...item, sources: [item.sourceName] });
        }
        return {
          id: provider.id,
          name: provider.name,
          state,
          error: state !== 'ok' ? '部分查询连接失败或超时，请重试或检查来源配置' : undefined,
          count: items.length,
          total,
          hasMore,
          note,
        };
      });
      const items = [...unique.values()];
      if (query.sort === 'newest')
        items.sort((a, b) => (Date.parse(b.added) || 0) - (Date.parse(a.added) || 0));
      else
        items.sort(
          (a, b) =>
            Number(Boolean(b.magnet)) - Number(Boolean(a.magnet)) ||
            (b.seeders ?? -1) - (a.seeders ?? -1),
        );
      const value = {
        items,
        sources,
        naming: { ...naming, queries: terms },
        page: query.page,
        hasMore: sources.some((s) => s.hasMore) && query.page < 100,
        failed: sources.every((s) => s.state === 'error'),
        partial: sources.some((s) => s.state !== 'ok'),
        elapsed: Math.round(performance.now() - start),
        cached: false,
      };
      // Failures must be retryable immediately.
      if (!value.partial && naming.status !== 'unavailable') {
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
