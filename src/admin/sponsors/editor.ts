export const SPONSOR_EDITOR_SCRIPT = /* js */ String.raw`
const sponsorDialog = $('sponsor-dialog');
const sponsorForm = $('sponsor-form');
const uuidPattern = '[a-fA-F0-9]{32}|[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}';
const uuidAttributes = 'autocomplete="off" spellcheck="false" maxlength="36" required pattern="' + uuidPattern + '"';
let sponsorEditing;
let sponsorSaving = false;

function sponsorField(label, id, attributes, value = '', hint = '') {
  return '<div class="field sponsor-field"><label for="' + id + '">' + label + '</label>' +
    '<input id="' + id + '" value="' + esc(value) + '" ' + attributes +
    (hint ? ' aria-describedby="' + id + '-hint"' : '') + '>' +
    (hint ? '<p class="hint" id="' + id + '-hint">' + hint + '</p>' : '') + '</div>';
}

function openSponsorEditor({ kind, uuid, order, account, name } = { kind: 'order' }) {
  sponsorDetails.close();
  sponsorEditing = { kind, uuid, order, account, orderId: order?.id.slice(3) || crypto.randomUUID() };
  const canRemove = kind === 'order' ? Boolean(order) : kind === 'account' && Boolean(uuid);
  $('sponsor-remove').hidden = !canRemove;
  $('sponsor-remove').textContent = kind === 'account' ? '解除绑定' : '删除订单';
  $('sponsor-confirm-text').textContent = kind === 'account'
    ? '解除绑定后，此账号的历史订单将回到待绑定列表。'
    : '删除此笔手动赞助？';
  $('sponsor-delete').textContent = kind === 'account' ? '确认解绑' : '确认删除';
  setConfirmSponsorRemoval(false);
  setSponsorError('');

  let field = 'sponsor-uuid';
  let fields;
  if (kind === 'order') {
    $('sponsor-editor-title').textContent = order ? '编辑手动订单' : '新增手动订单';
    fields = sponsorField('Minecraft UUID', 'sponsor-uuid', uuidAttributes, uuid) +
      sponsorField('实付金额（元）', 'sponsor-amount', 'required inputmode="decimal" pattern="[0-9]{1,12}(\\.[0-9]{1,2})?"', order?.amount) +
      sponsorField('付款时间（本地，选填）', 'sponsor-order-date', 'type="datetime-local" step="1"', localSponsorDate(order?.at));
    if (uuid && !order) field = 'sponsor-amount';
  } else if (kind === 'account') {
    $('sponsor-editor-title').textContent = uuid ? '编辑爱发电绑定' : '绑定爱发电账号';
    fields = '<p class="full sponsor-editor-account">' + esc(account.name || account.afdianUserId) + '</p>' +
      sponsorField('Minecraft UUID', 'sponsor-uuid', uuidAttributes, uuid,
        '此爱发电账号的历史订单将归到填写的玩家名下。');
  } else {
    $('sponsor-editor-title').textContent = '设置显示名称';
    field = 'sponsor-name';
    fields = sponsorField('显示名称（选填）', field, 'maxlength="64"', name,
      '留空时使用爱发电昵称或 Minecraft UUID。');
  }
  $('sponsor-fields').innerHTML = fields;
  const date = $('sponsor-order-date');
  sponsorEditing.originalDate = date?.value;
  sponsorDialog.showModal();
  $(field).focus();
}

function localSponsorDate(at) {
  if (!at) return '';
  const date = new Date(at * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19);
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
  for (const control of sponsorForm.querySelectorAll('button, input')) control.disabled = saving;
  $('sponsor-save').textContent = saving ? '正在保存…' : '保存';
}

async function saveSponsor(remove) {
  if (sponsorSaving || !sponsorEditing) return;
  const { kind, uuid, order, orderId, account, originalDate } = sponsorEditing;
  const target = $('sponsor-uuid')?.value.trim();
  let path;
  let body;
  if (kind === 'order') {
    path = '/sponsors/' + encodeURIComponent(order ? uuid : target) + '/orders/' + orderId;
    const date = $('sponsor-order-date').value;
    const amount = $('sponsor-amount').value.trim();
    const at = date ? Math.floor(new Date(date).getTime() / 1000) : 0;
    body = order ? {} : { amount, at };
    if (order && !remove) {
      if (target.toLowerCase().replaceAll('-', '') !== uuid.replaceAll('-', '')) body.uuid = target;
      if (Number(amount) !== Number(order.amount)) body.amount = { from: order.amount, to: amount };
      if (date !== originalDate && at !== order.at) body.at = { from: order.at, to: at };
      if (!Object.keys(body).length) {
        sponsorDialog.close();
        $('sponsor-search').focus();
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
    sponsorDialog.close();
    $('sponsor-search').focus();
    toast(remove ? (kind === 'account' ? '已解除绑定' : '订单已删除') : '已保存', true);
    await loadSponsors();
  } catch (error) {
    setSponsorError(error.message);
  } finally {
    setSponsorSaving(false);
  }
}

$('sponsor-add').addEventListener('click', () => openSponsorEditor());
$('sponsor-close').addEventListener('click', () => sponsorDialog.close());
$('sponsor-cancel').addEventListener('click', () => sponsorDialog.close());
sponsorDialog.addEventListener('cancel', (event) => { if (sponsorSaving) event.preventDefault(); });
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
