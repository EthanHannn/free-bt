import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTrackers,
  enrichMagnet,
  parseTrackerList,
  refreshTrackers,
} from '../server/trackers.js';

const LIST = ['udp://tracker.opentrackr.org:1337/announce', 'https://tracker.example:443/announce'];
const HASH = 'a'.repeat(40);

test('parseTrackerList keeps only tracker-looking lines', () => {
  const text = '# comment\n\nudp://a.example:80/announce\njavascript:alert(1)\nhttps://b.example/x\n';
  assert.deepEqual(parseTrackerList(text), ['udp://a.example:80/announce', 'https://b.example/x']);
});

test('enrichMagnet appends missing trackers and stays idempotent', () => {
  const magnet = `magnet:?xt=urn:btih:${HASH}&dn=test`;
  const once = enrichMagnet(magnet, LIST);
  const params = new URL(once).searchParams;
  assert.equal(params.get('xt'), `urn:btih:${HASH}`);
  assert.equal(params.get('dn'), 'test');
  assert.deepEqual(params.getAll('tr'), LIST);
  assert.equal(enrichMagnet(once, LIST), once);
});

test('enrichMagnet keeps existing tr params, dedupes and caps the total', () => {
  const existing = 'udp://tracker.opentrackr.org:1337/announce';
  const magnet = `magnet:?xt=urn:btih:${HASH}&tr=${encodeURIComponent(existing)}&tr=${encodeURIComponent('udp://old.example/announce')}`;
  const enriched = enrichMagnet(magnet, LIST.concat(['udp://x1.example/a', 'udp://x2.example/b']), 3);
  assert.deepEqual(new URL(enriched).searchParams.getAll('tr'), [
    existing,
    'udp://old.example/announce',
    'https://tracker.example:443/announce',
  ]);
});

test('enrichMagnet leaves invalid input untouched', () => {
  assert.equal(enrichMagnet('not a magnet', LIST), 'not a magnet');
  assert.equal(enrichMagnet('https://example.org/x', LIST), 'https://example.org/x');
});

test('createTrackers prefers the data file and reloads it on change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'freebt-trackers-'));
  const file = join(dir, 'trackers.txt');
  const fallback = join(dir, 'fallback.txt');
  writeFileSync(fallback, 'udp://fallback.example/announce\n');
  writeFileSync(file, 'udp://primary.example/announce\n');
  const trackers = createTrackers({ file, fallbackFile: fallback });
  assert.deepEqual(trackers.list(), ['udp://primary.example/announce']);
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeFileSync(file, 'udp://updated.example/announce\n');
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.deepEqual(trackers.list(), ['udp://updated.example/announce']);
});

test('createTrackers falls back to the bundled snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'freebt-trackers-'));
  const trackers = createTrackers({ file: join(dir, 'missing.txt') });
  assert.ok(trackers.list().length >= 10, 'bundled server/trackers.txt should load');
});

test('refreshTrackers validates content and writes atomically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'freebt-trackers-'));
  const file = join(dir, 'trackers.txt');
  const body = Array.from({ length: 12 }, (_, i) => `udp://t${i}.example:80/announce`).join('\n\n');
  const list = await refreshTrackers(file, {
    fetcher: async () => new Response(body),
  });
  assert.equal(list.length, 12);
  assert.match(readFileSync(file, 'utf8'), /udp:\/\/t11\.example/);
  await assert.rejects(
    () => refreshTrackers(file, { fetcher: async () => new Response('garbage') }),
    /内容无效/,
  );
  assert.match(readFileSync(file, 'utf8'), /udp:\/\/t11\.example/, 'failed refresh keeps old file');
});

test('refreshIfStale skips fresh files and refreshes missing ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'freebt-trackers-'));
  const file = join(dir, 'trackers.txt');
  writeFileSync(file, 'udp://fresh.example/announce\n');
  let fetched = 0;
  const fetcher = async () => {
    fetched++;
    return new Response(
      Array.from({ length: 10 }, (_, i) => `udp://n${i}.example/a`).join('\n'),
    );
  };
  const trackers = createTrackers({ file, fallbackFile: join(dir, 'none.txt'), fetcher });
  assert.equal(await trackers.refreshIfStale(), false);
  assert.equal(fetched, 0);
  const stale = createTrackers({
    file: join(dir, 'missing.txt'),
    fallbackFile: join(dir, 'none.txt'),
    fetcher,
  });
  assert.equal(await stale.refreshIfStale(), true);
  assert.equal(fetched, 1);
  assert.equal(stale.list().length, 10);
});
