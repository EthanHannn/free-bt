import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseMagnet } from './torrent.js';

export const categories = {
  all: '全部',
  video: '视频',
  audio: '音频',
  books: '书籍',
  software: '软件',
  other: '其他',
};

export function createStore(directory = './data') {
  if (directory !== ':memory:') mkdirSync(resolve(directory), { recursive: true });
  const db = new DatabaseSync(
    directory === ':memory:' ? directory : resolve(directory, 'free-bt.sqlite'),
  );
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS resources (
      hash TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
      size INTEGER, added TEXT NOT NULL, payload TEXT NOT NULL
    );`);
  return {
    put(input) {
      const parsed = parseMagnet(input.magnet);
      const category =
        Object.hasOwn(categories, input.category) && input.category !== 'all'
          ? input.category
          : 'other';
      const item = {
        ...input,
        ...parsed,
        name: String(input.name || parsed.name).slice(0, 500),
        category,
        id: `local:${parsed.hash}`,
        source: 'local',
        sourceName: '本地资源库',
        size: Number.isSafeInteger(input.size) && input.size >= 0 ? input.size : null,
        added: new Date().toISOString(),
        seeders: null,
      };
      db.prepare(
        'INSERT INTO resources VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(hash) DO UPDATE SET name=excluded.name, category=excluded.category, size=excluded.size, added=excluded.added, payload=excluded.payload',
      ).run(item.hash, item.name, item.category, item.size, item.added, JSON.stringify(item));
      return item;
    },
    count() {
      return db.prepare('SELECT COUNT(*) AS count FROM resources').get().count;
    },
    get(hash) {
      const row = db.prepare('SELECT payload FROM resources WHERE hash=?').get(hash);
      return row ? JSON.parse(row.payload) : null;
    },
    search({ q, category, page, limit, sort }) {
      const parts = q.normalize('NFKC').trim().split(/\s+/u).filter(Boolean);
      const where = parts.map(() => "(name LIKE ? ESCAPE '\\' OR hash LIKE ? ESCAPE '\\')");
      const args = parts.flatMap((part) => {
        const value = `%${part.replace(/[\\%_]/g, '\\$&')}%`;
        return [value, value];
      });
      if (category !== 'all') {
        where.push('category=?');
        args.push(category);
      }
      const condition = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db
        .prepare(`SELECT COUNT(*) AS count FROM resources ${condition}`)
        .get(...args).count;
      const order =
        sort === 'newest' ? 'added DESC, hash ASC' : 'name COLLATE NOCASE ASC, hash ASC';
      const items = db
        .prepare(`SELECT payload FROM resources ${condition} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(...args, limit, (page - 1) * limit)
        .map((row) => JSON.parse(row.payload));
      return { items, total, hasMore: page * limit < total };
    },
    close() {
      db.close();
    },
  };
}
