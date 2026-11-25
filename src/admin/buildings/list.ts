import { icon } from '../icons';

export const BUILDINGS_LIST_HTML = /* html */ `
  <main id="main" tabindex="-1">
    <div class="module-head">
      <h1>建筑管理</h1>
      <div class="page-actions" id="building-actions">
        <button class="btn ghost" id="import-btn" type="button">${icon('import')}导入</button>
        <button class="btn primary" id="create-btn" type="button">${icon('plus')}新增建筑</button>
      </div>
    </div>
    <div class="workspace-bar">
      <div class="view-tabs" role="tablist" aria-label="建筑管理">
        <button class="view-tab" id="buildings-tab" type="button" role="tab" aria-selected="true" aria-controls="buildings-panel">建筑收录</button>
        <button class="view-tab" id="submissions-tab" type="button" role="tab" aria-selected="false" aria-controls="submissions-panel" tabindex="-1">待审申请<span id="pending-count" aria-hidden="true" hidden></span></button>
      </div>
      <div class="search-field" id="buildings-search">
        ${icon('search')}
        <label class="sr-only" for="search">搜索建筑、建造者、标签或 ID</label>
        <input id="search" type="search" placeholder="搜索建筑、建造者或标签" autocomplete="off">
        <button class="btn ghost icon-btn search-clear" id="search-clear" type="button" aria-label="清除搜索" hidden>${icon('close')}</button>
      </div>
    </div>
    <section id="buildings-panel" role="tabpanel" aria-labelledby="buildings-tab" tabindex="0">
      <div class="tools">
        <div class="filters" role="group" aria-label="建筑类型筛选">
          <button class="filter" type="button" data-type="" aria-pressed="true">全部</button>
          <button class="filter" type="button" data-type="original" aria-pressed="false">原创</button>
          <button class="filter" type="button" data-type="derivative" aria-pressed="false">二创</button>
          <button class="filter" type="button" data-type="replica" aria-pressed="false">搬运</button>
        </div>
        <p class="result-count" id="result-count" role="status"></p>
      </div>
      <table aria-label="已收录建筑">
        <colgroup><col class="col-building"><col class="col-location"><col class="col-type"><col><col class="col-date"><col class="col-actions"></colgroup>
        <thead><tr><th scope="col">建筑</th><th scope="col">所在位置</th><th scope="col">类型</th><th scope="col">建造者</th><th scope="col">建造日期</th><th scope="col">操作</th></tr></thead>
        <tbody id="rows"><tr><td colspan="6" class="empty-cell"><div class="empty">正在加载建筑…</div></td></tr></tbody>
      </table>
    </section>
    <section id="submissions-panel" role="tabpanel" aria-labelledby="submissions-tab" tabindex="0" hidden>
      <div id="submission-list" aria-busy="true"><p class="empty">正在加载申请…</p></div>
    </section>
  </main>
`;

export const BUILDINGS_LIST_SCRIPT = /* js */ `
$('search').addEventListener('input', render);
$('search-clear').addEventListener('click', clearSearch);
document.querySelectorAll('.filter').forEach((button) => {
  button.addEventListener('click', () => {
    state.typeFilter = button.dataset.type;
    document.querySelectorAll('.filter').forEach((chip) => {
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

function switchView(view) {
  for (const name of ['buildings', 'submissions']) {
    const selected = name === view;
    $(name + '-tab').setAttribute('aria-selected', String(selected));
    $(name + '-tab').tabIndex = selected ? 0 : -1;
    $(name + '-panel').hidden = !selected;
  }
  $('building-actions').hidden = view !== 'buildings';
  $('buildings-search').hidden = view !== 'buildings';
}

function clearSearch() {
  $('search').value = '';
  render();
  $('search').focus();
}

function updateListControls() {
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
    state.submissions = Array.isArray(data.submissions) ? data.submissions.filter((item) => item.status === 'pending') : [];
    updatePendingCount();
  } catch (error) {
    state.submissionError = error.message || '申请加载失败';
    toast(error.message || '申请加载失败', false);
  } finally {
    state.loadingSubmissions = false;
    renderSubmissions();
    if (manageBusy) setBusy(false);
  }
}

function updatePendingCount() {
  const count = state.submissions.length;
  $('pending-count').textContent = count;
  $('pending-count').hidden = count === 0;
  $('submissions-tab').setAttribute('aria-label', '待审申请，' + count + ' 条');
}

function updateBuildings(buildings) {
  const byId = new Map(state.buildings.map((building) => [building.id, building]));
  for (const building of buildings) byId.set(building.id, building);
  state.buildings = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  render();
}

function removePendingSubmission(id) {
  state.submissions = state.submissions.filter((submission) => submission.id !== id);
  updatePendingCount();
  renderSubmissions();
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
  $('result-count').textContent = !rows.length || state.loadingBuildings || state.buildingError ? '' : (query || type ? '找到 ' + rows.length + ' 座建筑' : '共 ' + rows.length + ' 座建筑');
  if (state.loadingBuildings && !state.buildings.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-cell"><div class="empty">正在加载建筑…</div></td></tr>';
    return;
  }
  const errorRow = state.buildingError
    ? '<tr><td colspan="6" class="empty-cell"><div class="empty"><strong>建筑加载失败</strong><p>' + esc(state.buildingError) + '</p><button class="btn ghost" type="button" data-action="retry">重新加载</button></div></td></tr>'
    : '';
  if (!rows.length) {
    const filtered = query || type;
    body.innerHTML = errorRow || '<tr><td colspan="6" class="empty-cell"><div class="empty">' + (filtered ? '没有匹配的建筑 <button class="btn ghost sm" type="button" data-action="reset">清除筛选</button>' : '暂无收录') + '</div></td></tr>';
    return;
  }
  body.innerHTML = errorRow + rows.map((building) => {
    const builders = [...(building.builders || [])].sort((a, b) => b.weight - a.weight).map((item) => item.name).join('、');
    const tags = (building.tags || []).map((tag) => tag['zh-CN'] || tag.en).filter(Boolean).join('、');
    return '<tr>' +
      '<td class="building-cell"><div class="building-summary">' + thumbnail(building.id, building.images[0]) +
      '<div><div class="title">' + esc(building.name && building.name['zh-CN']) +
      '</div><div class="meta">' + esc(building.name && building.name.en) +
      (tags ? ' · ' + esc(tags) : '') + '</div></div></div></td>' +
      '<td data-label="所在位置"><div class="mono">' + esc(building.coordinates && building.coordinates.world) + '</div><div class="mono">' + num(building.coordinates && building.coordinates.x) + ', ' + num(building.coordinates && building.coordinates.y) + ', ' + num(building.coordinates && building.coordinates.z) + '</div></td>' +
      '<td data-label="类型">' + esc(typeLabel[building.buildType] || building.buildType) + '</td>' +
      '<td data-label="建造者">' + esc(builders) + '</td>' +
      '<td data-label="建造日期"><span class="date">' + esc(building.buildDate) + '</span></td>' +
      '<td class="actions-cell"><div class="row-actions"><button class="btn ghost sm" type="button" data-action="edit" data-id="' + esc(building.id) + '" aria-label="编辑' + esc(building.name && building.name['zh-CN']) + '">编辑</button><button class="btn danger sm" type="button" data-action="delete" data-id="' + esc(building.id) + '" aria-label="删除' + esc(building.name && building.name['zh-CN']) + '">删除</button></div></td>' +
      '</tr>';
  }).join('');
  updateListControls();
}

function renderSubmissions() {
  const list = $('submission-list');
  list.setAttribute('aria-busy', String(state.loadingSubmissions));
  if (state.loadingSubmissions && !state.submissions.length) {
    list.innerHTML = '<div class="empty">正在加载申请</div>';
    return;
  }
  if (!state.submissions.length) {
    list.innerHTML = state.submissionError
      ? '<div class="empty"><strong>申请加载失败</strong><p>' + esc(state.submissionError) + '</p><button class="btn ghost" type="button" data-action="retry">重新加载</button></div>'
      : '<p class="empty">暂无待审申请</p>';
    return;
  }
  list.innerHTML = state.submissions.map((submission) => {
    const payload = submission.payload;
    const title = payload.name['zh-CN'] || payload.name.en;
    const coords = payload.coordinates;
    return '<article class="review-item">' + thumbnail(submission.id, payload.images[0]) +
      '<div><div class="title">' + esc(title) + '</div>' +
      '<div class="meta">' + esc(submission.submitterName) + ' · ' + esc(formatTime(submission.createdAt)) + '</div>' +
      '<div class="meta">' + esc(typeLabel[payload.buildType] || payload.buildType) + ' · ' +
        esc(coords.world) + ' ' + num(coords.x) + ', ' + num(coords.y) + ', ' + num(coords.z) +
      '</div></div>' +
      '<div class="row-actions"><button class="btn ghost sm" type="button" data-action="review" data-id="' + esc(submission.id) + '" aria-label="审核「' + esc(title) + '」">审核</button></div>' +
      '</article>';
  }).join('');
  updateListControls();
}

function thumbnail(id, image) {
  return image && imageBaseUrl
    ? buildingPicture(id, image, 'class="record-thumb" loading="lazy" decoding="async"')
    : '<span class="record-thumb record-thumb-empty">${icon('building')}</span>';
}

function handleBuildingTableClick(event) {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest('button[data-action]');
  if (!button || state.busy) return;
  if (button.dataset.action === 'retry') { loadBuildings(); return; }
  if (button.dataset.action === 'reset') {
    state.typeFilter = '';
    document.querySelectorAll('.filter').forEach((chip) => chip.setAttribute('aria-pressed', String(chip.dataset.type === '')));
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

async function deleteBuilding(id) {
  const building = state.buildings.find((item) => item.id === id);
  if (!building) return;
  const label = building.name ? building.name['zh-CN'] || building.name.en || id : id;
  if (!confirm('删除「' + label + '」？')) return;
  setBusy(true);
  try {
    const res = await fetch('/admin/api/buildings/' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: await contentHeaders(building),
    });
    const data = await readJson(res);
    if (res.status === 412) throw new Error('建筑已被修改，请刷新列表后再删除。');
    if (!res.ok) throw new Error(data.error || res.statusText);
    toast('已删除，公开页面稍后同步', true);
    state.buildings = state.buildings.filter((item) => item.id !== data.deleted);
    render();
  } catch (error) {
    toast(error.message || '删除失败', false);
  } finally {
    setBusy(false);
  }
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

function num(value) {
  return Number.isFinite(Number(value)) ? String(value) : esc(value);
}
`;
