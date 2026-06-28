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

const ADMIN_HTML = /* html */ `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MikData Admin</title>
<style nonce="__NONCE__">
  *, *::before, *::after { box-sizing: border-box; }
  :root {
    color-scheme: light;
    --bg: #f6f6f4;
    --surface: #ffffff;
    --surface-strong: #ffffff;
    --surface-muted: #f1f2ef;
    --input: #ffffff;
    --line: #dadfd6;
    --line-strong: #b9c0b4;
    --text: #1f2a23;
    --heading: #101814;
    --muted: #68736b;
    --muted-strong: #4f5a52;
    --topbar: #ffffff;
    --thead: #f4f5f2;
    --hover: #f8faf6;
    --overlay-bg: rgba(18, 24, 20, .42);
    --accent: #2f7d4a;
    --blue: #2563eb;
    --red: #b42318;
    --green: #207a4a;
    --amber: #9a5a06;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif;
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #111512;
    --surface: #171c18;
    --surface-strong: #1b211d;
    --surface-muted: #202720;
    --input: #111612;
    --line: #2c352d;
    --line-strong: #435045;
    --text: #dbe2dc;
    --heading: #fff;
    --muted: #879188;
    --muted-strong: #a9b3aa;
    --topbar: #171c18;
    --thead: #202720;
    --hover: #1c231e;
    --overlay-bg: rgba(0, 0, 0, .62);
    --accent: #5dbb76;
    --blue: #8ab4ff;
    --red: #f87171;
    --green: #7bd89a;
    --amber: #f2c15a;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --bg: #111512;
      --surface: #171c18;
      --surface-strong: #1b211d;
      --surface-muted: #202720;
      --input: #111612;
      --line: #2c352d;
      --line-strong: #435045;
      --text: #dbe2dc;
      --heading: #fff;
      --muted: #879188;
      --muted-strong: #a9b3aa;
      --topbar: #171c18;
      --thead: #202720;
      --hover: #1c231e;
      --overlay-bg: rgba(0, 0, 0, .62);
      --accent: #5dbb76;
      --blue: #8ab4ff;
      --red: #f87171;
      --green: #7bd89a;
      --amber: #f2c15a;
    }
  }
  body {
    margin: 0;
    min-height: 100vh;
    background: var(--bg);
    color: var(--text);
  }
  button, input, select, textarea { font: inherit; letter-spacing: 0; }
  button { border: 0; cursor: pointer; }
  button:disabled { cursor: not-allowed; opacity: .48; }
  input, select, textarea {
    width: 100%;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--input);
    color: var(--text);
    outline: none;
    padding: 8px 10px;
    transition: border-color .16s ease, background .16s ease, box-shadow .16s ease;
  }
  input:focus, select:focus, textarea:focus {
    border-color: color-mix(in srgb, var(--accent), white 18%);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent), transparent 82%);
  }
  textarea { min-height: 74px; resize: vertical; line-height: 1.5; }
  .app { min-height: 100vh; padding-bottom: 24px; }
  .topbar {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    min-height: 52px;
    align-items: center;
    gap: 10px;
    padding: 8px max(16px, calc((100vw - 1240px) / 2));
    border-bottom: 1px solid var(--line);
    background: var(--topbar);
  }
  .brand {
    display: inline-flex;
    align-items: center;
    color: var(--heading);
    font-size: 15px;
    font-weight: 760;
    white-space: nowrap;
  }
  .identity {
    display: inline-flex;
    min-height: 28px;
    align-items: center;
    color: var(--muted-strong);
    font-size: 12px;
    font-weight: 720;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 0 9px;
    background: var(--surface);
    white-space: nowrap;
  }
  .grow { flex: 1; }
  .btn {
    min-height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    border-radius: 6px;
    padding: 0 11px;
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
    transition: background .16s ease, border-color .16s ease, color .16s ease;
  }
  .primary {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
  }
  .primary:hover { filter: brightness(1.04); }
  .quiet { background: var(--surface); color: var(--text); border: 1px solid var(--line); }
  .quiet:hover { border-color: var(--line-strong); background: var(--surface-muted); }
  .danger {
    background: color-mix(in srgb, var(--red), transparent 92%);
    color: var(--red);
    border: 1px solid color-mix(in srgb, var(--red), transparent 68%);
  }
  .danger:hover { background: color-mix(in srgb, var(--red), transparent 86%); }
  .sm { min-height: 28px; padding: 0 9px; font-size: 12px; }
  main { width: min(1240px, calc(100vw - 28px)); margin: 18px auto 0; }
  .admin-hero {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  .admin-hero p {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }
  .admin-hero h1 {
    margin: 0;
    color: var(--heading);
    font-size: 22px;
    font-weight: 760;
    line-height: 1.2;
  }
  .summary { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  .stat {
    min-height: 0;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 6px 10px;
  }
  .stat span { color: var(--muted); font-size: 12px; font-weight: 650; }
  .stat strong { color: var(--heading); font-size: 16px; line-height: 1; font-weight: 760; letter-spacing: 0; }
  .tools {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 180px;
    gap: 10px;
    margin-bottom: 10px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--surface);
    padding: 8px;
  }
  .table {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 6px;
    overflow: auto;
  }
  table { width: 100%; min-width: 940px; border-collapse: collapse; }
  th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--thead);
    color: var(--muted);
    font-size: 11px;
    font-weight: 780;
    text-align: left;
    text-transform: uppercase;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
  }
  td { padding: 11px 12px; border-bottom: 1px solid var(--line); vertical-align: middle; font-size: 13px; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover td { background: var(--hover); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--muted); }
  .title { color: var(--heading); font-weight: 780; }
  .meta { color: var(--muted); font-size: 12px; margin-top: 4px; line-height: 1.45; }
  .badge { display: inline-flex; border-radius: 6px; padding: 3px 7px; font-size: 12px; font-weight: 700; }
  .original { background: color-mix(in srgb, var(--green), transparent 88%); color: var(--green); }
  .derivative { background: color-mix(in srgb, var(--blue), transparent 88%); color: var(--blue); }
  .replica { background: color-mix(in srgb, var(--amber), transparent 88%); color: var(--amber); }
  .row-actions { display: flex; flex-wrap: wrap; gap: 7px; }
  .empty { color: var(--muted); text-align: center; padding: 28px 12px; }
  .review-board {
    margin-top: 16px;
    display: grid;
    gap: 8px;
  }
  .review-board__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .review-board__head h2 {
    margin: 0;
    color: var(--heading);
    font-size: 16px;
    line-height: 1.1;
  }
  .review-board__head p { display: none; }
  .review-list {
    display: grid;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--surface);
  }
  .review-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    border-bottom: 1px solid var(--line);
    padding: 11px 12px;
  }
  .review-item:last-child { border-bottom: 0; }
  .review-item__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 6px;
  }
  .status-pending { background: color-mix(in srgb, var(--amber), transparent 88%); color: var(--amber); }
  .status-approved { background: color-mix(in srgb, var(--green), transparent 88%); color: var(--green); }
  .status-rejected { background: color-mix(in srgb, var(--red), transparent 88%); color: var(--red); }
  .overlay {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 50;
    padding: 18px;
    align-items: center;
    justify-content: center;
    background: var(--overlay-bg);
    backdrop-filter: blur(6px);
  }
  .overlay.open { display: flex; }
  .modal {
    width: min(820px, 100%);
    max-height: calc(100vh - 36px);
    display: grid;
    grid-template-rows: auto 1fr auto;
    background: var(--surface-strong);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: 0 22px 70px rgba(0, 0, 0, .28);
    overflow: hidden;
  }
  .modal-head, .modal-foot { display: flex; align-items: center; gap: 8px; padding: 12px 14px; }
  .modal-head { border-bottom: 1px solid var(--line); background: var(--surface-muted); }
  .modal-foot { border-top: 1px solid var(--line); justify-content: flex-end; background: var(--surface-muted); }
  .modal-title { color: var(--heading); font-weight: 820; }
  .modal-body { overflow: auto; padding: 14px; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px; }
  .field { display: grid; gap: 5px; }
  .full { grid-column: 1 / -1; }
  label { color: var(--muted-strong); font-size: 12px; font-weight: 760; }
  .section {
    grid-column: 1 / -1;
    padding-top: 10px;
    border-top: 1px solid var(--line);
    color: var(--heading);
    font-weight: 740;
    font-size: 13px;
  }
  .section:first-child { padding-top: 0; border-top: 0; }
  .preview {
    grid-column: 1 / -1;
    min-height: 40px;
    display: flex;
    align-items: center;
    color: var(--muted-strong);
    font-size: 13px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--surface-muted);
    padding: 9px 11px;
  }
  #toast {
    position: fixed;
    right: 18px;
    bottom: 18px;
    z-index: 80;
    width: min(380px, calc(100vw - 36px));
    transform: translateY(140%);
    transition: transform .2s ease;
    border-radius: 8px;
    padding: 13px 14px;
    background: var(--surface-strong);
    border: 1px solid var(--line);
    box-shadow: 0 14px 42px rgba(0, 0, 0, .2);
    color: var(--text);
    font-size: 14px;
  }
  #toast.show { transform: translateY(0); }
  #toast.ok { border-left: 4px solid var(--green); }
  #toast.err { border-left: 4px solid var(--red); }
  @media (max-width: 760px) {
    .topbar { padding: 10px 12px; flex-wrap: wrap; }
    .brand { width: 100%; }
    .identity { flex: 1; }
    main { width: calc(100vw - 20px); margin-top: 16px; }
    .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .tools { grid-template-columns: 1fr; }
    .grid { grid-template-columns: 1fr; }
    .modal-head, .modal-foot { padding: 12px; }
    .modal-body { padding: 14px; }
  }
</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <div class="brand">MikData</div>
    <div class="identity">Cloudflare Access</div>
    <div class="grow"></div>
    <button class="btn quiet sm" id="theme-btn" type="button">系统</button>
    <button class="btn quiet" id="refresh-btn" type="button">刷新</button>
    <button class="btn quiet" id="import-btn" type="button">导入</button>
    <button class="btn primary" id="create-btn" type="button">新增</button>
  </header>
  <main>
    <section class="admin-hero">
      <h1>建筑收录管理</h1>
      <p id="admin-status">建筑 0 · 申请 0</p>
    </section>
    <section class="summary">
      <div class="stat"><span>总数</span><strong id="s-total">0</strong></div>
      <div class="stat"><span>原创</span><strong id="s-original">0</strong></div>
      <div class="stat"><span>二创</span><strong id="s-derivative">0</strong></div>
      <div class="stat"><span>复刻</span><strong id="s-replica">0</strong></div>
    </section>
    <div class="tools">
      <input id="search" placeholder="搜索建筑、建造者、标签" autocomplete="off">
      <select id="type-filter">
        <option value="">全部类型</option>
        <option value="original">原创</option>
        <option value="derivative">二创</option>
        <option value="replica">复刻</option>
      </select>
    </div>
    <div class="table">
      <table>
        <thead>
          <tr><th>ID</th><th>建筑</th><th>坐标</th><th>类型</th><th>建造者</th><th>日期</th><th>操作</th></tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <section class="review-board">
      <div class="review-board__head">
        <div>
          <h2>玩家建筑申请</h2>
        </div>
        <button class="btn quiet sm" id="submissions-refresh-btn" type="button">刷新申请</button>
      </div>
      <div class="review-list" id="submission-list"></div>
    </section>
  </main>
</div>
<div class="overlay" id="overlay">
  <form class="modal" id="building-form">
    <div class="modal-head">
      <div class="modal-title" id="modal-title">新增建筑</div>
      <div class="grow"></div>
      <button class="btn quiet sm" id="close-btn" type="button">关闭</button>
    </div>
    <div class="modal-body">
      <div class="grid">
        <div class="section">基本信息</div>
        <div class="field"><label for="name-zh">名称 zh-CN</label><input id="name-zh" maxlength="200" required></div>
        <div class="field"><label for="name-en">名称 en</label><input id="name-en" maxlength="200" required></div>
        <div class="field full"><label for="desc-zh">描述 zh-CN</label><textarea id="desc-zh" maxlength="2000" required></textarea></div>
        <div class="field full"><label for="desc-en">描述 en</label><textarea id="desc-en" maxlength="2000" required></textarea></div>
        <div class="section">坐标</div>
        <div class="field"><label for="coord-x">X</label><input id="coord-x" type="number" value="0" required></div>
        <div class="field"><label for="coord-y">Y</label><input id="coord-y" type="number" value="64" required></div>
        <div class="field"><label for="coord-z">Z</label><input id="coord-z" type="number" value="0" required></div>
        <div class="field"><label for="build-type">类型</label><select id="build-type"><option value="original">original</option><option value="derivative">derivative</option><option value="replica">replica</option></select></div>
        <div class="section">内容</div>
        <div class="field full"><label for="builders">建造者，每行 name,uuid,weight</label><textarea id="builders" required></textarea></div>
        <div class="field full"><label for="images">图片，每行一个 /path 或 https:// URL</label><textarea id="images" required></textarea></div>
        <div class="field"><label for="build-date">建造日期</label><input id="build-date" type="date" required></div>
        <div class="field full"><label for="tags">标签，每行 zh-CN,en</label><textarea id="tags"></textarea></div>
        <div class="section">来源</div>
        <div class="field"><label for="source-author">原作者</label><input id="source-author" maxlength="200"></div>
        <div class="field"><label for="source-link">原作链接</label><input id="source-link" maxlength="500"></div>
        <div class="field full"><label for="source-note-zh">备注 zh-CN</label><input id="source-note-zh" maxlength="500"></div>
        <div class="field full"><label for="source-note-en">备注 en</label><input id="source-note-en" maxlength="500"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn quiet" id="cancel-btn" type="button">取消</button>
      <button class="btn quiet" id="review-save-btn" type="button">保存修改</button>
      <button class="btn danger" id="review-reject-btn" type="button">拒绝</button>
      <button class="btn primary" id="review-approve-btn" type="button">批准收入</button>
      <button class="btn primary" id="save-btn" type="submit">保存</button>
    </div>
  </form>
</div>
<div class="overlay" id="import-overlay">
  <form class="modal" id="import-form">
    <div class="modal-head">
      <div class="modal-title">导入 JSON</div>
      <div class="grow"></div>
      <button class="btn quiet sm" id="import-close-btn" type="button">关闭</button>
    </div>
    <div class="modal-body">
      <div class="grid">
        <div class="field full"><label for="import-file">JSON 文件</label><input id="import-file" type="file" accept="application/json,.json"></div>
        <div class="field full"><label for="import-json">JSON</label><textarea id="import-json" class="mono" spellcheck="false"></textarea></div>
        <div class="preview" id="import-preview">等待 JSON</div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn quiet" id="import-cancel-btn" type="button">取消</button>
      <button class="btn primary" id="import-save-btn" type="submit">导入</button>
    </div>
  </form>
</div>
<div id="toast"></div>
<script nonce="__NONCE__">
const THEME_KEY = 'mikdata-admin-theme';
const THEMES = ['system', 'light', 'dark'];
const themeLabel = { system: '系统', light: '浅色', dark: '深色' };
const state = {
  buildings: [],
  submissions: [],
  editId: null,
  reviewId: null,
  busy: false,
  theme: readTheme(),
};
const typeLabel = { original: '原创', derivative: '二创', replica: '复刻' };
const $ = (id) => document.getElementById(id);

applyTheme();
$('theme-btn').addEventListener('click', cycleTheme);
$('refresh-btn').addEventListener('click', loadAll);
$('submissions-refresh-btn').addEventListener('click', loadSubmissions);
$('import-btn').addEventListener('click', openImport);
$('create-btn').addEventListener('click', openCreate);
$('search').addEventListener('input', render);
$('type-filter').addEventListener('change', render);
$('close-btn').addEventListener('click', closeModal);
$('cancel-btn').addEventListener('click', closeModal);
$('overlay').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) closeModal();
});
$('building-form').addEventListener('submit', saveBuilding);
$('review-save-btn').addEventListener('click', saveSubmissionEdit);
$('review-approve-btn').addEventListener('click', approveSubmission);
$('review-reject-btn').addEventListener('click', rejectSubmission);
$('import-close-btn').addEventListener('click', closeImport);
$('import-cancel-btn').addEventListener('click', closeImport);
$('import-overlay').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) closeImport();
});
$('import-form').addEventListener('submit', importBuildings);
$('import-file').addEventListener('change', readImportFile);
$('import-json').addEventListener('input', updateImportPreview);

updateAuthState();
setReviewMode(false);
loadAll();

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

  $('theme-btn').textContent = themeLabel[state.theme];
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
  render();
  renderSubmissions();
}

async function loadAll() {
  setBusy(true);
  try {
    await Promise.all([loadBuildings(false), loadSubmissions(false)]);
  } finally {
    setBusy(false);
  }
}

async function loadBuildings(manageBusy = true) {
  if (manageBusy) setBusy(true);
  try {
    const res = await fetch('/admin/api/buildings', { cache: 'no-store' });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || res.statusText);
    state.buildings = Array.isArray(data) ? data : [];
    updateStats();
    render();
  } catch (error) {
    toast(error.message || '加载失败', false);
  } finally {
    if (manageBusy) setBusy(false);
  }
}

async function loadSubmissions(manageBusy = true) {
  if (manageBusy) setBusy(true);
  try {
    const res = await fetch('/admin/api/building-submissions', { cache: 'no-store' });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || res.statusText);
    state.submissions = Array.isArray(data.submissions) ? data.submissions : [];
    updateAdminStatus();
    renderSubmissions();
  } catch (error) {
    toast(error.message || '申请加载失败', false);
  } finally {
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
  $('admin-status').textContent = '建筑 ' + state.buildings.length + ' · 待审 ' + pending;
}

function render() {
  const query = $('search').value.trim().toLowerCase();
  const type = $('type-filter').value;
  const rows = state.buildings.filter((building) => {
    if (type && building.buildType !== type) return false;
    return !query || searchableText(building).includes(query);
  });
  const body = $('rows');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7"><div class="empty">暂无数据</div></td></tr>';
    return;
  }
  body.innerHTML = rows.map((building) => {
    const builders = [...(building.builders || [])].sort((a, b) => b.weight - a.weight).map((item) => item.name).join('、');
    const tags = (building.tags || []).map((tag) => tag['zh-CN'] || tag.en).filter(Boolean).join('、');
    const disabled = state.busy ? ' disabled' : '';
    return '<tr>' +
      '<td><span class="mono">' + esc(building.id) + '</span></td>' +
      '<td><div class="title">' + esc(building.name && building.name['zh-CN']) + '</div><div class="meta">' + esc(building.name && building.name.en) + '</div>' + (tags ? '<div class="meta">' + esc(tags) + '</div>' : '') + '</td>' +
      '<td><span class="mono">(' + num(building.coordinates && building.coordinates.x) + ', ' + num(building.coordinates && building.coordinates.y) + ', ' + num(building.coordinates && building.coordinates.z) + ')</span></td>' +
      '<td><span class="badge ' + esc(building.buildType) + '">' + esc(typeLabel[building.buildType] || building.buildType) + '</span></td>' +
      '<td>' + esc(builders) + '</td>' +
      '<td><span class="mono">' + esc(building.buildDate) + '</span></td>' +
      '<td><div class="row-actions"><button class="btn quiet sm" type="button" data-action="edit" data-id="' + esc(building.id) + '"' + disabled + '>编辑</button><button class="btn danger sm" type="button" data-action="delete" data-id="' + esc(building.id) + '"' + disabled + '>删除</button></div></td>' +
      '</tr>';
  }).join('');
  body.querySelectorAll('button[data-action="edit"]').forEach((button) => {
    button.addEventListener('click', () => openEdit(button.dataset.id));
  });
  body.querySelectorAll('button[data-action="delete"]').forEach((button) => {
    button.addEventListener('click', () => deleteBuilding(button.dataset.id));
  });
}

function renderSubmissions() {
  const list = $('submission-list');
  const pendingFirst = [...state.submissions].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
  if (!pendingFirst.length) {
    list.innerHTML = '<div class="empty">暂无玩家申请</div>';
    return;
  }
  list.innerHTML = pendingFirst.map((submission) => {
    const payload = submission.payload || {};
    const title = payload.name && (payload.name['zh-CN'] || payload.name.en) || submission.id;
    const builders = (payload.builders || []).map((item) => item.name).filter(Boolean).join('、');
    const coords = payload.coordinates || {};
    const disabled = state.busy || submission.status !== 'pending' ? ' disabled' : '';
    const note = submission.reviewNote ? '<div class="meta">备注：' + esc(submission.reviewNote) + '</div>' : '';
    return '<article class="review-item">' +
      '<div><div class="title">' + esc(title) + '</div>' +
      '<div class="meta">提交者：' + esc(submission.submitterName) + ' · ' + esc(formatTime(submission.createdAt)) + '</div>' +
      '<div class="meta">坐标：(' + num(coords.x) + ', ' + num(coords.y) + ', ' + num(coords.z) + ') · 建造者：' + esc(builders || '-') + '</div>' +
      note +
      '<div class="review-item__meta"><span class="badge status-' + esc(submission.status) + '">' + esc(statusLabel(submission.status)) + '</span><span class="badge ' + esc(payload.buildType || '') + '">' + esc(typeLabel[payload.buildType] || payload.buildType || '-') + '</span></div></div>' +
      '<div class="row-actions"><button class="btn quiet sm" type="button" data-action="review" data-id="' + esc(submission.id) + '"' + disabled + '>编辑审核</button></div>' +
      '</article>';
  }).join('');
  list.querySelectorAll('button[data-action="review"]').forEach((button) => {
    button.addEventListener('click', () => openSubmissionReview(button.dataset.id));
  });
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
  $('coord-x').value = '0';
  $('coord-y').value = '64';
  $('coord-z').value = '0';
  $('build-type').value = 'original';
  $('build-date').value = new Date().toISOString().slice(0, 10);
  setReviewMode(false);
  $('overlay').classList.add('open');
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
  $('overlay').classList.add('open');
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
  $('overlay').classList.add('open');
  $('name-zh').focus();
}

function closeModal() {
  $('overlay').classList.remove('open');
  state.editId = null;
  state.reviewId = null;
  setReviewMode(false);
}

function setReviewMode(isReview) {
  $('save-btn').style.display = isReview ? 'none' : '';
  $('review-save-btn').style.display = isReview ? '' : 'none';
  $('review-reject-btn').style.display = isReview ? '' : 'none';
  $('review-approve-btn').style.display = isReview ? '' : 'none';
}

function openImport() {
  $('import-form').reset();
  $('import-json').value = '';
  updateImportPreview();
  $('import-overlay').classList.add('open');
  $('import-json').focus();
}

function closeImport() {
  $('import-overlay').classList.remove('open');
}

function fillForm(building) {
  $('name-zh').value = building.name && building.name['zh-CN'] || '';
  $('name-en').value = building.name && building.name.en || '';
  $('desc-zh').value = building.description && building.description['zh-CN'] || '';
  $('desc-en').value = building.description && building.description.en || '';
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
      headers: writeHeaders(),
      body: JSON.stringify(toPayload()),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || res.statusText);
    toast(isEdit ? '已更新' : '已创建', true);
    closeModal();
    await loadBuildings();
  } catch (error) {
    toast(error.message || '保存失败', false);
  } finally {
    setBusy(false);
  }
}

async function saveSubmissionEdit() {
  const submission = currentReviewSubmission();
  if (!submission) return;
  setBusy(true);
  try {
    const payload = toPayload();
    const res = await fetch('/admin/api/building-submissions/' + encodeURIComponent(submission.id), {
      method: 'PUT',
      headers: writeHeaders(),
      body: JSON.stringify({
        payload,
        images: imageMetadataForPayload(payload, submission.images || []),
      }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || res.statusText);
    toast('申请已保存', true);
    await loadSubmissions();
  } catch (error) {
    toast(error.message || '保存申请失败', false);
  } finally {
    setBusy(false);
  }
}

async function approveSubmission() {
  const submission = currentReviewSubmission();
  if (!submission) return;
  setBusy(true);
  try {
    const payload = toPayload();
    const res = await fetch('/admin/api/building-submissions/' + encodeURIComponent(submission.id) + '/approve', {
      method: 'PUT',
      headers: writeHeaders(),
      body: JSON.stringify({
        payload,
        images: imageMetadataForPayload(payload, submission.images || []),
      }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || res.statusText);
    toast('已批准并收入建筑', true);
    closeModal();
    await loadAll();
  } catch (error) {
    toast(error.message || '批准失败', false);
  } finally {
    setBusy(false);
  }
}

async function rejectSubmission() {
  const submission = currentReviewSubmission();
  if (!submission) return;
  const reviewNote = prompt('拒绝原因');
  if (!reviewNote || !reviewNote.trim()) return;
  setBusy(true);
  try {
    const res = await fetch('/admin/api/building-submissions/' + encodeURIComponent(submission.id) + '/reject', {
      method: 'PUT',
      headers: writeHeaders(),
      body: JSON.stringify({ reviewNote: reviewNote.trim() }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || res.statusText);
    toast('已拒绝', true);
    closeModal();
    await loadSubmissions();
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
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || res.statusText);
    toast('已删除', true);
    await loadBuildings();
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

  if (!value) {
    $('import-preview').textContent = '等待 JSON';
    return;
  }

  try {
    const parsed = JSON.parse(value);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    $('import-preview').textContent = '将导入 ' + items.length + ' 条';
  } catch {
    $('import-preview').textContent = 'JSON 格式错误';
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

    toast('已导入 ' + data.imported + ' 条', true);
    closeImport();
    await loadBuildings();
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
    coordinates: { x: Number($('coord-x').value), y: Number($('coord-y').value), z: Number($('coord-z').value) },
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

function writeHeaders() {
  return { 'Content-Type': 'application/json' };
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
  $('import-save-btn').disabled = busy;
  $('refresh-btn').disabled = busy;
  $('submissions-refresh-btn').disabled = busy;
  updateAuthState();
}

let toastTimer;
function toast(message, ok) {
  const el = $('toast');
  el.textContent = message;
  el.className = 'show ' + (ok ? 'ok' : 'err');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2600);
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
