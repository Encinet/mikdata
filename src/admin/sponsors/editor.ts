import { MAX_MANUAL_MESSAGE_LENGTH } from '../../sponsors/model';
import { SPONSOR_TIME_EDITOR_SCRIPT } from './time-editor';

export const SPONSOR_EDITOR_SCRIPT = /* js */ String.raw`
const sponsorDialog = $('sponsor-dialog');
const sponsorForm = $('sponsor-form');
const uuidPattern = '[a-fA-F0-9]{32}|[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}';
const uuidFormat = new RegExp('^(?:' + uuidPattern + ')$');
const uuidAttributes = 'autocomplete="off" spellcheck="false" maxlength="36" required pattern="' + uuidPattern + '"';
let sponsorEditing;
let sponsorSaving = false;

function sponsorField(label, id, attributes, value = '', hint = '') {
  return '<div class="field sponsor-field"><label for="' + id + '">' + label + '</label>' +
    '<input id="' + id + '" value="' + esc(value) + '" ' + attributes +
    (hint ? ' aria-describedby="' + id + '-hint"' : '') + '>' +
    (hint ? '<p class="hint" id="' + id + '-hint">' + hint + '</p>' : '') + '</div>';
}

${SPONSOR_TIME_EDITOR_SCRIPT}

function sponsorPlayerTarget(uuid, hint, singleField = false) {
  const searchAttributes = 'type="search" autocomplete="off" spellcheck="false" placeholder="搜索名称、爱发电账号或 UUID" aria-controls="sponsor-player-options"';
  return '<div class="full sponsor-player-target">' +
    (singleField
      ? sponsorField('订单归属', 'sponsor-player-search', searchAttributes + ' required', '', '选择搜索结果，或直接粘贴完整的 Minecraft UUID。')
      : sponsorField('查找已有赞助玩家', 'sponsor-player-search', searchAttributes)) +
    '<div id="sponsor-player-options" class="sponsor-player-options" hidden></div>' +
    (singleField ? '' : sponsorField('Minecraft UUID', 'sponsor-uuid', uuidAttributes, uuid, hint)) +
    '<p class="hint" id="sponsor-player-match" role="status" hidden></p></div>';
}

function canonicalSponsorUuid(value) {
  return value.trim().toLowerCase().replace(/^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/, '$1-$2-$3-$4-$5');
}

function renderSponsorPlayerOptions() {
  const search = $('sponsor-player-search');
  if (!sponsorDialog.open || sponsorSaving || !search) return;
  const uuidInput = $('sponsor-uuid');
  const selected = sponsorEditing.selectedPlayer;
  const uuid = selected?.uuid || canonicalSponsorUuid((uuidInput || search).value);
  const resolved = !uuidInput && uuidFormat.test(uuid);
  if (!uuidInput) {
    $('sponsor-player-search-hint').hidden = resolved;
    search.setAttribute('aria-describedby', resolved ? 'sponsor-player-match' : 'sponsor-player-search-hint');
    search.setCustomValidity(resolved ? '' : '请选择一位玩家，或粘贴完整的 Minecraft UUID。');
  }

  const options = $('sponsor-player-options');
  options.hidden = !search.value.trim() || resolved;
  const matches = options.hidden ? [] : findSponsors(sponsorData.players, search.value).slice(0, 6);
  const emptyMessage = sponsorCatalogLoad ? '正在加载赞助玩家…'
    : uuidInput ? '未找到已有赞助玩家，可直接填写 UUID。' : '未找到玩家。可在此处粘贴 Minecraft UUID。';
  options.innerHTML = options.hidden ? '' : matches.length ? matches.map((player) =>
    '<button class="sponsor-player-option" type="button" data-player-uuid="' + esc(player.uuid) + '">' +
    '<strong>' + esc(player.name) + '</strong>' +
    (player.name === player.uuid ? '' : '<span class="mono">' + esc(player.uuid) + '</span>') + '</button>',
  ).join('') : '<p class="hint">' + emptyMessage + '</p>';

  const match = $('sponsor-player-match');
  const player = selected || sponsorData.players.find((item) => item.uuid === uuid);
  let message = player && player.name !== uuid ? '玩家：' + player.name : '';
  if (resolved) {
    message = selected && selected.name !== uuid ? 'UUID：' + uuid
      : message || '将按此 UUID 录入。';
  }
  match.textContent = message;
  match.hidden = !message;
}

function openSponsorEditor({ kind, uuid, order, account, name } = { kind: 'order' }) {
  sponsorEditing = { kind, uuid, order, account, orderId: order?.id.slice(3) || crypto.randomUUID() };
  const canRemove = kind === 'order' ? Boolean(order) : kind === 'account' && Boolean(uuid);
  $('sponsor-remove').hidden = !canRemove;
  $('sponsor-remove').textContent = kind === 'account' ? '解除绑定' : '删除订单';
  $('sponsor-confirm-text').textContent = kind === 'account'
    ? '解除绑定后，此账号的历史订单将回到待绑定列表。'
    : '删除此笔手动赞助？';
  $('sponsor-delete').textContent = kind === 'account' ? '确认解绑' : '确认删除';
  $('sponsor-save').textContent = kind === 'account' && !uuid ? '确认绑定' : '保存';
  setConfirmSponsorRemoval(false);
  setSponsorError('');

  let field = 'sponsor-player-search';
  let fields;
  if (kind === 'order') {
    $('sponsor-editor-title').textContent = order ? '编辑手动订单' : '新增手动订单';
    const fixedPlayer = uuid && !order;
    const target = fixedPlayer
      ? '<div class="full sponsor-editor-account"><strong>' + esc(name || uuid) + '</strong>' +
        (name && name !== uuid ? '<div class="mono">' + esc(uuid) + '</div>' : '') + '</div>'
      : sponsorPlayerTarget(uuid, '可更换该订单所属的玩家。', !order);
    fields = target + '<div class="full sponsor-order-payment">' +
      sponsorField('实付金额（元）', 'sponsor-amount', 'required inputmode="decimal" pattern="[0-9]{1,12}(\\.[0-9]{1,2})?"', order?.amount) +
      sponsorTimeFields() + '</div>' +
      '<div class="field full"><label for="sponsor-order-message">公开留言（选填）</label>' +
      '<textarea id="sponsor-order-message" rows="3" maxlength="${MAX_MANUAL_MESSAGE_LENGTH}">' +
      esc(order?.message) + '</textarea></div>';
    if (fixedPlayer) field = 'sponsor-amount';
  } else if (kind === 'account') {
    $('sponsor-editor-title').textContent = uuid ? '编辑爱发电绑定' : '绑定爱发电账号';
    fields = '<p class="full sponsor-editor-account">' + esc(account.name || account.afdianUserId) + '</p>' +
      sponsorPlayerTarget(uuid, '此爱发电账号的历史订单将归到该玩家名下。');
  } else {
    $('sponsor-editor-title').textContent = '设置显示名称';
    field = 'sponsor-name';
    fields = sponsorField('显示名称（选填）', field, 'maxlength="64"', name,
      '留空时使用爱发电昵称或 Minecraft UUID。');
  }
  $('sponsor-fields').innerHTML = fields;
  if (kind === 'order') sponsorEditing.readTime = initSponsorTime(order?.at);
  sponsorDialog.showModal();
  renderSponsorPlayerOptions();
  $(field).focus();
}

function setSponsorError(message) {
  const error = $('sponsor-form-error');
  error.hidden = !message;
  error.textContent = message;
  if (message) error.focus();
}

function setConfirmSponsorRemoval(confirm) {
  $('sponsor-confirm').hidden = !confirm;
  $('sponsor-form-actions').hidden = confirm;
}

function setSponsorSaving(saving) {
  sponsorSaving = saving;
  sponsorForm.setAttribute('aria-busy', String(saving));
  for (const control of sponsorForm.querySelectorAll('button, input, select, textarea')) control.disabled = saving;
  $('sponsor-save').textContent = saving ? '正在保存…'
    : sponsorEditing.kind === 'account' && !sponsorEditing.uuid ? '确认绑定' : '保存';
}

async function saveSponsor(remove) {
  if (sponsorSaving || !sponsorEditing) return;
  const { kind, uuid, order, orderId, account } = sponsorEditing;
  const input = $('sponsor-uuid') || $('sponsor-player-search');
  const target = sponsorEditing.selectedPlayer?.uuid || (input ? canonicalSponsorUuid(input.value) : uuid);
  const route = sponsorRoute;
  let path;
  let body;
  if (kind === 'order') {
    path = '/sponsors/' + encodeURIComponent(order ? uuid : target) + '/orders/' + orderId;
    const amount = $('sponsor-amount').value.trim();
    const message = $('sponsor-order-message').value.trim();
    const at = sponsorEditing.readTime();
    if (!remove && at === undefined) {
      sponsorForm.reportValidity();
      return;
    }
    body = order ? {} : { amount, at };
    if (!order && message) body.message = message;
    if (order && !remove) {
      if (target !== uuid) body.uuid = target;
      if (Number(amount) !== Number(order.amount)) body.amount = { from: order.amount, to: amount };
      if (at !== order.at) body.at = { from: order.at, to: at };
      const originalMessage = order.message ?? '';
      if (message !== originalMessage) body.message = { from: originalMessage, to: message };
      if (!Object.keys(body).length) {
        sponsorDialog.close();
        return;
      }
    }
  } else if (kind === 'account') {
    path = '/sponsor-mappings' + (remove ? '/' + encodeURIComponent(account.afdianUserId) : '');
    body = { afdianUserId: account.afdianUserId, uuid: target };
  } else {
    path = '/sponsors/' + encodeURIComponent(uuid);
    body = { name: $('sponsor-name').value.trim() };
  }

  setSponsorError('');
  setSponsorSaving(true);
  try {
    await sponsorRequest(path, remove
      ? { method: 'DELETE' }
      : { method: order ? 'PATCH' : 'PUT', headers: writeHeaders(), body: JSON.stringify(body) });
  } catch (error) {
    setSponsorError(error.message);
    return;
  } finally {
    setSponsorSaving(false);
  }

  sponsorDialog.close();
  toast(remove ? (kind === 'account' ? '已解除绑定' : '订单已删除')
    : kind === 'account' && !uuid ? '已绑定爱发电账号' : kind === 'order' && !order ? '已新增手动订单' : '已保存', true);
  if (sponsorRoute !== route) {
    loadSponsors();
    if (sponsorRoute.id) loadSponsorDetails();
    return;
  }
  if (remove) {
    refreshAfterSponsorRemoval(route);
    return;
  }
  if (kind === 'account' && !uuid) {
    sponsorBindingNotice = { accountId: account.afdianUserId, name: account.name || account.afdianUserId, uuid: target };
    loadSponsors();
    if (route.id) returnToSponsorList();
    else $('sponsor-bound-player').focus();
    return;
  }

  loadSponsors();
  if (kind === 'order') {
    navigateSponsors(sponsorUrl('players', target), { replace: Boolean(route.id), orderId: 'mn:' + orderId });
  } else if (kind === 'account' && target !== uuid) {
    navigateSponsors(sponsorUrl('players', target), { replace: true });
  } else {
    $('sponsor-detail-title').focus();
    loadSponsorDetails();
  }
}

$('sponsor-add').addEventListener('click', () => openSponsorEditor());
$('sponsor-close').addEventListener('click', () => sponsorDialog.close());
$('sponsor-cancel').addEventListener('click', () => sponsorDialog.close());
sponsorDialog.addEventListener('cancel', (event) => { if (sponsorSaving) event.preventDefault(); });
sponsorForm.addEventListener('input', (event) => {
  if (event.target.id === 'sponsor-player-search') sponsorEditing.selectedPlayer = undefined;
  if (event.target.id === 'sponsor-player-search' || event.target.id === 'sponsor-uuid') renderSponsorPlayerOptions();
});
sponsorForm.addEventListener('keydown', (event) => {
  if (event.target.id === 'sponsor-player-search' && event.key === 'Enter') event.preventDefault();
});
$('sponsor-fields').addEventListener('click', (event) => {
  const option = event.target.closest('[data-player-uuid]');
  if (!option) return;
  const player = sponsorData.players.find((item) => item.uuid === option.dataset.playerUuid);
  if (!player) return;
  const search = $('sponsor-player-search');
  const uuid = $('sponsor-uuid');
  if (uuid) {
    uuid.value = player.uuid;
    search.value = '';
  } else {
    sponsorEditing.selectedPlayer = player;
    search.value = player.name;
  }
  renderSponsorPlayerOptions();
  ($('sponsor-amount') || uuid).focus();
});
sponsorForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if ($('sponsor-confirm').hidden) saveSponsor(false);
});
$('sponsor-remove').addEventListener('click', () => {
  setConfirmSponsorRemoval(true);
  $('sponsor-keep').focus();
});
$('sponsor-keep').addEventListener('click', () => {
  setConfirmSponsorRemoval(false);
  $('sponsor-remove').focus();
});
$('sponsor-delete').addEventListener('click', () => saveSponsor(true));
`;
