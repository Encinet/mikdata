import { icon } from '../icons';
import { ADMIN_GALLERY } from './gallery';

export const BUILDING_EDITOR_HTML = /* html */ `
<dialog class="overlay" id="overlay" aria-labelledby="modal-title">
  <form class="modal" id="building-form">
    <div class="modal-head">
      <h2 class="modal-title" id="modal-title">新增建筑</h2>
      <div class="grow"></div>
      <button class="btn ghost sm" id="gallery-jump" type="button">图片</button>
      <button class="btn ghost icon-btn" id="close-btn" type="button" aria-label="关闭编辑">${icon('close')}</button>
    </div>
    <div class="modal-body editor-body">
      <div class="grid">
        <div class="field"><label for="name-zh">中文名称 *</label><input id="name-zh" lang="zh-CN" maxlength="200" required></div>
        <div class="field"><label for="name-en">英文名称 *</label><input id="name-en" lang="en" maxlength="200" required></div>
        <div class="field"><label for="desc-zh">中文描述 *</label><textarea id="desc-zh" lang="zh-CN" maxlength="2000" required></textarea></div>
        <div class="field"><label for="desc-en">英文描述 *</label><textarea id="desc-en" lang="en" maxlength="2000" required></textarea></div>
        <div class="field"><label for="build-type">建筑类型</label><select id="build-type"><option value="original">原创</option><option value="derivative">二创</option><option value="replica">复刻</option></select></div>
        <div class="field"><label for="build-date">建造日期 *</label><input id="build-date" type="date" required></div>
        <h3 class="section">坐标</h3>
        <div class="coordinate-grid full">
          <div class="field"><label for="coord-world">世界 *</label><input id="coord-world" value="world" maxlength="128" required></div>
          <div class="field"><label for="coord-x">X *</label><input id="coord-x" type="number" value="0" required></div>
          <div class="field"><label for="coord-y">Y *</label><input id="coord-y" type="number" value="64" required></div>
          <div class="field"><label for="coord-z">Z *</label><input id="coord-z" type="number" value="0" required></div>
        </div>
        <div class="field full"><label for="builders">建造者 *</label><textarea id="builders" aria-describedby="builders-hint" spellcheck="false" required></textarea><p class="hint" id="builders-hint">每行一位，依次填写名称、UUID、贡献权重，用英文逗号分隔。</p></div>
        <div class="field full"><label for="tags">标签</label><textarea id="tags" aria-describedby="tags-hint"></textarea><p class="hint" id="tags-hint">每行一个标签，中文和英文用英文逗号分隔。</p></div>
        <details class="source-fields full" id="source-fields">
          <summary>来源与备注</summary>
          <div class="grid">
            <div class="field"><label for="source-author">原作者</label><input id="source-author" maxlength="200"></div>
            <div class="field"><label for="source-link">原作链接</label><input id="source-link" type="url" maxlength="500"></div>
            <div class="field full"><label for="source-note-zh">中文备注</label><input id="source-note-zh" maxlength="500"></div>
            <div class="field full"><label for="source-note-en">英文备注</label><input id="source-note-en" maxlength="500"></div>
          </div>
        </details>
      </div>
      ${ADMIN_GALLERY}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" id="cancel-btn" type="button">取消</button>
      <button class="btn ghost" id="review-save-btn" type="button" hidden>保存修改</button>
      <button class="btn danger" id="review-reject-btn" type="button" hidden>退回申请</button>
      <button class="btn primary" id="review-approve-btn" type="button" hidden>批准收录</button>
      <button class="btn primary" id="save-btn" type="submit">保存建筑</button>
    </div>
  </form>
</dialog>
`;

export const BUILDING_EDITOR_SCRIPT = /* js */ `
$('close-btn').addEventListener('click', dismissEditor);
$('gallery-jump').addEventListener('click', () => {
  $('gallery-title').focus();
  $('gallery').scrollIntoView({ block: 'start' });
});
$('cancel-btn').addEventListener('click', dismissEditor);
$('overlay').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) dismissEditor();
});
$('overlay').addEventListener('cancel', (event) => { event.preventDefault(); dismissEditor(); });
$('building-form').addEventListener('submit', saveBuilding);
$('review-save-btn').addEventListener('click', saveSubmissionEdit);
$('review-approve-btn').addEventListener('click', approveSubmission);
$('review-reject-btn').addEventListener('click', rejectSubmission);

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
  resetGallery([]);
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
  resetGallery(building.images.map((url) => ({ url })), id);
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
  resetGallery([...submission.images], id);
  setReviewMode(true);
  $('overlay').showModal();
  $('overlay').querySelector('.modal-body').scrollTop = 0;
  $('name-zh').focus();
}

function dismissEditor() {
  if (!state.busy && !gallery.uploading) closeModal();
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
  if (state.busy || gallery.uploading) return;
  if (state.reviewId) {
    await saveSubmissionEdit();
    return;
  }
  setBusy(true);
  try {
    const isEdit = Boolean(state.editId);
    const res = await fetch(isEdit ? '/admin/api/buildings/' + encodeURIComponent(state.editId) : '/admin/api/buildings', {
      method: isEdit ? 'PUT' : 'POST',
      headers: editorHeaders(isEdit ? expectedBuildingHeader(state.editId) : {}),
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
  if (!submission || state.busy || gallery.uploading) return;
  if (!reviewFormValid()) return;
  setBusy(true);
  try {
    const payload = toPayload();
    const res = await fetch('/admin/api/building-submissions/' + encodeURIComponent(submission.id), {
      method: 'PUT',
      headers: editorHeaders(expectedSubmissionHeader(submission)),
      body: JSON.stringify({
        payload,
        images: gallery.images,
      }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || res.statusText);
    Object.assign(submission, data.submission);
    renderSubmissions();
    toast('申请已保存', true);
  } catch (error) {
    toast(error.message || '保存申请失败', false);
  } finally {
    setBusy(false);
  }
}

async function approveSubmission() {
  const submission = currentReviewSubmission();
  if (!submission || state.busy || gallery.uploading) return;
  if (!reviewFormValid()) return;
  setBusy(true);
  try {
    const payload = toPayload();
    const res = await fetch('/admin/api/building-submissions/' + encodeURIComponent(submission.id) + '/approve', {
      method: 'PUT',
      headers: editorHeaders(expectedSubmissionHeader(submission)),
      body: JSON.stringify({
        payload,
        images: gallery.images,
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
  if (!submission || state.busy || gallery.uploading) return;
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
    images: gallery.images.map((image) => image.url),
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

function reviewFormValid() {
  if (!$('building-form').reportValidity()) return false;
  if (gallery.images.length) return true;
  toast('待审申请至少需要一张图片', false);
  $('gallery-add').focus();
  return false;
}

function editorHeaders(extra) {
  return writeHeaders({ ...extra, 'X-Building-Draft': gallery.draft });
}

function expectedSubmissionHeader(submission) {
  return submission && submission.updatedAt ? { 'X-Expected-Updated-At': submission.updatedAt } : {};
}

function updateEditorControls() {
  const locked = state.busy || gallery.uploading;
  for (const id of ['save-btn', 'review-save-btn', 'review-reject-btn', 'review-approve-btn', 'close-btn', 'cancel-btn']) {
    $(id).disabled = locked;
  }
  updateGalleryControls();
}
`;
