import { ADMIN_STYLES } from './admin-styles';

export function adminPage(): Response {
  const nonce = createNonce();

  return new Response(ADMIN_HTML.replaceAll('__NONCE__', nonce), {
    headers: htmlHeaders(nonce),
  });
}

function htmlHeaders(nonce: string): HeadersInit {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy':
      `default-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
  };
}

function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function icon(name: string): string {
  const paths: Record<string, string> = {
    shield: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/>',
    theme: '<path d="M12 3a9 9 0 1 0 9 9c0-.4 0-.8-.1-1.2A6 6 0 0 1 12 3Z"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 17.9 17"/>',
    search: '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    import: '<path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    building: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 21v-4h6v4M8 7h1m6 0h1M8 11h1m6 0h1"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
  };
  return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[name] || '') + '</svg>';
}

const ADMIN_HTML = /* html */ `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>建筑管理 · MIK</title>
<script nonce="__NONCE__">
try {
  const theme = localStorage.getItem('mikdata-admin-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {}
</script>
<style nonce="__NONCE__">${ADMIN_STYLES}</style>
</head>
<body>
<a class="skip-link" href="#main">跳转到内容</a>
<div class="app">
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand"><strong>MIK</strong><span>管理</span></div>
      <div class="grow"></div>
      <span class="identity">${icon('shield')}管理员</span>
      <div class="header-actions">
        <button class="btn ghost" id="theme-btn" type="button" aria-label="配色：跟随系统，点击切换浅色">${icon('theme')}<span id="theme-label">跟随系统</span></button>
        <button class="btn ghost icon-btn" id="refresh-btn" type="button" aria-label="刷新全部数据" title="刷新全部数据">${icon('refresh')}</button>
      </div>
    </div>
  </header>
  <main id="main" tabindex="-1">
    <section class="admin-hero" aria-labelledby="page-title">
      <div>
        <h1 id="page-title">建筑管理</h1>
        <p id="admin-status">管理建筑收录与玩家申请。</p>
      </div>
      <div class="search-field" id="search-field">
        ${icon('search')}
        <label class="sr-only" for="search">搜索建筑、建造者、标签或 ID</label>
        <input id="search" type="search" placeholder="搜索建筑、建造者、标签…" autocomplete="off">
        <button class="btn ghost icon-btn search-clear" id="search-clear" type="button" aria-label="清除搜索" hidden>${icon('close')}</button>
      </div>
    </section>
    <div class="workspace-bar">
      <div class="view-tabs" role="tablist" aria-label="管理视图">
        <button class="view-tab" id="buildings-tab" type="button" role="tab" aria-selected="true" aria-controls="buildings-panel">建筑收录</button>
        <button class="view-tab" id="submissions-tab" type="button" role="tab" aria-selected="false" aria-controls="submissions-panel" tabindex="-1">待审申请<span class="tab-count" id="pending-count">0</span></button>
      </div>
      <div class="page-actions" id="building-actions">
        <button class="btn quiet" id="import-btn" type="button">${icon('import')}导入</button>
        <button class="btn primary" id="create-btn" type="button">${icon('plus')}新增建筑</button>
      </div>
    </div>
    <section id="buildings-panel" role="tabpanel" aria-labelledby="buildings-tab" tabindex="0">
      <div class="tools">
        <div class="summary" role="group" aria-label="建筑类型筛选">
          <button class="filter-chip" type="button" data-type="" aria-pressed="true">全部<strong id="s-total">0</strong></button>
          <button class="filter-chip" type="button" data-type="original" aria-pressed="false">原创<strong id="s-original">0</strong></button>
          <button class="filter-chip" type="button" data-type="derivative" aria-pressed="false">二创<strong id="s-derivative">0</strong></button>
          <button class="filter-chip" type="button" data-type="replica" aria-pressed="false">复刻<strong id="s-replica">0</strong></button>
        </div>
        <p class="result-count" id="result-count" role="status" aria-live="polite">正在加载建筑…</p>
      </div>
      <div class="table">
        <table aria-label="已收录建筑">
          <colgroup><col class="col-building"><col class="col-location"><col class="col-type"><col class="col-builders"><col class="col-date"><col class="col-actions"></colgroup>
          <thead><tr><th scope="col">建筑</th><th scope="col">所在位置</th><th scope="col">类型</th><th scope="col">建造者</th><th scope="col">建造日期</th><th scope="col">操作</th></tr></thead>
          <tbody id="rows"><tr><td colspan="6" class="empty-cell"><div class="empty">正在加载建筑…</div></td></tr></tbody>
        </table>
      </div>
    </section>
    <section class="review-board" id="submissions-panel" role="tabpanel" aria-labelledby="submissions-tab" tabindex="0" hidden>
      <div class="review-board__head">
        <div><h2>玩家建筑申请</h2><p>核对信息后批准收录，或填写原因退回申请。</p></div>
        <button class="btn ghost icon-btn" id="submissions-refresh-btn" type="button" aria-label="刷新申请" title="刷新申请">${icon('refresh')}</button>
      </div>
      <div class="review-list" id="submission-list" aria-busy="true"><div class="empty">正在加载申请…</div></div>
    </section>
  </main>
</div>
<dialog class="overlay" id="overlay" aria-labelledby="modal-title" aria-describedby="modal-hint">
  <form class="modal" id="building-form">
    <div class="modal-head">
      <div><h2 class="modal-title" id="modal-title">新增建筑</h2><p class="modal-subtitle" id="modal-hint">带 * 的项目为必填，保存后公开页面稍后同步。</p></div>
      <div class="grow"></div>
      <button class="btn ghost icon-btn" id="close-btn" type="button" aria-label="关闭编辑">${icon('close')}</button>
    </div>
    <div class="modal-body">
      <div class="grid">
        <h3 class="section">基本信息</h3>
        <div class="field"><label for="name-zh">中文名称 *</label><input id="name-zh" lang="zh-CN" maxlength="200" required></div>
        <div class="field"><label for="name-en">英文名称 *</label><input id="name-en" lang="en" maxlength="200" required></div>
        <div class="field"><label for="desc-zh">中文描述 *</label><textarea id="desc-zh" lang="zh-CN" maxlength="2000" required></textarea></div>
        <div class="field"><label for="desc-en">英文描述 *</label><textarea id="desc-en" lang="en" maxlength="2000" required></textarea></div>
        <div class="field"><label for="build-type">建筑类型</label><select id="build-type"><option value="original">原创</option><option value="derivative">二创</option><option value="replica">复刻</option></select></div>
        <div class="field"><label for="build-date">建造日期 *</label><input id="build-date" type="date" required></div>
        <h3 class="section">所在位置</h3>
        <div class="coordinate-grid full">
          <div class="field"><label for="coord-world">世界 *</label><input id="coord-world" value="world" maxlength="128" required></div>
          <div class="field"><label for="coord-x">X *</label><input id="coord-x" type="number" value="0" required></div>
          <div class="field"><label for="coord-y">Y *</label><input id="coord-y" type="number" value="64" required></div>
          <div class="field"><label for="coord-z">Z *</label><input id="coord-z" type="number" value="0" required></div>
        </div>
        <h3 class="section">建造者与内容</h3>
        <div class="field full"><label for="builders">建造者 *</label><textarea id="builders" aria-describedby="builders-hint" spellcheck="false" required></textarea><p class="hint" id="builders-hint">每行一位，依次填写名称、UUID、贡献权重，用英文逗号分隔。</p></div>
        <div class="field full"><label for="images">图片链接 *</label><textarea id="images" aria-describedby="images-hint" spellcheck="false" required></textarea><p class="hint" id="images-hint">每行一个链接，支持 / 开头的路径或 HTTPS 地址。</p></div>
        <div class="field full"><label for="tags">标签<span>选填</span></label><textarea id="tags" aria-describedby="tags-hint"></textarea><p class="hint" id="tags-hint">每行一个标签，中文和英文用英文逗号分隔。</p></div>
        <details class="source-fields full" id="source-fields">
          <summary>来源与备注<span>选填</span></summary>
          <div class="grid">
            <div class="field"><label for="source-author">原作者</label><input id="source-author" maxlength="200"></div>
            <div class="field"><label for="source-link">原作链接</label><input id="source-link" type="url" maxlength="500"></div>
            <div class="field full"><label for="source-note-zh">中文备注</label><input id="source-note-zh" maxlength="500"></div>
            <div class="field full"><label for="source-note-en">英文备注</label><input id="source-note-en" maxlength="500"></div>
          </div>
        </details>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" id="cancel-btn" type="button">取消</button>
      <button class="btn quiet" id="review-save-btn" type="button" hidden>保存修改</button>
      <button class="btn danger" id="review-reject-btn" type="button" hidden>退回申请</button>
      <button class="btn primary" id="review-approve-btn" type="button" hidden>批准收录</button>
      <button class="btn primary" id="save-btn" type="submit">保存建筑</button>
    </div>
  </form>
</dialog>
<dialog class="overlay" id="import-overlay" aria-labelledby="import-title" aria-describedby="import-hint">
  <form class="modal modal--import" id="import-form">
    <div class="modal-head">
      <div><h2 class="modal-title" id="import-title">导入建筑</h2><p class="modal-subtitle" id="import-hint">选择 JSON 文件，或直接粘贴建筑数据。</p></div>
      <div class="grow"></div>
      <button class="btn ghost icon-btn" id="import-close-btn" type="button" aria-label="关闭导入">${icon('close')}</button>
    </div>
    <div class="modal-body">
      <div class="grid">
        <div class="field full"><label for="import-file">选择文件</label><input id="import-file" type="file" accept="application/json,.json"></div>
        <div class="field full"><label for="import-json">JSON 内容</label><textarea id="import-json" class="mono" spellcheck="false" placeholder="粘贴一个建筑对象或建筑数组" required></textarea></div>
        <div class="preview full" id="import-preview" role="status" aria-live="polite">选择文件或粘贴 JSON 后预览导入数量。</div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" id="import-cancel-btn" type="button">取消</button>
      <button class="btn primary" id="import-save-btn" type="submit" disabled>确认导入</button>
    </div>
  </form>
</dialog>
<div id="toast" role="status" aria-live="polite" hidden></div>
<script nonce="__NONCE__">
const THEME_KEY = 'mikdata-admin-theme';
const THEMES = ['system', 'light', 'dark'];
const themeLabel = { system: '跟随系统', light: '浅色模式', dark: '深色模式' };
const state = {
  buildings: [],
  submissions: [],
  editId: null,
  reviewId: null,
  busy: false,
  view: 'buildings',
  typeFilter: '',
  loadingBuildings: true,
  loadingSubmissions: false,
  buildingError: '',
  submissionError: '',
  importValid: false,
  theme: readTheme(),
};
const typeLabel = { original: '原创', derivative: '二创', replica: '复刻' };
const $ = (id) => document.getElementById(id);

applyTheme();
$('theme-btn').addEventListener('click', cycleTheme);
$('refresh-btn').addEventListener('click', () => loadAll());
$('submissions-refresh-btn').addEventListener('click', () => loadSubmissions());
$('import-btn').addEventListener('click', openImport);
$('create-btn').addEventListener('click', openCreate);
$('search').addEventListener('input', render);
$('search-clear').addEventListener('click', clearSearch);
document.querySelectorAll('.filter-chip').forEach((button) => {
  button.addEventListener('click', () => {
    state.typeFilter = button.dataset.type;
    document.querySelectorAll('.filter-chip').forEach((chip) => {
      chip.setAttribute('aria-pressed', String(chip === button));
    });
    render();
  });
});
document.querySelectorAll('[role="tab"]').forEach((tab) => {
  tab.addEventListener('click', () => switchView(tab.id === 'buildings-tab' ? 'buildings' : 'submissions'));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const view = event.key === 'Home' ? 'buildings' : event.key === 'End' ? 'submissions' : tab.id === 'buildings-tab' ? 'submissions' : 'buildings';
    switchView(view);
    $(view + '-tab').focus();
  });
});
$('rows').addEventListener('click', handleBuildingTableClick);
$('submission-list').addEventListener('click', handleSubmissionListClick);
$('close-btn').addEventListener('click', closeModal);
$('cancel-btn').addEventListener('click', closeModal);
$('overlay').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) closeModal();
});
$('overlay').addEventListener('cancel', (event) => { event.preventDefault(); closeModal(); });
$('building-form').addEventListener('submit', saveBuilding);
$('review-save-btn').addEventListener('click', saveSubmissionEdit);
$('review-approve-btn').addEventListener('click', approveSubmission);
$('review-reject-btn').addEventListener('click', rejectSubmission);
$('import-close-btn').addEventListener('click', closeImport);
$('import-cancel-btn').addEventListener('click', closeImport);
$('import-overlay').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) closeImport();
});
$('import-overlay').addEventListener('cancel', (event) => { event.preventDefault(); closeImport(); });
$('import-form').addEventListener('submit', importBuildings);
$('import-file').addEventListener('change', readImportFile);
$('import-json').addEventListener('input', updateImportPreview);

updateAuthState();
setReviewMode(false);
loadAll();

function switchView(view) {
  state.view = view;
  for (const name of ['buildings', 'submissions']) {
    const selected = name === view;
    $(name + '-tab').setAttribute('aria-selected', String(selected));
    $(name + '-tab').tabIndex = selected ? 0 : -1;
    $(name + '-panel').hidden = !selected;
  }
  $('search-field').hidden = view !== 'buildings';
  $('building-actions').hidden = view !== 'buildings';
}

function clearSearch() {
  $('search').value = '';
  render();
  $('search').focus();
}

function readTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return THEMES.includes(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme() {
  if (state.theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.dataset.theme = state.theme;
  }

  $('theme-label').textContent = themeLabel[state.theme];
  const next = THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length];
  $('theme-btn').setAttribute('aria-label', '配色：' + themeLabel[state.theme] + '，点击切换' + themeLabel[next]);
  $('theme-btn').title = '配色：' + themeLabel[state.theme];
}

function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length];
  state.theme = next;

  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {}

  applyTheme();
}

function updateAuthState() {
  $('create-btn').disabled = state.busy;
  $('import-btn').disabled = state.busy;
  document.querySelectorAll('.row-actions button').forEach((button) => {
    button.disabled = state.busy || (button.dataset.action === 'review' && !state.submissions.some((item) => item.id === button.dataset.id && item.status === 'pending'));
  });
}

async function loadAll(manageBusy = true) {
  if (manageBusy) setBusy(true);
  try {
    await Promise.all([loadBuildings(false), loadSubmissions(false)]);
  } finally {
    if (manageBusy) setBusy(false);
  }
}

async function loadBuildings(manageBusy = true) {
  if (manageBusy) setBusy(true);
  state.loadingBuildings = true;
  state.buildingError = '';
  render();
  try {
    const res = await fetch('/admin/api/buildings', { cache: 'no-store' });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || res.statusText);
    state.buildings = Array.isArray(data) ? data : [];
    updateStats();
  } catch (error) {
    state.buildingError = error.message || '加载失败';
    toast(error.message || '加载失败', false);
  } finally {
    state.loadingBuildings = false;
    render();
    if (manageBusy) setBusy(false);
  }
}

async function loadSubmissions(manageBusy = true) {
  if (manageBusy) setBusy(true);
  state.loadingSubmissions = true;
  state.submissionError = '';
  renderSubmissions();
  try {
    const res = await fetch('/admin/api/building-submissions?status=pending', { cache: 'no-store' });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || res.statusText);
    state.submissions = Array.isArray(data.submissions) ? data.submissions : [];
    updateAdminStatus();
  } catch (error) {
    state.submissionError = error.message || '申请加载失败';
    toast(error.message || '申请加载失败', false);
  } finally {
    state.loadingSubmissions = false;
    renderSubmissions();
    if (manageBusy) setBusy(false);
  }
}

function updateStats() {
  $('s-total').textContent = state.buildings.length;
  $('s-original').textContent = countType('original');
  $('s-derivative').textContent = countType('derivative');
  $('s-replica').textContent = countType('replica');
  updateAdminStatus();
}

function countType(type) {
  return state.buildings.filter((building) => building.buildType === type).length;
}

function updateAdminStatus() {
  const pending = state.submissions.filter((submission) => submission.status === 'pending').length;
  $('pending-count').textContent = pending;
  $('submissions-tab').setAttribute('aria-label', '待审申请，' + pending + ' 条');
  $('admin-status').textContent = '已收录 ' + state.buildings.length + ' 座建筑，' + (pending ? pending + ' 份申请待审核。' : '当前没有待审申请。');
}

function render() {
  const query = $('search').value.trim().toLowerCase();
  const type = state.typeFilter;
  const rows = state.buildings.filter((building) => {
    if (type && building.buildType !== type) return false;
    return !query || searchableText(building).includes(query);
  });
  const body = $('rows');
  $('search-clear').hidden = !$('search').value;
  $('buildings-panel').setAttribute('aria-busy', String(state.loadingBuildings));
  $('result-count').textContent = state.loadingBuildings ? '正在加载建筑…' : state.buildingError ? '加载失败，请重试' : (query || type ? '找到 ' + rows.length + ' 座建筑' : '共 ' + rows.length + ' 座建筑');
  if (state.loadingBuildings && !state.buildings.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-cell"><div class="empty">正在加载建筑…</div></td></tr>';
    return;
  }
  if (state.buildingError && !state.buildings.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-cell"><div class="empty"><strong>建筑加载失败</strong><p>' + esc(state.buildingError) + '</p><button class="btn quiet" type="button" data-action="retry">重新加载</button></div></td></tr>';
    return;
  }
  if (!rows.length) {
    const filtered = query || type;
    body.innerHTML = '<tr><td colspan="6" class="empty-cell"><div class="empty">${icon('building')}<strong>' + (filtered ? '没有找到匹配的建筑' : '还没有收录建筑') + '</strong><p>' + (filtered ? '试试其他名称、建造者或标签，或清除筛选。' : '新增一座建筑，或导入已有的建筑数据。') + '</p><button class="btn quiet" type="button" data-action="' + (filtered ? 'reset' : 'create') + '">' + (filtered ? '清除筛选' : '新增建筑') + '</button></div></td></tr>';
    return;
  }
  body.innerHTML = rows.map((building) => {
    const builders = [...(building.builders || [])].sort((a, b) => b.weight - a.weight).map((item) => item.name).join('、');
    const tags = (building.tags || []).map((tag) => tag['zh-CN'] || tag.en).filter(Boolean).join('、');
    return '<tr>' +
      '<td class="building-cell"><div class="title">' + esc(building.name && building.name['zh-CN']) + '</div><div class="meta">' + esc(building.name && building.name.en) + '</div>' + (tags ? '<div class="meta">' + esc(tags) + '</div>' : '') + '<div class="mono meta record-id">' + esc(building.id) + '</div></td>' +
      '<td data-label="所在位置"><div class="mono">' + esc(building.coordinates && building.coordinates.world) + '</div><div class="mono">' + num(building.coordinates && building.coordinates.x) + ', ' + num(building.coordinates && building.coordinates.y) + ', ' + num(building.coordinates && building.coordinates.z) + '</div></td>' +
      '<td data-label="类型"><span class="badge ' + esc(building.buildType) + '">' + esc(typeLabel[building.buildType] || building.buildType) + '</span></td>' +
      '<td data-label="建造者">' + esc(builders) + '</td>' +
      '<td data-label="建造日期"><span class="date">' + esc(building.buildDate) + '</span></td>' +
      '<td class="actions-cell"><div class="row-actions"><button class="btn quiet sm" type="button" data-action="edit" data-id="' + esc(building.id) + '" aria-label="编辑' + esc(building.name && building.name['zh-CN']) + '">编辑</button><button class="btn danger sm" type="button" data-action="delete" data-id="' + esc(building.id) + '" aria-label="删除' + esc(building.name && building.name['zh-CN']) + '">删除</button></div></td>' +
      '</tr>';
  }).join('');
  updateAuthState();
}

function renderSubmissions() {
  const list = $('submission-list');
  list.setAttribute('aria-busy', String(state.loadingSubmissions));
  if (state.loadingSubmissions && !state.submissions.length) {
    list.innerHTML = '<div class="empty">正在加载申请</div>';
    return;
  }
  const pendingFirst = [...state.submissions].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
  if (!pendingFirst.length) {
    list.innerHTML = state.submissionError
      ? '<div class="empty"><strong>申请加载失败</strong><p>' + esc(state.submissionError) + '</p><button class="btn quiet" type="button" data-action="retry">重新加载</button></div>'
      : '<div class="empty">${icon('check')}<strong>所有申请已处理</strong><p>新的玩家建筑申请会显示在这里。</p></div>';
    return;
  }
  list.innerHTML = pendingFirst.map((submission) => {
    const payload = submission.payload || {};
    const title = payload.name && (payload.name['zh-CN'] || payload.name.en) || submission.id;
    const builders = (payload.builders || []).map((item) => item.name).filter(Boolean).join('、');
    const coords = payload.coordinates || {};
    const disabled = submission.status !== 'pending' ? ' disabled' : '';
    const note = submission.reviewNote ? '<div class="meta">备注：' + esc(submission.reviewNote) + '</div>' : '';
    const expires = submission.status === 'rejected' && submission.expiresAt ? '<div class="meta">保留至：' + esc(formatTime(submission.expiresAt)) + '</div>' : '';
    return '<article class="review-item">' +
      '<div><div class="title">' + esc(title) + '</div>' +
      '<div class="meta">提交者：' + esc(submission.submitterName) + ' · ' + esc(formatTime(submission.createdAt)) + '</div>' +
      '<div class="meta">坐标：' + esc(coords.world) + ' · (' + num(coords.x) + ', ' + num(coords.y) + ', ' + num(coords.z) + ') · 建造者：' + esc(builders || '-') + '</div>' +
      note +
      expires +
      '<div class="review-item__meta"><span class="badge status-' + esc(submission.status) + '">' + esc(statusLabel(submission.status)) + '</span><span class="badge ' + esc(payload.buildType || '') + '">' + esc(typeLabel[payload.buildType] || payload.buildType || '-') + '</span></div></div>' +
      '<div class="row-actions"><button class="btn quiet sm" type="button" data-action="review" data-id="' + esc(submission.id) + '" aria-label="查看申请：' + esc(title) + '"' + disabled + '>查看申请</button></div>' +
      '</article>';
  }).join('');
  updateAuthState();
}

function handleBuildingTableClick(event) {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest('button[data-action]');
  if (!button || state.busy) return;
  if (button.dataset.action === 'retry') { loadBuildings(); return; }
  if (button.dataset.action === 'create') { openCreate(); return; }
  if (button.dataset.action === 'reset') {
    state.typeFilter = '';
    document.querySelectorAll('.filter-chip').forEach((chip) => chip.setAttribute('aria-pressed', String(chip.dataset.type === '')));
    clearSearch();
    return;
  }
  const id = button.dataset.id;
  if (button.dataset.action === 'edit') openEdit(id);
  if (button.dataset.action === 'delete') deleteBuilding(id);
}

function handleSubmissionListClick(event) {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest('button[data-action]');
  if (!button || state.busy || button.disabled) return;
  if (button.dataset.action === 'retry') { loadSubmissions(); return; }
  openSubmissionReview(button.dataset.id);
}

function searchableText(building) {
  const tags = (building.tags || []).flatMap((tag) => [tag['zh-CN'], tag.en]);
  const builders = (building.builders || []).map((builder) => builder.name);
  return [building.id, building.name && building.name['zh-CN'], building.name && building.name.en, ...tags, ...builders]
    .filter(Boolean).join(' ').toLowerCase();
}

function openCreate() {
  state.editId = null;
  state.reviewId = null;
  $('modal-title').textContent = '新增建筑';
  $('building-form').reset();
  $('source-fields').open = false;
  $('coord-x').value = '0';
  $('coord-y').value = '64';
  $('coord-z').value = '0';
  $('build-type').value = 'original';
  $('build-date').value = new Date().toISOString().slice(0, 10);
  setReviewMode(false);
  $('overlay').showModal();
  $('overlay').querySelector('.modal-body').scrollTop = 0;
  $('name-zh').focus();
}

function openEdit(id) {
  const building = state.buildings.find((item) => item.id === id);
  if (!building) return;
  state.editId = id;
  state.reviewId = null;
  $('modal-title').textContent = '编辑建筑';
  fillForm(building);
  setReviewMode(false);
  $('overlay').showModal();
  $('overlay').querySelector('.modal-body').scrollTop = 0;
  $('name-zh').focus();
}

function openSubmissionReview(id) {
  const submission = state.submissions.find((item) => item.id === id);
  if (!submission || submission.status !== 'pending') return;
  state.editId = null;
  state.reviewId = id;
  $('modal-title').textContent = '审核申请 · ' + (submission.submitterName || submission.id);
  fillForm(submission.payload || {});
  setReviewMode(true);
  $('overlay').showModal();
  $('overlay').querySelector('.modal-body').scrollTop = 0;
  $('name-zh').focus();
}

function closeModal() {
  document.body.append($('toast'));
  $('overlay').close();
  state.editId = null;
  state.reviewId = null;
  setReviewMode(false);
}

function setReviewMode(isReview) {
  $('save-btn').hidden = isReview;
  $('review-save-btn').hidden = !isReview;
  $('review-reject-btn').hidden = !isReview;
  $('review-approve-btn').hidden = !isReview;
}

function openImport() {
  $('import-form').reset();
  $('import-json').value = '';
  updateImportPreview();
  $('import-overlay').showModal();
  $('import-json').focus();
}

function closeImport() {
  document.body.append($('toast'));
  $('import-overlay').close();
}

function fillForm(building) {
  $('name-zh').value = building.name && building.name['zh-CN'] || '';
  $('name-en').value = building.name && building.name.en || '';
  $('desc-zh').value = building.description && building.description['zh-CN'] || '';
  $('desc-en').value = building.description && building.description.en || '';
  $('coord-world').value = building.coordinates?.world ?? 'world';
  $('coord-x').value = building.coordinates?.x ?? 0;
  $('coord-y').value = building.coordinates?.y ?? 64;
  $('coord-z').value = building.coordinates?.z ?? 0;
  $('build-type').value = building.buildType || 'original';
  $('builders').value = (building.builders || []).map((item) => [item.name, item.uuid, item.weight].join(',')).join('\\n');
  $('images').value = (building.images || []).join('\\n');
  $('build-date').value = building.buildDate || '';
  $('tags').value = (building.tags || []).map((tag) => [tag['zh-CN'] || '', tag.en || ''].join(',')).join('\\n');
  const source = building.source || {};
  $('source-author').value = source.originalAuthor || '';
  $('source-link').value = source.originalLink || '';
  $('source-note-zh').value = source.notes && source.notes['zh-CN'] || '';
  $('source-note-en').value = source.notes && source.notes.en || '';
  $('source-fields').open = Boolean(source.originalAuthor || source.originalLink || source.notes && (source.notes['zh-CN'] || source.notes.en));
}

async function saveBuilding(event) {
  event.preventDefault();
  if (state.reviewId) {
    await saveSubmissionEdit();
    return;
  }
  setBusy(true);
  try {
    const isEdit = Boolean(state.editId);
    const res = await fetch(isEdit ? '/admin/api/buildings/' + encodeURIComponent(state.editId) : '/admin/api/buildings', {
      method: isEdit ? 'PUT' : 'POST',
      headers: isEdit ? writeHeaders(expectedBuildingHeader(state.editId)) : writeHeaders(),
      body: JSON.stringify(toPayload()),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || res.statusText);
    toast(isEdit ? '已更新，公开页面稍后同步' : '已创建，公开页面稍后同步', true);
    closeModal();
    await loadBuildings(false);
  } catch (error) {
    toast(error.message || '保存失败', false);
  } finally {
    setBusy(false);
  }
}

async function saveSubmissionEdit() {
  const submission = currentReviewSubmission();
  if (!submission) return;
  if (!$('building-form').reportValidity()) return;
  setBusy(true);
  try {
    const payload = toPayload();
    const res = await fetch('/admin/api/building-submissions/' + encodeURIComponent(submission.id), {
      method: 'PUT',
      headers: writeHeaders(expectedSubmissionHeader(submission)),
      body: JSON.stringify({
        payload,
        images: imageMetadataForPayload(payload, submission.images || []),
      }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || res.statusText);
    toast('申请已保存', true);
    await loadSubmissions(false);
  } catch (error) {
    toast(error.message || '保存申请失败', false);
  } finally {
    setBusy(false);
  }
}

async function approveSubmission() {
  const submission = currentReviewSubmission();
  if (!submission) return;
  if (!$('building-form').reportValidity()) return;
  setBusy(true);
  try {
    const payload = toPayload();
    const res = await fetch('/admin/api/building-submissions/' + encodeURIComponent(submission.id) + '/approve', {
      method: 'PUT',
      headers: writeHeaders(expectedSubmissionHeader(submission)),
      body: JSON.stringify({
        payload,
        images: imageMetadataForPayload(payload, submission.images || []),
      }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || res.statusText);
    toast('已批准并收入建筑，公开页面稍后同步', true);
    closeModal();
    await loadAll(false);
  } catch (error) {
    toast(error.message || '批准失败', false);
  } finally {
    setBusy(false);
  }
}

async function rejectSubmission() {
  const submission = currentReviewSubmission();
  if (!submission) return;
  const reviewNote = prompt('填写退回原因，帮助玩家修改申请');
  if (!reviewNote || !reviewNote.trim()) return;
  setBusy(true);
  try {
    const res = await fetch('/admin/api/building-submissions/' + encodeURIComponent(submission.id) + '/reject', {
      method: 'PUT',
      headers: writeHeaders(expectedSubmissionHeader(submission)),
      body: JSON.stringify({ reviewNote: reviewNote.trim() }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || res.statusText);
    toast('申请已退回', true);
    closeModal();
    await loadSubmissions(false);
  } catch (error) {
    toast(error.message || '拒绝失败', false);
  } finally {
    setBusy(false);
  }
}

async function deleteBuilding(id) {
  const building = state.buildings.find((item) => item.id === id);
  const label = building && building.name ? building.name['zh-CN'] || building.name.en || id : id;
  if (!confirm('删除「' + label + '」？')) return;
  setBusy(true);
  try {
    const res = await fetch('/admin/api/buildings/' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: writeHeaders(expectedBuildingHeader(id)),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || res.statusText);
    toast('已删除，公开页面稍后同步', true);
    await loadBuildings(false);
  } catch (error) {
    toast(error.message || '删除失败', false);
  } finally {
    setBusy(false);
  }
}

async function readImportFile() {
  const file = $('import-file').files && $('import-file').files[0];
  if (!file) return;

  try {
    $('import-json').value = await file.text();
    updateImportPreview();
  } catch {
    toast('读取文件失败', false);
  }
}

function updateImportPreview() {
  const value = $('import-json').value.trim();
  state.importValid = false;
  $('import-save-btn').disabled = true;

  if (!value) {
    $('import-preview').textContent = '选择文件或粘贴 JSON 后预览导入数量。';
    return;
  }

  try {
    const parsed = JSON.parse(value);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (!items.length || items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
      $('import-preview').textContent = '请填写一个建筑对象，或包含建筑对象的非空数组。';
      return;
    }
    state.importValid = true;
    $('import-save-btn').disabled = state.busy;
    $('import-preview').textContent = '准备导入 ' + items.length + ' 座建筑，确认后写入收录。';
  } catch {
    $('import-preview').textContent = 'JSON 格式有误，请检查括号、引号和逗号。';
  }
}

async function importBuildings(event) {
  event.preventDefault();

  let items;

  try {
    const parsed = JSON.parse($('import-json').value);
    items = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    toast('JSON 格式错误', false);
    return;
  }

  if (!items.length) {
    toast('没有可导入的数据', false);
    return;
  }

  setBusy(true);

  try {
    const payload = { buildings: items.map(toImportPayload) };
    const res = await fetch('/admin/api/buildings/import', {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || res.statusText);

    toast('已导入 ' + data.imported + ' 条，公开页面稍后同步', true);
    closeImport();
    await loadBuildings(false);
  } catch (error) {
    toast(error.message || '导入失败', false);
  } finally {
    setBusy(false);
  }
}

function toImportPayload(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('导入项必须是对象');
  }

  const payload = { ...item };
  delete payload.id;
  delete payload.createdAt;
  delete payload.updatedAt;
  return payload;
}

function toPayload() {
  const sourceAuthor = $('source-author').value.trim();
  const sourceLink = $('source-link').value.trim();
  const sourceNoteZh = $('source-note-zh').value.trim();
  const sourceNoteEn = $('source-note-en').value.trim();
  const source = sourceAuthor || sourceLink || sourceNoteZh || sourceNoteEn ? {
    originalAuthor: sourceAuthor || undefined,
    originalLink: sourceLink || undefined,
    notes: sourceNoteZh || sourceNoteEn ? { 'zh-CN': sourceNoteZh, en: sourceNoteEn } : undefined,
  } : null;
  return {
    name: { 'zh-CN': $('name-zh').value.trim(), en: $('name-en').value.trim() },
    description: { 'zh-CN': $('desc-zh').value.trim(), en: $('desc-en').value.trim() },
    coordinates: { world: $('coord-world').value.trim(), x: Number($('coord-x').value), y: Number($('coord-y').value), z: Number($('coord-z').value) },
    builders: parseBuilders($('builders').value),
    buildType: $('build-type').value,
    images: splitLines($('images').value),
    buildDate: $('build-date').value,
    tags: parseTags($('tags').value),
    source,
  };
}

function parseBuilders(value) {
  return splitLines(value).map((line) => {
    const parts = line.split(',').map((part) => part.trim());
    return { name: parts[0] || '', uuid: parts[1] || '', weight: Number(parts[2] || 0) };
  });
}

function parseTags(value) {
  return splitLines(value).map((line) => {
    const parts = line.split(',').map((part) => part.trim());
    const tag = {};
    if (parts[0]) tag['zh-CN'] = parts[0];
    if (parts[1]) tag.en = parts[1];
    return tag;
  }).filter((tag) => tag['zh-CN'] || tag.en);
}

function splitLines(value) {
  return value.split('\\n').map((line) => line.trim()).filter(Boolean);
}

function currentReviewSubmission() {
  return state.reviewId ? state.submissions.find((item) => item.id === state.reviewId) : null;
}

function imageMetadataForPayload(payload, existingImages) {
  const byUrl = new Map((existingImages || []).map((image) => [image.url, image]));
  return (payload.images || []).map((url) => {
    const image = byUrl.get(url);
    if (!image) {
      throw new Error('申请图片只能使用玩家已上传的 WebP 图片');
    }
    return image;
  });
}

function statusLabel(status) {
  return { pending: '待审核', approved: '已批准', rejected: '已拒绝' }[status] || status;
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

function writeHeaders(extra) {
  return { 'Content-Type': 'application/json', ...(extra || {}) };
}

function expectedBuildingHeader(id) {
  const building = state.buildings.find((item) => item.id === id);
  return building && building.updatedAt ? { 'X-Expected-Updated-At': building.updatedAt } : {};
}

function expectedSubmissionHeader(submission) {
  return submission && submission.updatedAt ? { 'X-Expected-Updated-At': submission.updatedAt } : {};
}

async function readJson(res) {
  return res.json().catch(() => ({}));
}

function setBusy(busy) {
  state.busy = busy;
  $('save-btn').disabled = busy;
  $('review-save-btn').disabled = busy;
  $('review-reject-btn').disabled = busy;
  $('review-approve-btn').disabled = busy;
  $('import-save-btn').disabled = busy || !state.importValid;
  $('refresh-btn').disabled = busy;
  $('submissions-refresh-btn').disabled = busy;
  $('refresh-btn').classList.toggle('is-loading', busy);
  $('save-btn').textContent = busy ? '正在保存…' : '保存建筑';
  $('import-save-btn').textContent = busy ? '正在处理…' : '确认导入';
  updateAuthState();
}

let toastTimer;
function toast(message, ok) {
  const el = $('toast');
  (document.querySelector('dialog[open]') || document.body).append(el);
  el.hidden = false;
  el.textContent = message;
  el.className = ok ? 'ok' : 'err';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ok ? 3500 : 6000);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function num(value) {
  return Number.isFinite(Number(value)) ? String(value) : esc(value);
}
</script>
</body>
</html>`;
