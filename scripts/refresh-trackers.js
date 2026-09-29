import { refreshTrackers, TRACKERS_URL } from '../server/trackers.js';

const file = `${process.env.DATA_DIR || './data'}/trackers.txt`;
const url = process.env.TRACKERS_URL || TRACKERS_URL;
try {
  const list = await refreshTrackers(file, { url });
  console.log(`Tracker 榜单已更新：${list.length} 条 → ${file}`);
} catch (error) {
  console.error(`Tracker 榜单刷新失败：${error.message}（保留现有榜单）`);
  process.exitCode = 1;
}
