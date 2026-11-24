import { BUILDING_EDITOR_SCRIPT } from './editor';
import { ADMIN_GALLERY_SCRIPT } from './gallery';
import { BUILDING_IMPORT_SCRIPT } from './import';
import { BUILDINGS_LIST_SCRIPT } from './list';

export const BUILDINGS_SCRIPT = /* js */ `
const state = {
  buildings: [],
  submissions: [],
  editBuilding: null,
  reviewSubmission: null,
  busy: false,
  typeFilter: '',
  loadingBuildings: true,
  loadingSubmissions: false,
  buildingError: '',
  submissionError: '',
  importValid: false,
};
const typeLabel = { original: '原创', derivative: '二创', replica: '搬运' };

${BUILDINGS_LIST_SCRIPT}
${BUILDING_EDITOR_SCRIPT}
${BUILDING_IMPORT_SCRIPT}
${ADMIN_GALLERY_SCRIPT}

function setBusy(busy) {
  state.busy = busy;
  updateEditorControls();
  $('import-save-btn').disabled = busy || !state.importValid;
  $('refresh-btn').disabled = busy;
  $('refresh-btn').classList.toggle('is-loading', busy);
  $('save-btn').textContent = busy ? '正在保存…' : '保存建筑';
  $('import-save-btn').textContent = busy ? '正在处理…' : '确认导入';
  updateListControls();
}

$('refresh-btn').addEventListener('click', () => loadAll());
$('import-btn').addEventListener('click', openImport);
$('create-btn').addEventListener('click', openCreate);
loadAll();
`;
