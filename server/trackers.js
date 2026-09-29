// Append well-known public trackers (ngosang/trackerslist) to outgoing magnets
// so DHT-sourced releases with few reported seeds can still find peers.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const TRACKERS_URL =
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt';
export const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const TRACKER_LINE = /^(https?|udp|wss):\/\/\S+$/i;

export function parseTrackerList(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => TRACKER_LINE.test(line));
}

// Idempotent: keeps existing tr params, appends missing list entries, caps the
// total. Unparseable input is returned untouched.
export function enrichMagnet(magnet, trackers, cap = 25) {
  try {
    const url = new URL(magnet);
    if (url.protocol !== 'magnet:') return magnet;
    const merged = url.searchParams.getAll('tr').filter((v) => TRACKER_LINE.test(v));
    for (const tracker of trackers || []) if (!merged.includes(tracker)) merged.push(tracker);
    url.searchParams.delete('tr');
    for (const tracker of merged.slice(0, cap)) url.searchParams.append('tr', tracker);
    return url.href.replace('xt=urn%3Abtih%3A', 'xt=urn:btih:');
  } catch {
    return magnet;
  }
}

// Validate, then atomically replace the tracker list file.
export async function refreshTrackers(
  file,
  { url = TRACKERS_URL, fetcher = fetch, timeout = 15000 } = {},
) {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { 'User-Agent': 'FreeBT/0.1 (personal search)' },
  });
  if (!response.ok) throw new Error(`榜单上游返回 HTTP ${response.status}`);
  const list = parseTrackerList(await response.text());
  if (list.length < 10) throw new Error('榜单上游内容无效');
  const content = `# ${url}\n# 更新于 ${new Date().toISOString()}\n${list.join('\n')}\n`;
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, content);
  renameSync(temporary, file);
  return list;
}

export function createTrackers({
  file,
  fallbackFile = new URL('./trackers.txt', import.meta.url),
  url = TRACKERS_URL,
  fetcher = fetch,
} = {}) {
  let trackers = [];
  let loadedMtime = 0;
  const candidates = () => [file, fallbackFile].filter(Boolean);
  const load = () => {
    for (const candidate of candidates()) {
      try {
        const list = parseTrackerList(readFileSync(candidate, 'utf8'));
        if (list.length) {
          trackers = list;
          loadedMtime = statSync(candidate).mtimeMs;
          return;
        }
      } catch {
        // Missing or unreadable: try the next candidate.
      }
    }
  };
  load();
  const list = () => {
    // Pick up refreshes without a restart.
    let newest = 0;
    for (const candidate of candidates()) {
      try {
        newest = Math.max(newest, statSync(candidate).mtimeMs);
      } catch {
        // Absent files cannot make the list newer.
      }
    }
    if (newest > loadedMtime) load();
    return trackers;
  };
  return {
    list,
    enrich: (magnet) => enrichMagnet(magnet, list()),
    // Best-effort weekly refresh; failures keep the current list silently.
    async refreshIfStale() {
      let stale = true;
      if (file)
        try {
          stale = Date.now() - statSync(file).mtimeMs > STALE_MS;
        } catch {
          stale = true;
        }
      if (!stale) return false;
      await refreshTrackers(file, { url, fetcher });
      load();
      return true;
    },
  };
}
