const $ = (selector) => document.querySelector(selector);
const labels = {
  all: '全部',
  video: '视频',
  audio: '音频',
  books: '书籍',
  software: '软件',
  other: '其他',
};
const glyphs = { video: '▷', audio: '♫', books: '▤', software: '⌘', other: '◇' };
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const safeWeb = (value) => {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
};
const safeMagnet = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'magnet:' &&
      /^urn:btih:([a-f\d]{40}|[a-z2-7]{32})$/i.test(url.searchParams.get('xt') || '')
      ? url.href
      : '';
  } catch {
    return '';
  }
};
function readStorage(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    toast('浏览器存储不可用，本次更改无法保留');
    return false;
  }
}
let saved = readStorage('freebt.saved', []);
saved = Array.isArray(saved)
  ? saved
      .filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string')
      .slice(0, 300)
  : [];
let history = readStorage('freebt.history', []);
history = Array.isArray(history) ? history.filter((q) => typeof q === 'string').slice(0, 6) : [];
let sources = [],
  items = [],
  controller,
  requestId = 0,
  detailRequestId = 0,
  toastTimer,
  currentDetail;
let state = { view: 'search', q: '', category: 'all', source: 'all', sort: 'relevance', page: 1 };

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true;
  }, 3200);
}
function size(value) {
  if (value == null || !Number.isFinite(Number(value))) return '大小未知';
  if (Number(value) === 0) return '0 B';
  const n = Math.min(Math.floor(Math.log(Number(value)) / Math.log(1024)), 4);
  return `${(Number(value) / 1024 ** n).toFixed(n ? 1 : 0)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][n]}`;
}
function date(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? '日期未知'
    : d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
function identity(item) {
  return item.hash || item.id;
}
function isSaved(item) {
  return saved.some((s) => identity(s) === identity(item) || s.id === item.id);
}
function storeHistory(q) {
  history = [q, ...history.filter((v) => v !== q)].slice(0, 6);
  writeStorage('freebt.history', history);
  renderHistory();
}
function renderHistory() {
  $('#history').innerHTML = history.length
    ? `<span>最近</span>${history.map((q) => `<button type="button" data-query="${escape(q)}">${escape(q)}</button>`).join('')}<button type="button" id="clear-history" aria-label="清除搜索历史">清除</button>`
    : '';
}
function updateSavedCount() {
  $('#saved-count').textContent = saved.length;
}
function navigate(patch, replace = false) {
  state = { ...state, ...patch };
  const params = new URLSearchParams();
  if (state.view !== 'search') params.set('view', state.view);
  else {
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.source !== 'all') params.set('source', state.source);
    if (state.sort !== 'relevance') params.set('sort', state.sort);
    if (state.page > 1) params.set('page', state.page);
  }
  window.history[replace ? 'replaceState' : 'pushState'](
    null,
    '',
    `/${params.size ? `?${params}` : ''}`,
  );
  render();
}
function readUrl() {
  const params = new URLSearchParams(location.search);
  state = {
    view: ['saved', 'sources'].includes(params.get('view')) ? params.get('view') : 'search',
    q: (params.get('q') || '').trim().slice(0, 160),
    category: Object.hasOwn(labels, params.get('category')) ? params.get('category') : 'all',
    source: ['local', 'archive', 'torznab'].includes(params.get('source'))
      ? params.get('source')
      : 'all',
    sort: params.get('sort') === 'newest' ? 'newest' : 'relevance',
    page: Math.max(1, Math.min(100, Math.floor(Number(params.get('page')) || 1))),
  };
  render();
}
function render() {
  controller?.abort();
  requestId++;
  for (const view of ['search', 'saved', 'sources'])
    $(`#${view}-view`).hidden = state.view !== view;
  document.querySelectorAll('[data-view]').forEach((link) => {
    if (link.dataset.view === state.view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  document.title =
    state.view === 'saved'
      ? '我的收藏 · 自由 BT'
      : state.view === 'sources'
        ? '数据源 · 自由 BT'
        : state.q
          ? `${state.q} · 自由 BT`
          : '自由 BT · 找到，再出发';
  if (state.view === 'saved') return renderSaved();
  if (state.view === 'sources') return renderSources();
  $('#query').value = state.q;
  $('#source').value = state.source;
  $('#sort').value = state.sort;
  document
    .querySelectorAll('[data-category]')
    .forEach((button) =>
      button.setAttribute('aria-pressed', button.dataset.category === state.category),
    );
  $('#intro').hidden = Boolean(state.q);
  $('#welcome').hidden = Boolean(state.q);
  $('#results-section').hidden = !state.q;
  $('#search-view').classList.toggle('has-query', Boolean(state.q));
  renderHistory();
  if (state.q) runSearch();
}
function empty(title, text, retry = false) {
  return `<div class="empty"><span class="empty-mark" aria-hidden="true">⌕</span><h3>${escape(title)}</h3><p>${escape(text)}</p>${retry ? '<button class="secondary" data-retry>重新搜索</button>' : ''}</div>`;
}
function card(item) {
  const bookmarked = isSaved(item);
  const category = Object.hasOwn(glyphs, item.category) ? item.category : 'other';
  return `<article class="result-card" data-id="${escape(item.id)}"><span class="file-icon ${category}" aria-hidden="true">${glyphs[category]}</span><div class="result-info"><button class="result-name" data-action="detail">${escape(item.name)}</button><div class="result-tags"><span class="category-label">${labels[category]}</span><span>${escape(size(item.size))}${item.sizeScope === 'archive' && item.size != null ? '（档案）' : ''}</span><span>${escape(date(item.added))}${item.source === 'local' ? '（导入）' : ''}</span><span class="seeders ${Number(item.seeders) > 0 ? 'has-seeds' : ''}">做种 ${item.seeders == null ? '未知' : escape(item.seeders)}</span></div><div class="result-source">${escape((item.sources || [item.sourceName]).join(' · '))}${item.hash ? `<span class="hash-preview">${escape(item.hash.slice(0, 12))}…</span>` : ''}</div></div><div class="result-actions"><button class="save-button ${bookmarked ? 'is-saved' : ''}" data-action="save" aria-label="${bookmarked ? '取消收藏' : '收藏'}：${escape(item.name)}" aria-pressed="${bookmarked}" title="${bookmarked ? '取消收藏' : '收藏'}">${bookmarked ? '★' : '☆'}</button><button class="copy-button" data-action="copy">复制磁力</button></div></article>`;
}
async function runSearch() {
  const id = ++requestId;
  controller = new AbortController();
  $('#results').setAttribute('aria-busy', 'true');
  $('#result-title').textContent = `“${state.q}” 的搜索结果`;
  $('#result-meta').textContent = '正在查询数据源…';
  $('#source-status').innerHTML = '';
  $('#pagination').hidden = true;
  $('#results').innerHTML =
    '<div class="loading"><span class="spinner"></span><p>正在寻找资源<span>首次连接数据源可能需要一点时间</span></p></div>';
  const params = new URLSearchParams({
    q: state.q,
    category: state.category,
    source: state.source,
    sort: state.sort,
    page: state.page,
  });
  try {
    const response = await fetch(`/api/search?${params}`, { signal: controller.signal });
    const data = await response.json();
    if (id !== requestId) return;
    if (!response.ok && !data.sources) throw new Error(data.error || '搜索失败，请重试');
    items = data.items || [];
    $('#source-status').innerHTML = (data.sources || [])
      .map(
        (source) =>
          `<span class="source-pill ${source.state === 'error' ? 'failed' : ''}" title="${escape(source.error || source.note || `本页 ${source.count} 条`)}"><span class="status-dot"></span>${escape(source.name)} · ${source.state === 'error' ? '连接失败' : `${source.count} 条`}</span>`,
      )
      .join('');
    if (data.partial)
      $('#source-status').insertAdjacentHTML(
        'beforeend',
        '<p class="source-warning">部分来源连接失败，可重试或切换数据源。<button data-retry>重试</button></p>',
      );
    for (const source of data.sources || [])
      if (source.note)
        $('#source-status').insertAdjacentHTML(
          'beforeend',
          `<p class="source-note">${escape(source.name)}：${escape(source.note)}</p>`,
        );
    $('#result-meta').textContent =
      `本页 ${items.length} 条 · ${data.cached ? '缓存结果' : `${(data.elapsed / 1000).toFixed(1)} 秒`}`;
    $('#results').innerHTML = items.length
      ? items.map(card).join('')
      : data.failed
        ? empty('暂时连不上数据源', '检查网络或代理设置，也可以切换到其他数据源。', true)
        : data.partial
          ? empty('已响应的来源中没有找到', '还有来源连接失败，重试后可能获得更多结果。', true)
          : empty(
              '换个关键词试试',
              '缩短名称、去掉版本号，或切换分类和数据源。资源范围取决于已接入的来源。',
            );
    if (items.length)
      $('#results').insertAdjacentHTML(
        'beforeend',
        `<p class="results-note">${state.sort === 'newest' ? '按本页结果的发布日期排序。' : ''}各来源独立分页，已知相同 hash 的结果合并。做种状态以下载客户端为准。</p>`,
      );
    $('#pagination').hidden = !items.length && !data.hasMore && state.page === 1;
    $('#prev').disabled = state.page <= 1;
    $('#next').disabled = !data.hasMore;
    $('#page-number').textContent = `第 ${state.page} 页`;
  } catch (error) {
    if (error.name === 'AbortError' || id !== requestId) return;
    items = [];
    $('#result-meta').textContent = '搜索未完成';
    $('#results').innerHTML = empty(
      '暂时无法搜索',
      error instanceof TypeError ? '连接中断，请检查服务和网络后重试。' : error.message,
      true,
    );
  } finally {
    if (id === requestId) $('#results').setAttribute('aria-busy', 'false');
  }
}
function renderSaved() {
  updateSavedCount();
  $('#saved-results').innerHTML = saved.length
    ? saved.map(card).join('')
    : empty('把发现留在这里', '搜索后点击资源旁的星标，就能在这里快速找到它。');
}
function toggleSaved(item) {
  if (isSaved(item))
    saved = saved.filter((s) => identity(s) !== identity(item) && s.id !== item.id);
  else {
    if (saved.length >= 300) return toast('最多收藏 300 条，请先整理现有收藏');
    const { files, ...light } = item;
    saved.unshift(light);
  }
  writeStorage('freebt.saved', saved);
  updateSavedCount();
  if (state.view === 'saved') renderSaved();
  else
    $('#results')
      .querySelectorAll('.result-card')
      .forEach((element) => {
        const resource = items.find((i) => i.id === element.dataset.id);
        if (resource) element.outerHTML = card(resource);
      });
  if (currentDetail) {
    const button = $('#detail-save');
    if (button) button.textContent = isSaved(currentDetail) ? '取消收藏' : '收藏资源';
  }
}
async function resolveResource(item) {
  const response = await fetch(`/api/resource?${new URLSearchParams({ id: item.id })}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '无法读取资源');
  for (const collection of [items, saved]) {
    const index = collection.findIndex((i) => i.id === item.id);
    if (index >= 0) {
      const { files, ...light } = data;
      collection[index] = { ...collection[index], ...light };
    }
  }
  if (saved.some((i) => i.id === item.id)) writeStorage('freebt.saved', saved);
  return data;
}
async function copyResource(item, button) {
  const text = button.textContent;
  button.disabled = true;
  button.textContent = item.magnet ? '正在复制…' : '获取磁力…';
  try {
    const resource = safeMagnet(item.magnet) ? item : await resolveResource(item);
    const magnet = safeMagnet(resource.magnet);
    if (!magnet) throw new Error('此资源暂无可用磁力链接');
    try {
      await navigator.clipboard.writeText(magnet);
      toast('磁力已复制，粘贴到 BT 客户端即可下载');
    } catch {
      await showDetail(resource);
      toast('浏览器未允许复制，请在详情中手动复制磁力');
    }
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = text;
  }
}
async function showDetail(item) {
  const id = ++detailRequestId;
  currentDetail = item;
  if (!$('#detail').open) $('#detail').showModal();
  $('#detail-content').innerHTML =
    `<h2 id="detail-title">${escape(item.name)}</h2><div class="loading"><span class="spinner"></span><p>正在读取种子信息…</p></div>`;
  try {
    const data = item.files ? item : await resolveResource(item);
    if (id !== detailRequestId || !$('#detail').open) return;
    currentDetail = data;
    const magnet = safeMagnet(data.magnet),
      origin = safeWeb(data.sourceUrl),
      torrent = safeWeb(data.torrentUrl);
    $('#detail-content').innerHTML =
      `<h2 id="detail-title">${escape(data.name)}</h2><div class="detail-meta"><span>${escape(labels[data.category] || '其他')}</span><span>${escape(size(data.size))}</span><span>做种 ${data.seeders == null ? '未知' : escape(data.seeders)}</span></div><dl class="detail-info"><div><dt>来源</dt><dd>${escape(data.sourceName)}</dd></div><div><dt>${data.source === 'local' ? '导入时间' : '发布日期'}</dt><dd>${escape(date(data.added))}</dd></div><div><dt>Info hash</dt><dd class="mono">${escape(data.hash || '未知')}</dd></div></dl>${magnet ? `<label class="small-label" for="magnet-text">磁力链接</label><textarea id="magnet-text" readonly rows="3">${escape(magnet)}</textarea>` : ''}<div class="detail-actions">${magnet ? `<button class="primary" id="detail-copy">复制磁力</button><a class="secondary" href="${escape(magnet)}">打开客户端 ↗</a>` : ''}<button class="secondary" id="detail-save">${isSaved(data) ? '取消收藏' : '收藏资源'}</button>${origin ? `<a class="text-link" href="${escape(origin)}" target="_blank" rel="noopener noreferrer">原始页面 ↗</a>` : ''}${torrent ? `<a class="text-link" href="${escape(torrent)}" target="_blank" rel="noopener noreferrer">下载种子 ↗</a>` : ''}</div><div class="files-heading"><h3>文件清单 <span>${data.fileCount == null ? '' : escape(data.fileCount)}</span></h3>${data.files?.length ? '<label class="sr-only" for="file-query">筛选文件</label><input id="file-query" type="search" placeholder="筛选文件名">' : ''}</div><div id="file-list"></div>${data.fileCount > (data.files?.length || 0) ? '<p class="muted">文件较多，仅展示前 2,000 个。完整清单可在 BT 客户端中查看。</p>' : ''}`;
    renderFiles('');
  } catch (error) {
    if (id !== detailRequestId || !$('#detail').open) return;
    const origin = safeWeb(item.sourceUrl);
    $('#detail-content').innerHTML =
      `<h2 id="detail-title">${escape(item.name)}</h2>${empty('详情暂时不可用', error.message)}<button class="secondary" id="detail-retry">重试</button>${origin ? `<a class="text-link" href="${escape(origin)}" target="_blank" rel="noopener noreferrer">访问原始页面 ↗</a>` : ''}`;
  }
}
function renderFiles(query) {
  const files = currentDetail?.files;
  if (!files?.length) {
    $('#file-list').innerHTML = '<p class="muted">来源未提供文件清单，可在 BT 客户端中查看。</p>';
    return;
  }
  const filtered = files.filter((file) => file.name.toLowerCase().includes(query.toLowerCase()));
  $('#file-list').innerHTML = filtered.length
    ? `<ul class="file-list">${filtered.map((file) => `<li><span>${escape(file.name)}</span><span>${escape(size(file.size))}</span></li>`).join('')}</ul>`
    : '<p class="muted">没有匹配的文件。</p>';
}
function renderSources() {
  $('#source-cards').innerHTML =
    sources
      .map(
        (source) =>
          `<article class="source-card"><div class="source-card-top"><span class="source-symbol" aria-hidden="true">${source.id === 'local' ? '▤' : source.id === 'archive' ? '◎' : '⇄'}</span><span class="enabled">已启用</span></div><h2>${escape(source.name)}</h2><p>${escape(source.description)}</p><div class="source-card-bottom">${source.count == null ? '联网搜索 · 响应情况见搜索结果' : `${source.count} 条已导入资源`}</div></article>`,
      )
      .join('') +
    (!sources.some((s) => s.id === 'torznab')
      ? '<article class="source-card add-source"><span class="source-symbol" aria-hidden="true">＋</span><h2>Prowlarr / Jackett</h2><p>连接自己的索引器，扩展搜索覆盖范围。</p><span class="not-configured">尚未配置</span></article>'
      : '');
}
async function loadSources() {
  try {
    const response = await fetch('/api/sources');
    if (!response.ok) throw new Error();
    const data = await response.json();
    sources = data.sources;
    $('#source').innerHTML =
      '<option value="all">所有数据源</option>' +
      sources.map((s) => `<option value="${escape(s.id)}">${escape(s.name)}</option>`).join('');
    if (state.source !== 'all' && !sources.some((s) => s.id === state.source))
      $('#source').insertAdjacentHTML(
        'beforeend',
        `<option value="${escape(state.source)}">未启用的数据源</option>`,
      );
    $('#source').value = state.source;
    $('#source-preview').innerHTML =
      '<div class="preview-heading"><span>已接入</span><a href="/?view=sources">管理来源 ↗</a></div>' +
      sources
        .map(
          (s) =>
            `<div class="preview-row"><span><span class="status-dot"></span>${escape(s.name)}</span><span>${s.count == null ? '联网检索' : `${s.count} 条资源`}</span></div>`,
        )
        .join('') +
      '<p class="preview-note">来源已启用，实际连接状态在搜索时检测</p>';
    renderSources();
  } catch {
    $('#source-preview').innerHTML = '<p>数据源信息读取失败，请刷新页面重试。</p>';
    $('#source-cards').innerHTML = empty('无法读取数据源', '请检查服务是否正常运行后刷新页面。');
  }
}

$('#search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const q = $('#query').value.trim();
  if (!q) return $('#query').focus();
  storeHistory(q);
  navigate({ view: 'search', q, page: 1 });
});
document.addEventListener('click', (event) => {
  const target = event.target.closest('button, a');
  if (!target) return;
  if (target.matches('a[href^="/?view="]') || target.dataset.view) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const view = target.dataset.view || new URL(target.href).searchParams.get('view');
    navigate({ view, ...(view === 'search' ? { q: '', page: 1 } : {}) });
    return;
  }
  if (target.dataset.query) {
    storeHistory(target.dataset.query);
    navigate({ view: 'search', q: target.dataset.query, category: 'all', page: 1 });
  }
  if (target.dataset.category)
    navigate({ q: $('#query').value.trim(), category: target.dataset.category, page: 1 });
  if (target.hasAttribute('data-retry')) runSearch();
  if (target.id === 'clear-history') {
    history = [];
    writeStorage('freebt.history', history);
    renderHistory();
  }
  if (target.dataset.action) {
    const itemId = target.closest('[data-id]').dataset.id;
    const item = (state.view === 'saved' ? saved : items).find((i) => i.id === itemId);
    if (!item) return;
    if (target.dataset.action === 'save') toggleSaved(item);
    if (target.dataset.action === 'copy') copyResource(item, target);
    if (target.dataset.action === 'detail') showDetail(item);
  }
  if (target.id === 'detail-copy') copyResource(currentDetail, target);
  if (target.id === 'detail-save') toggleSaved(currentDetail);
  if (target.id === 'detail-retry') showDetail(currentDetail);
});
$('#source').addEventListener('change', () =>
  navigate({ q: $('#query').value.trim(), source: $('#source').value, page: 1 }),
);
$('#sort').addEventListener('change', () =>
  navigate({ q: $('#query').value.trim(), sort: $('#sort').value, page: 1 }),
);
$('#prev').addEventListener('click', () => {
  navigate({ page: state.page - 1 });
  $('#search-form').scrollIntoView({ block: 'start' });
});
$('#next').addEventListener('click', () => {
  navigate({ page: state.page + 1 });
  $('#search-form').scrollIntoView({ block: 'start' });
});
$('#close-detail').addEventListener('click', () => $('#detail').close());
$('#detail').addEventListener('close', () => {
  detailRequestId++;
  currentDetail = null;
});
$('#detail').addEventListener('click', (event) => {
  if (event.target === $('#detail')) {
    const rect = $('#detail').getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      $('#detail').close();
  }
});
$('#detail').addEventListener('input', (event) => {
  if (event.target.id === 'file-query') renderFiles(event.target.value);
});
document.addEventListener('keydown', (event) => {
  if (
    event.key === '/' &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) &&
    !$('#detail').open
  ) {
    event.preventDefault();
    if (state.view !== 'search') navigate({ view: 'search' });
    $('#query').focus();
  }
});
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const label = theme === 'dark' ? '切换浅色模式' : '切换深色模式';
  $('#theme').setAttribute('aria-label', label);
  $('#theme').title = label;
}
setTheme(readStorage('freebt.theme', null) === 'dark' ? 'dark' : 'light');
$('#theme').addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(theme);
  writeStorage('freebt.theme', theme);
});
window.addEventListener('popstate', readUrl);
window.addEventListener('storage', (event) => {
  if (event.key === 'freebt.saved') {
    const next = readStorage('freebt.saved', []);
    if (Array.isArray(next)) {
      saved = next
        .filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string')
        .slice(0, 300);
      updateSavedCount();
      if (state.view === 'saved') renderSaved();
    }
  }
});
updateSavedCount();
readUrl();
loadSources();
