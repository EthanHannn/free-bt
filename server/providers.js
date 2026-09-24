import { XMLParser } from 'fast-xml-parser';
import { makeMagnet, normalizeHash, parseMagnet, parseTorrent } from './torrent.js';

const mediaTypes = { video: 'movies', audio: 'audio', books: 'texts', software: 'software' };
const mediaCategories = {
  movies: 'video',
  audio: 'audio',
  etree: 'audio',
  texts: 'books',
  software: 'software',
};
const list = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);
const string = (value) => (Array.isArray(value) ? String(value[0] ?? '') : String(value ?? ''));
const number = (value) =>
  value !== undefined &&
  value !== null &&
  value !== '' &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0
    ? Number(value)
    : null;
export function webUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export async function fetchBytes(
  url,
  { timeout = 18000, max = 8 * 1024 * 1024, fetcher = fetch } = {},
) {
  const signal = AbortSignal.timeout(timeout);
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetcher(url, {
        signal,
        headers: { 'User-Agent': 'FreeBT/0.1 (personal search)' },
      });
    } catch (error) {
      if (attempt || signal.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
      continue;
    }
    if (!attempt && [408, 429, 500, 502, 503, 504].includes(response.status)) {
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 200));
      continue;
    }
    break;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`上游返回 HTTP ${response.status}`);
  }
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel();
    throw new Error('上游响应过大');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error('上游响应过大');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

export function createArchiveProvider(fetcher = fetch) {
  return {
    id: 'archive',
    name: 'Internet Archive',
    description: '公开档案中的种子资源，覆盖影像、音频、书籍和软件。',
    async search({ q, category, page, limit, sort }) {
      // Quote each term so user input cannot inject the upstream query language.
      const terms = q
        .normalize('NFKC')
        .trim()
        .split(/\s+/u)
        .filter(Boolean)
        .map((v) => `"${v.replace(/[\\"]/g, '\\$&')}"`)
        .join(' AND ');
      const clauses = [
        `(title:(${terms}) OR identifier:(${terms}) OR subject:(${terms}))`,
        'format:"Archive BitTorrent"',
        '-mediatype:collection',
      ];
      if (mediaTypes[category]) clauses.push(`mediatype:${mediaTypes[category]}`);
      if (category === 'other')
        clauses.push('-mediatype:(movies OR audio OR etree OR texts OR software)');
      const params = new URLSearchParams({
        q: clauses.filter(Boolean).join(' AND '),
        output: 'json',
        rows: String(limit),
        page: String(page),
      });
      ['identifier', 'title', 'mediatype', 'publicdate', 'item_size'].forEach((field) =>
        params.append('fl[]', field),
      );
      if (sort === 'newest') params.set('sort[]', 'publicdate desc');
      const data = JSON.parse(
        (
          await fetchBytes(`https://archive.org/advancedsearch.php?${params}`, { fetcher })
        ).toString(),
      );
      if (!Array.isArray(data.response?.docs)) throw new Error('上游搜索响应无效');
      const items = data.response.docs
        .filter((doc) => /^[a-zA-Z0-9_.-]+$/.test(doc.identifier))
        .map((doc) => ({
          id: `archive:${doc.identifier}`,
          source: 'archive',
          sourceName: 'Internet Archive',
          name: string(doc.title) || doc.identifier,
          category: mediaCategories[string(doc.mediatype)] || 'other',
          size: number(doc.item_size),
          sizeScope: 'archive',
          added: string(doc.publicdate),
          seeders: null,
          hash: null,
          magnet: null,
          sourceUrl: `https://archive.org/details/${encodeURIComponent(doc.identifier)}`,
        }));
      const total = number(data.response.numFound) ?? 0;
      return { items, total, hasMore: page * limit < total };
    },
    async detail(identifier) {
      if (!/^[a-zA-Z0-9_.-]{1,200}$/.test(identifier)) throw new Error('资源编号无效');
      const metadata = JSON.parse(
        (await fetchBytes(`https://archive.org/metadata/${identifier}`, { fetcher })).toString(),
      );
      const torrent = metadata.files?.find(
        (file) => file.format === 'Archive BitTorrent' && file.name?.endsWith('.torrent'),
      );
      if (!torrent) throw new Error('该档案暂时没有可用的种子文件，请查看原始页面');
      const torrentUrl = `https://archive.org/download/${identifier}/${encodeURIComponent(torrent.name)}`;
      const parsed = parseTorrent(await fetchBytes(torrentUrl, { fetcher }));
      parsed.magnet += `&xs=${encodeURIComponent(torrentUrl)}`;
      return {
        ...parsed,
        id: `archive:${identifier}`,
        source: 'archive',
        sourceName: 'Internet Archive',
        name: string(metadata.metadata?.title) || parsed.name,
        category: mediaCategories[string(metadata.metadata?.mediatype)] || 'other',
        added: string(metadata.metadata?.publicdate),
        seeders: null,
        torrentUrl,
        sourceUrl: `https://archive.org/details/${identifier}`,
      };
    },
  };
}

export function createTorznabProvider({ url, key, name = '我的索引器', fetcher = fetch }) {
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol))
    throw new Error('TORZNAB_URL 需要 HTTP(S) 地址');
  const cache = new Map();
  return {
    id: 'torznab',
    name,
    description: '通过 Prowlarr / Jackett 接入你配置的索引器。',
    async search({ q, category, page, limit, sort }) {
      const target = new URL(endpoint);
      Object.entries({
        t: 'search',
        apikey: key || '',
        q,
        offset: String((page - 1) * limit),
        limit: String(limit),
      }).forEach(([k, v]) => target.searchParams.set(k, v));
      const cats = {
        video: '2000,5000',
        audio: '3000',
        books: '7000',
        software: '4000',
        other: '8000',
      };
      if (cats[category]) target.searchParams.set('cat', cats[category]);
      const xml = (await fetchBytes(target, { fetcher })).toString();
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('索引器返回了不支持的 XML');
      const data = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        parseTagValue: false,
      }).parse(xml);
      if (!data.rss?.channel) throw new Error('索引器响应无效，请检查地址和 API Key');
      const channel = data.rss.channel;
      const rows = list(channel.item);
      let skipped = 0;
      let items = rows
        .map((row) => {
          const attrs = Object.fromEntries(
            list(row['torznab:attr']).map((a) => [a['@_name'], a['@_value']]),
          );
          let magnet;
          try {
            const link = [attrs.magneturl, row.link, row.enclosure?.['@_url']].find((v) =>
              String(v).startsWith('magnet:'),
            );
            magnet = link ? parseMagnet(link) : { hash: normalizeHash(attrs.infohash) };
          } catch {
            skipped++;
            return null;
          }
          const title = string(row.title) || magnet.name || magnet.hash;
          const cat = Number(
            list(row['torznab:attr']).find((a) => a['@_name'] === 'category')?.['@_value'] ||
              row.category,
          );
          const resolvedCategory =
            cat >= 7000 && cat < 8000
              ? 'books'
              : (cat >= 5000 && cat < 6000) || (cat >= 2000 && cat < 3000)
                ? 'video'
                : cat >= 3000 && cat < 4000
                  ? 'audio'
                  : cat >= 4000 && cat < 5000
                    ? 'software'
                    : 'other';
          const item = {
            id: `torznab:${magnet.hash}`,
            hash: magnet.hash,
            magnet: magnet.magnet || makeMagnet(magnet.hash, title),
            name: title,
            source: 'torznab',
            sourceName: name,
            category: resolvedCategory,
            size: number(row.size ?? row.enclosure?.['@_length'] ?? attrs.size),
            seeders: number(attrs.seeders),
            added: string(row.pubDate),
            sourceUrl: null,
          };
          cache.set(item.hash, item);
          if (cache.size > 2000) cache.delete(cache.keys().next().value);
          return item;
        })
        .filter(Boolean);
      if (sort === 'newest')
        items.sort((a, b) => (Date.parse(b.added) || 0) - (Date.parse(a.added) || 0));
      const total = number(
        channel['torznab:response']?.['@_total'] ?? channel['newznab:response']?.['@_total'],
      );
      return {
        items,
        total,
        hasMore: total === null ? rows.length >= limit : page * limit < total,
        note: skipped ? `${skipped} 条结果未提供磁力或 info hash，已略过` : undefined,
      };
    },
    async detail(hash) {
      const item = cache.get(normalizeHash(hash));
      if (!item) throw new Error('搜索记录已过期，请重新搜索');
      return item;
    },
  };
}
