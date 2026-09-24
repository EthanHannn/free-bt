import { createHash } from 'node:crypto';

export function normalizeHash(value) {
  const hash = String(value ?? '').trim();
  if (/^[a-f\d]{40}$/i.test(hash)) return hash.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(hash)) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0,
      acc = 0;
    const bytes = [];
    for (const char of hash.toUpperCase()) {
      acc = (acc << 5) | alphabet.indexOf(char);
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((acc >>> bits) & 255);
      }
    }
    return Buffer.from(bytes).toString('hex');
  }
  throw new Error('无效的 BT v1 info hash');
}

export function parseMagnet(value) {
  const url = new URL(value);
  if (url.protocol !== 'magnet:') throw new Error('需要 magnet 链接');
  const xt = url.searchParams.getAll('xt').find((v) => /^urn:btih:/i.test(v));
  const hash = normalizeHash(xt?.slice(9));
  const trackers = url.searchParams
    .getAll('tr')
    .filter((v) => /^(https?|udp):\/\//i.test(v))
    .slice(0, 20);
  const webSeeds = url.searchParams
    .getAll('ws')
    .filter((v) => /^https?:\/\//i.test(v))
    .slice(0, 20);
  const name = (url.searchParams.get('dn') || hash).slice(0, 500);
  const magnet = new URL(makeMagnet(hash, name, trackers, webSeeds));
  url.searchParams
    .getAll('xs')
    .filter((v) => /^https?:\/\//i.test(v))
    .slice(0, 5)
    .forEach((v) => magnet.searchParams.append('xs', v));
  return { hash, name, magnet: magnet.href.replace('xt=urn%3Abtih%3A', 'xt=urn:btih:') };
}

export function makeMagnet(hash, name, trackers = [], webSeeds = []) {
  const params = new URLSearchParams({ dn: name });
  trackers.forEach((tr) => params.append('tr', tr));
  webSeeds.forEach((ws) => params.append('ws', ws));
  return `magnet:?xt=urn:btih:${normalizeHash(hash)}&${params}`;
}

// Hash the original bencoded info bytes, never a decoded/re-encoded object.
export function parseTorrent(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 8 * 1024 * 1024)
    throw new Error('种子文件超过 8 MiB');
  let cursor = 0,
    infoBytes;
  function read(depth = 0) {
    if (depth > 64 || cursor >= buffer.length) throw new Error('种子编码无效');
    const tag = buffer[cursor];
    if (tag === 105) {
      const end = buffer.indexOf(101, ++cursor);
      const raw = buffer.subarray(cursor, end).toString();
      if (end < 0 || !/^(0|-?[1-9]\d*)$/.test(raw)) throw new Error('种子整数无效');
      const n = Number(raw);
      if (!Number.isSafeInteger(n)) throw new Error('种子整数超出范围');
      cursor = end + 1;
      return n;
    }
    if (tag === 108 || tag === 100) {
      cursor++;
      const result = tag === 108 ? [] : Object.create(null);
      while (buffer[cursor] !== 101) {
        if (cursor >= buffer.length) throw new Error('种子编码截断');
        if (tag === 108) result.push(read(depth + 1));
        else {
          const key = read(depth + 1);
          if (!Buffer.isBuffer(key)) throw new Error('种子字典键无效');
          const text = key.toString('utf8');
          if (Object.hasOwn(result, text)) throw new Error('种子字典键重复');
          const start = cursor;
          result[text] = read(depth + 1);
          if (depth === 0 && text === 'info') infoBytes = buffer.subarray(start, cursor);
        }
      }
      cursor++;
      return result;
    }
    const colon = buffer.indexOf(58, cursor);
    const raw = buffer.subarray(cursor, colon).toString();
    if (colon < 0 || !/^(0|[1-9]\d*)$/.test(raw)) throw new Error('种子字符串无效');
    const length = Number(raw);
    cursor = colon + 1;
    if (!Number.isSafeInteger(length) || cursor + length > buffer.length)
      throw new Error('种子字符串截断');
    const value = buffer.subarray(cursor, cursor + length);
    cursor += length;
    return value;
  }
  const root = read();
  if (cursor !== buffer.length || !infoBytes || !root.info || !Buffer.isBuffer(root.info.pieces))
    throw new Error('需要包含 v1 信息的种子');
  const info = root.info;
  const name = (info['name.utf-8'] ?? info.name)?.toString('utf8');
  if (
    !name ||
    info.pieces.length % 20 !== 0 ||
    !Number.isSafeInteger(info['piece length']) ||
    info['piece length'] <= 0
  )
    throw new Error('种子信息无效');
  const files = Array.isArray(info.files)
    ? info.files.map((file) => {
        const path = file['path.utf-8'] ?? file.path;
        if (!Array.isArray(path) || !path.every(Buffer.isBuffer)) throw new Error('文件路径无效');
        return { name: path.map((p) => p.toString('utf8')).join('/'), size: file.length };
      })
    : [{ name, size: info.length }];
  if (!files.length || files.some((f) => !Number.isSafeInteger(f.size) || f.size < 0))
    throw new Error('文件大小无效');
  const size = files.reduce((sum, f) => sum + f.size, 0);
  if (!Number.isSafeInteger(size)) throw new Error('总大小超出范围');
  const hash = createHash('sha1').update(infoBytes).digest('hex');
  const trackers = [
    root.announce,
    ...(Array.isArray(root['announce-list']) ? root['announce-list'].flat() : []),
  ]
    .filter(Buffer.isBuffer)
    .map((v) => v.toString('utf8'))
    .filter((v) => /^(https?|udp):\/\//i.test(v));
  const webSeeds = (Array.isArray(root['url-list']) ? root['url-list'] : [root['url-list']])
    .filter(Buffer.isBuffer)
    .map((v) => v.toString('utf8'))
    .filter((v) => /^https?:\/\//i.test(v));
  return {
    hash,
    name,
    size,
    files: files.slice(0, 2000),
    fileCount: files.length,
    magnet: makeMagnet(
      hash,
      name,
      [...new Set(trackers)].slice(0, 20),
      [...new Set(webSeeds)].slice(0, 20),
    ),
  };
}
