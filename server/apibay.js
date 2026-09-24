import { fetchBytes } from './providers.js';
import { makeMagnet, normalizeHash } from './torrent.js';
import { matchesName } from './names.js';

const numeric = (value) =>
  value !== null &&
  value !== undefined &&
  value !== '' &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) >= 0
    ? Number(value)
    : null;
function categoryOf(value) {
  const category = Number(value);
  if (category === 601) return 'books';
  if (category >= 100 && category < 200) return 'audio';
  if (category >= 200 && category < 300) return 'video';
  if (category >= 300 && category < 500) return 'software';
  return 'other';
}
function resource(row) {
  if (!row || !/^[1-9]\d{0,11}$/.test(String(row.id))) return null;
  let hash;
  try {
    hash = normalizeHash(row.info_hash);
  } catch {
    return null;
  }
  if (/^0+$/.test(hash) || typeof row.name !== 'string' || !row.name.trim()) return null;
  const time = Number(row.added) * 1000;
  return {
    id: `apibay:${row.id}`,
    source: 'apibay',
    sourceName: 'ApiBay · BT 索引',
    name: row.name.slice(0, 1000),
    hash,
    magnet: makeMagnet(hash, row.name),
    category: categoryOf(row.category),
    size: numeric(row.size),
    seeders: numeric(row.seeders),
    fileCount: numeric(row.num_files),
    added: Number.isFinite(time) && time > 0 && time < 8.64e15 ? new Date(time).toISOString() : '',
    sourceUrl: `https://thepiratebay.org/description.php?id=${row.id}`,
  };
}

export function createApiBayProvider(fetcher = fetch) {
  const read = async (path) =>
    JSON.parse(
      (
        await fetchBytes(`https://apibay.org/${path}`, {
          fetcher,
          timeout: 12000,
          max: 2 * 1024 * 1024,
        })
      ).toString(),
    );
  return {
    id: 'apibay',
    name: 'ApiBay · BT 索引',
    kind: 'bt-index',
    description: '公开 BT 资源索引，提供磁力与来源报告的文件清单；名称以英文为主。',
    validId: (id) => /^[1-9]\d{0,11}$/.test(id),
    async search({ q, category, page, limit, sort, phrase = false }) {
      const cat =
        { video: '200', audio: '100', software: '300,400', books: '601', other: '600' }[category] ||
        '0';
      const rows = await read(`q.php?${new URLSearchParams({ q, cat })}`);
      if (!Array.isArray(rows)) throw new Error('BT 索引返回格式无效');
      // ApiBay can ignore unsupported scripts and return trending torrents. Never treat those as matches.
      const mapped = rows.slice(0, 100).map(resource).filter(Boolean);
      const matching = mapped.filter(
        (item) =>
          (category === 'all' || category === item.category) && matchesName(item.name, q, phrase),
      );
      const unique = [...new Map(matching.map((item) => [item.hash, item])).values()];
      if (sort === 'newest')
        unique.sort((a, b) => (Date.parse(b.added) || 0) - (Date.parse(a.added) || 0));
      const offset = (page - 1) * limit;
      const notes = [];
      if (mapped.length > matching.length)
        notes.push(`已排除 ${mapped.length - matching.length} 条不匹配的上游结果`);
      if (rows.length >= 100) notes.push('此来源最多检索前 100 条候选');
      return {
        items: unique.slice(offset, offset + limit),
        total: unique.length,
        hasMore: offset + limit < unique.length,
        note: notes.join('；') || undefined,
      };
    },
    async detail(id) {
      if (!/^[1-9]\d{0,11}$/.test(id)) throw new Error('BT 资源编号无效');
      const item = resource(await read(`t.php?id=${id}`));
      if (!item || item.id !== `apibay:${id}`) return null;
      try {
        const rows = await read(`f.php?id=${id}`);
        if (!Array.isArray(rows)) throw new Error('文件清单无效');
        item.files = rows
          .slice(0, 2000)
          .map((file) => ({
            name: Array.isArray(file.name) ? file.name.join('/') : String(file.name || ''),
            size: numeric(Array.isArray(file.size) ? file.size[0] : file.size),
          }))
          .filter((file) => file.name && file.size !== null);
        item.fileListSource = '上游索引报告，未读取种子原始字节核验';
      } catch {
        item.detailNote = '磁力可用，文件清单暂时无法读取';
      }
      return item;
    },
  };
}
