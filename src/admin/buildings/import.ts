import { icon } from '../icons';

export const BUILDING_IMPORT_HTML = /* html */ `
<dialog class="overlay" id="import-overlay" aria-labelledby="import-title" aria-describedby="import-hint">
  <form class="modal modal--import" id="import-form">
    <div class="modal-head">
      <div><h2 class="modal-title" id="import-title">导入建筑</h2><p class="modal-subtitle" id="import-hint">上传或粘贴 JSON，由系统分配 ID，导入后在图册添加图片。</p></div>
      <div class="grow"></div>
      <button class="btn ghost icon-btn" id="import-close-btn" type="button" aria-label="关闭导入">${icon('close')}</button>
    </div>
    <div class="modal-body">
      <div class="grid">
        <div class="field full"><label for="import-file">选择文件</label><input id="import-file" type="file" accept="application/json,.json"></div>
        <div class="field full"><label for="import-json">JSON 内容</label><textarea id="import-json" class="mono" spellcheck="false" placeholder="粘贴一个建筑对象或建筑数组" required></textarea></div>
        <div class="hint full" id="import-preview" role="status" aria-live="polite" hidden></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" id="import-cancel-btn" type="button">取消</button>
      <button class="btn primary" id="import-save-btn" type="submit" disabled>确认导入</button>
    </div>
  </form>
</dialog>
`;

export const BUILDING_IMPORT_SCRIPT = /* js */ `
$('import-close-btn').addEventListener('click', closeImport);
$('import-cancel-btn').addEventListener('click', closeImport);
$('import-overlay').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) closeImport();
});
$('import-overlay').addEventListener('cancel', (event) => { event.preventDefault(); closeImport(); });
$('import-form').addEventListener('submit', importBuildings);
$('import-file').addEventListener('change', readImportFile);
$('import-json').addEventListener('input', updateImportPreview);

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
  $('import-preview').hidden = !value;
  if (!value) return;

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
    const payload = { buildings: items };
    const res = await fetch('/admin/api/buildings/import', {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || res.statusText);

    toast('已导入 ' + data.buildings.length + ' 条，公开页面稍后同步', true);
    closeImport();
    updateBuildings(data.buildings);
  } catch (error) {
    toast(error.message || '导入失败', false);
  } finally {
    setBusy(false);
  }
}

`;
