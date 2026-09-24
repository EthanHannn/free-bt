import { Converter } from 'opencc-js';
import { fetchBytes } from './providers.js';

const simplify = Converter({ from: 't', to: 'cn' });
const traditional = Converter({ from: 'cn', to: 't' });
export const simplified = (value) => simplify(String(value).normalize('NFKC'));
export const normalizedTitle = (value) =>
  simplified(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
const bareTitle = (value) => value.replace(/\s*[（(][^()（）]*[）)]\s*$/u, '').trim();

export function matchesName(name, query, phrase = false) {
  const title = normalizedTitle(name);
  if (phrase) return title.includes(normalizedTitle(query));
  const words =
    simplified(query)
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) || [];
  return words.length > 0 && words.every((word) => title.includes(word));
}

export function basicNames(q) {
  return {
    original: q,
    queries: [...new Set([q, simplified(q), traditional(simplified(q))])],
    status: 'literal',
    candidates: [],
  };
}

export function createNameResolver({ fetcher = fetch, ttl = 24 * 60 * 60_000 } = {}) {
  const cache = new Map(),
    inflight = new Map();
  return async function resolveNames(q) {
    const base = basicNames(q);
    if (!/\p{Script=Han}/u.test(q) || normalizedTitle(q).length < 2 || q.length > 80) return base;
    const key = normalizedTitle(q);
    const cached = cache.get(key);
    if (cached?.expires > Date.now())
      return {
        ...cached.value,
        original: q,
        queries: [
          ...new Set([q, ...(cached.value.english ? [cached.value.english] : []), ...base.queries]),
        ].slice(0, 3),
      };
    if (inflight.has(q)) return inflight.get(q);
    const promise = (async () => {
      try {
        const params = new URLSearchParams({
          action: 'query',
          generator: 'search',
          gsrsearch: q,
          gsrlimit: '5',
          prop: 'langlinks|pageprops',
          lllang: 'en',
          lllimit: '5',
          ppprop: 'disambiguation',
          formatversion: '2',
          format: 'json',
        });
        const data = JSON.parse(
          (
            await fetchBytes(`https://zh.wikipedia.org/w/api.php?${params}`, {
              fetcher,
              timeout: 5000,
              max: 256 * 1024,
            })
          ).toString(),
        );
        if (data.error || (!data.query && !Object.hasOwn(data, 'batchcomplete')))
          throw new Error('名称资料响应无效');
        const pages = (data.query?.pages || []).filter(
          (page) =>
            typeof page.title === 'string' &&
            page.title.length <= 160 &&
            Number.isSafeInteger(page.pageid) &&
            page.pageid > 0 &&
            !Object.hasOwn(page.pageprops || {}, 'disambiguation'),
        );
        const candidates = pages
          .map((page) => ({
            title: page.title,
            english: page.langlinks?.find((link) => link.lang === 'en')?.title || '',
            url: `https://zh.wikipedia.org/?curid=${Number(page.pageid)}`,
            key: normalizedTitle(bareTitle(page.title)),
            index: page.index || 99,
          }))
          .filter(
            (page) =>
              page.key === key ||
              (key.length >= 4 && page.key.includes(key) && key.length / page.key.length >= 0.5),
          )
          .sort((a, b) => a.index - b.index);
        const exact = candidates.filter(
          (page) =>
            page.key === key &&
            typeof page.english === 'string' &&
            page.english.length > 0 &&
            page.english.length <= 160,
        );
        let result = { ...base, candidates: candidates.slice(0, 3) };
        // Never silently choose between works with the same title or a sequel.
        if (exact.length === 1) {
          const match = exact[0];
          const english = bareTitle(match.english);
          result = {
            ...result,
            status: 'resolved',
            title: match.title,
            english,
            sourceName: '中文维基百科语言链接',
            sourceUrl: match.url,
            queries: [...new Set([q, english, ...base.queries])].slice(0, 3),
            candidates: [],
          };
        } else if (candidates.length) result.status = 'ambiguous';
        cache.set(key, { value: result, expires: Date.now() + ttl });
        if (cache.size > 200) cache.delete(cache.keys().next().value);
        return result;
      } catch {
        return {
          ...base,
          status: 'unavailable',
          note: '片名资料暂时不可用，已按输入名称继续搜索。',
        };
      }
    })();
    inflight.set(q, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(q);
    }
  };
}
