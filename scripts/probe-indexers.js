// Probe candidate public Jackett indexers: add each one, run a test search,
// keep the ones that return results and remove the rest.
// Usage: npm run probe-indexers
import { XMLParser } from 'fast-xml-parser';

// Public, login-free definitions likely to work without special network routes.
// Known-bad ones (Cloudflare-blocked or dead) are listed in the project docs.
const CANDIDATES = [
  'btdirectory',
  'torrentdownloads',
  'extratorrent-st',
  'bitsearch',
  'bt4g',
  'btdig',
];
const TEST_QUERY = 'ubuntu';

const torznab = process.env.TORZNAB_URL;
const base = (process.env.JACKETT_URL || (torznab && new URL(torznab).origin) || 'http://127.0.0.1:9117').replace(/\/$/, '');
const key = process.env.JACKETT_API_KEY || process.env.TORZNAB_API_KEY;
if (!key) {
  console.error('需要 JACKETT_API_KEY 或 TORZNAB_API_KEY（Jackett 面板右上角）。');
  process.exit(1);
}

let cookie = '';
async function login() {
  const response = await fetch(`${base}/UI/Dashboard`, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(process.env.JACKETT_PASSWORD || '')}`,
  });
  await response.body?.cancel();
  cookie = (response.headers.getSetCookie?.() || [])
    .map((entry) => entry.split(';')[0])
    .join('; ');
  if (!cookie) throw new Error('Jackett 登录未返回 Cookie（需要 JACKETT_PASSWORD？）');
}

async function call(method, path, body, timeout = 30_000) {
  const url = `${base}${path}${path.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(key)}`;
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(timeout),
    headers: {
      Cookie: cookie,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${text.slice(0, 120)}`);
  return text;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
async function testSearch(id) {
  const xml = await call(
    'GET',
    `/api/v2.0/indexers/${id}/results/torznab/api?t=search&q=${encodeURIComponent(TEST_QUERY)}`,
    null,
    25_000,
  );
  const data = parser.parse(xml);
  const items = data.rss?.channel?.item;
  return items ? (Array.isArray(items) ? items.length : 1) : 0;
}

let indexers;
try {
  await login();
  indexers = JSON.parse(await call('GET', '/api/v2.0/indexers'));
} catch (error) {
  console.error(`连不上 Jackett（${base}）：${error.message}`);
  process.exit(1);
}
const byId = new Map(indexers.map((indexer) => [indexer.id, indexer]));

const kept = [];
const removed = [];
for (const id of CANDIDATES) {
  if (!byId.has(id)) {
    removed.push(`${id}：Jackett 未收录该定义`);
    continue;
  }
  if (byId.get(id).configured) {
    console.log(`跳过 ${id}（已在用）`);
    kept.push(id);
    continue;
  }
  try {
    const config = JSON.parse(await call('GET', `/api/v2.0/indexers/${id}/config`));
    await call('POST', `/api/v2.0/indexers/${id}/config`, config);
    const count = await testSearch(id);
    if (count > 0) {
      console.log(`可用 ${id}：测试搜索返回 ${count} 条`);
      kept.push(id);
    } else {
      throw new Error('测试搜索无结果');
    }
  } catch (error) {
    console.log(`移除 ${id}：${error.message}`);
    removed.push(`${id}：${error.message}`);
    try {
      await call('DELETE', `/api/v2.0/indexers/${id}`);
    } catch {
      // Not added or already gone.
    }
  }
}

console.log('\n探测完成。');
console.log(`保留（${kept.length}）：${kept.join('、') || '无'}`);
console.log(`移除（${removed.length}）：`);
for (const line of removed) console.log(`  - ${line}`);
if (kept.length)
  console.log('提示：新增索引器会自动进入 Jackett 的 all 聚合，直接搜索即可覆盖。');
process.exitCode = kept.length ? 0 : 1;
