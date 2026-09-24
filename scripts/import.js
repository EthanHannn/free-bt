import { readFile } from 'node:fs/promises';
import { createStore } from '../server/store.js';
import { parseTorrent } from '../server/torrent.js';

const filename = process.argv[2];
if (!filename) {
  console.error(
    '用法：npm run import -- <magnets.txt | resources.json | file.torrent> [video|audio|books|software|other]',
  );
  process.exit(1);
}
const store = createStore(process.env.DATA_DIR);
try {
  const buffer = await readFile(filename);
  const category = process.argv[3] || 'other';
  const entries = filename.endsWith('.torrent')
    ? [{ ...parseTorrent(buffer), category }]
    : filename.endsWith('.json')
      ? JSON.parse(buffer.toString('utf8'))
      : buffer
          .toString('utf8')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'))
          .map((magnet) => ({ magnet, category }));
  if (!Array.isArray(entries)) throw new Error('JSON 顶层需要是资源数组');
  let count = 0,
    failed = 0;
  for (const [index, entry] of entries.entries()) {
    try {
      store.put(entry);
      count++;
    } catch (error) {
      failed++;
      console.error(`第 ${index + 1} 条导入失败：${error.message}`);
    }
  }
  console.log(
    `已导入 ${count} 条，失败 ${failed} 条，资源库共 ${store.count()} 条（相同 hash 自动合并）。`,
  );
  if (failed) process.exitCode = 1;
} catch (error) {
  console.error(`导入失败：${error.message}`);
  process.exitCode = 1;
} finally {
  store.close();
}
