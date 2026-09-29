// DHT-sourced indexers (e.g. 0Magnet) file every release under "other"; infer a
// category from the title so the category filter works for Chinese results.
// Precision over recall: weak or ambiguous words stay "other".
const VIDEO =
  /s\d{1,2}e\d{1,3}|第\s*[0-9零一二三四五六七八九十百]+\s*[季集部]|[0-9一二三四五六七八九十]+集全|全\s*\d+\s*集|\b(?:480|720|1080|2160|4320)p\b|\b4k\b|blu-?ray|web-?dl|webrip|hd-?rip|hdtv|dvdrip|x264|x265|h\.?26[45]|hevc|电影|剧集|电视剧|连续剧|纪录片|综艺|动漫|动画|番剧|剧场版/iu;
const SOFTWARE =
  /软件|破解版|绿色版|便携版|安装包|激活工具|注册机|\bwindows\s*\d|\bmacos\b|\bapk\b|\.exe\b|\.msi\b|\.dmg\b|汉化版|专业版|旗舰版/iu;
const BOOKS = /epub|mobi|azw3|\bpdf\b|电子书|小说|漫画|书籍|kindle|杂志|期刊|连环画/iu;
const AUDIO = /flac|mp3|aac|wav|ape\b|专辑|\balbum\b|\bost\b|原声|无损音乐|演唱会/iu;

export function inferCategory(name) {
  const value = String(name || '');
  if (!value) return 'other';
  if (VIDEO.test(value)) return 'video';
  if (SOFTWARE.test(value)) return 'software';
  if (BOOKS.test(value)) return 'books';
  if (AUDIO.test(value)) return 'audio';
  return 'other';
}
