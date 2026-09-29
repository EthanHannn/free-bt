// Heuristics for ad/spam titles common on DHT-sourced Chinese indexes.
// Precision over recall: legit release watermarks such as
// 【高清剧集网发布 www.example.com】 must keep passing, so a plain domain or
// a site mention alone never marks an item as junk — the tell is emoji
// decoration combined with obfuscated contact info or spam keywords.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
// Obfuscated contact/domains spelled out character by character: "k 91 v", "c o m".
const SPACED_TOKENS = /(?:[a-z0-9]\s+){3,}/iu;
// "v · c · o m" style middle-dot obfuscation.
const MIDDLE_DOT_DOMAIN = /[a-z0-9]+(?:\s*·\s*[a-z0-9]+){2,}/iu;
const SPAM_KEYWORDS = /兼职|刷单|投注|彩票|棋牌|约炮|上门服务|裸聊|成人用品/iu;

export function isJunkName(name) {
  const value = String(name || '');
  if (!value || !EMOJI.test(value)) return false;
  return (
    SPACED_TOKENS.test(value) ||
    MIDDLE_DOT_DOMAIN.test(value) ||
    SPAM_KEYWORDS.test(value)
  );
}
