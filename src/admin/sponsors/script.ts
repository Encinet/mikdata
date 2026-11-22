import { SPONSOR_EDITOR_SCRIPT } from './editor';

export const SPONSORS_SCRIPT = /* js */ String.raw`
const sponsorViews = [...document.querySelectorAll('[data-sponsor-view]')];
const sponsorDetails = $('sponsor-details');
const sponsorSearch = $('sponsor-search');
const sponsorList = $('sponsor-list');
const sponsorDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const sponsorStatusMessages = {
  unavailable: '爱发电暂不可用。手动订单仍可查看和编辑。',
  stale: '正在显示上一次同步的爱发电数据。',
  partial: '爱发电订单历史不完整，受影响的玩家暂不显示累计金额。',
};
let sponsorData = { players: [], pending: [] };
let sponsorView = 'all';
let sponsorLoading = false;
let sponsorLoadError = '';
let sponsorDetail;
let sponsorDetailLoad;
let sponsorDetailTrigger;

async function sponsorRequest(path, options) {
  const response = await fetch('/admin/api' + path, options).catch(() => {
    throw new Error('无法连接管理后台，请重试。');
  });
  if (response.status === 204) return;
  if (!response.ok) {
    const message = {
      400: '字段有误，请检查后重试。',
      401: '管理会话已过期，请刷新页面后重新登录。',
      403: '此操作需要管理权限。',
      404: '记录已不存在，请刷新列表。',
      409: '数据已更新，请刷新后重试。',
      413: '请求内容过长。',
      429: '操作过于频繁，请稍后重试。',
      503: '赞助数据暂不可用，请稍后重试。',
    }[response.status];
    throw new Error(message || '请求失败，请重试。');
  }
  return response.json().catch(() => {
    throw new Error('后台未返回赞助数据，请刷新页面后重试。');
  });
}

function visibleSponsors() {
  const query = sponsorSearch.value.trim().toLowerCase();
  const uuidQuery = /^[a-f0-9-]+$/.test(query) ? query.replaceAll('-', '') : '';
  const records = sponsorView === 'all' ? [...sponsorData.players, ...sponsorData.pending]
    : sponsorData[sponsorView];
  return records.filter((record) => !query || [record.name, record.uuid, ...record.accounts.flatMap(
    (account) => [account.name, account.afdianUserId],
  )].some((value) => value?.toLowerCase().includes(query)) ||
    (uuidQuery && record.uuid?.replaceAll('-', '').includes(uuidQuery)))
    .sort((a, b) => Number(!a.uuid) - Number(!b.uuid) || a.name.localeCompare(b.name, 'zh-CN'));
}

function renderSponsors() {
  const records = visibleSponsors();
  const searching = Boolean(sponsorSearch.value.trim());
  const message = sponsorLoadError || sponsorStatusMessages[sponsorData.afdianStatus];
  $('refresh-btn').disabled = sponsorLoading;
  $('refresh-btn').classList.toggle('is-loading', sponsorLoading);
  $('sponsor-add').disabled = sponsorLoading;
  sponsorList.setAttribute('aria-busy', String(sponsorLoading));
  $('sponsor-count').textContent = sponsorLoading ? '正在加载…' : records.length + ' 条';
  $('sponsor-load-error').hidden = !message;
  $('sponsor-load-error').textContent = message || '';
  $('sponsor-empty').hidden = sponsorLoading || records.length > 0 || Boolean(sponsorLoadError);
  $('sponsor-empty-label').textContent = searching ? '没有匹配的记录' : '暂无赞助记录';
  $('sponsor-empty-hint').hidden = !searching;
  sponsorList.innerHTML = records.map((record) => {
    const key = record.uuid || record.accounts[0].afdianUserId;
    const type = record.uuid ? 'player' : 'account';
    const source = [record.accounts.length ? '爱发电' : '', record.manual ? '手动赞助' : ''].filter(Boolean).join(' · ');
    const amount = record.totalAmount === undefined ? '累计金额未确认' : '<span>累计</span> ' + esc(record.totalAmount);
    return '<li class="sponsor-row"><div class="sponsor-identity"><strong>' + esc(record.name) + '</strong>' +
      '<div class="meta">' + source + '</div></div>' +
      '<div><span class="sponsor-state' + (record.uuid ? ' linked' : '') + '">' + (record.uuid ? '已归到玩家' : '待绑定') + '</span>' +
      (record.name === key ? '' : '<div class="mono sponsor-identity">' + esc(key) + '</div>') + '</div>' +
      '<div class="sponsor-amount">' + amount + '</div>' +
      '<div class="sponsor-row-action"><button class="btn ghost" type="button" data-sponsor-record="' +
      esc(key) + '" data-sponsor-type="' + type + '" aria-label="查看 ' + esc(record.name) +
      ' 的赞助明细"' + (sponsorLoading ? ' disabled' : '') + '>查看</button></div></li>';
  }).join('');
}

async function loadSponsors() {
  if (sponsorLoading) return;
  sponsorLoading = true;
  renderSponsors();
  try {
    sponsorData = await sponsorRequest('/sponsor-catalog');
    sponsorLoadError = '';
  } catch (error) {
    sponsorLoadError = error.message;
  } finally {
    sponsorLoading = false;
    renderSponsors();
  }
}

function openSponsorDetails(trigger) {
  sponsorDetailTrigger = trigger;
  const { sponsorRecord: id, sponsorType: type } = trigger.dataset;
  sponsorDetail = { id, type };
  $('sponsor-detail-title').textContent = '赞助明细';
  $('sponsor-detail-source').textContent = id;
  $('sponsor-detail-source').hidden = false;
  sponsorDetails.showModal();
  loadSponsorDetails();
}

function showSponsorDetailStatus(message, error = false) {
  const status = $('sponsor-detail-status');
  status.classList.toggle('sponsor-error', error);
  status.textContent = message;
  status.hidden = !message;
}

async function loadSponsorDetails() {
  sponsorDetailLoad?.abort();
  const controller = new AbortController();
  sponsorDetailLoad = controller;
  const { id, type } = sponsorDetail;
  $('sponsor-summary').replaceChildren();
  $('sponsor-account-section').hidden = true;
  $('sponsor-accounts').replaceChildren();
  $('sponsor-payments').replaceChildren();
  $('sponsor-detail-add').hidden = true;
  $('sponsor-detail-name').hidden = true;
  $('sponsor-detail-retry').hidden = true;
  showSponsorDetailStatus('正在加载明细…');
  try {
    const path = type === 'player' ? '/sponsor-catalog/' : '/sponsor-accounts/';
    const group = await sponsorRequest(path + encodeURIComponent(id), { signal: controller.signal });
    if (controller.signal.aborted) return;
    sponsorDetail.group = group;
    renderSponsorDetails(group);
  } catch (error) {
    if (controller.signal.aborted) return;
    showSponsorDetailStatus(error.message, true);
    $('sponsor-detail-retry').hidden = false;
  }
}

function renderSponsorDetails(group) {
  $('sponsor-detail-title').textContent = group.name;
  $('sponsor-detail-source').hidden = group.name === sponsorDetail.id;
  $('sponsor-summary').innerHTML =
    '<div><dt>累计金额</dt><dd>' + esc(group.totalAmount ?? '未确认') + '</dd></div>' +
    '<div><dt>已读取订单</dt><dd>' + group.orders.length + '</dd></div>';
  $('sponsor-account-section').hidden = !group.accounts.length;
  $('sponsor-accounts').innerHTML = group.accounts.map((account, index) =>
    '<li><div><strong>' + esc(account.name || account.afdianUserId) + '</strong>' +
    '<div class="mono sponsor-identity">' + esc(account.afdianUserId) + '</div></div>' +
    '<button type="button" class="btn ghost" data-account-index="' + index + '">' +
    (group.uuid ? '编辑绑定' : '绑定 UUID') + '</button></li>',
  ).join('');
  $('sponsor-detail-add').hidden = !group.uuid;
  $('sponsor-detail-name').hidden = !group.uuid;
  showSponsorDetailStatus(group.totalAmount === undefined ? '爱发电订单历史不完整。' : group.orders.length ? '' : '暂无订单');
  $('sponsor-payments').innerHTML = group.orders.map((order, index) => {
    const date = new Date(order.at * 1000);
    const time = order.at && Number.isFinite(date.getTime())
      ? '<time datetime="' + date.toISOString() + '">' + esc(sponsorDate.format(date)) + '</time>'
      : '<span>时间未记录</span>';
    const manual = order.source === 'manual';
    return '<li><div class="sponsor-payment-info"><strong>' + esc(order.amount) + '</strong>' +
      '<span>' + (manual ? '手动赞助' : '爱发电') + '</span>' + time + '</div>' +
      (manual ? '<div class="sponsor-payment-actions"><button type="button" class="btn ghost" data-order-index="' +
        index + '">编辑订单</button></div>' : '') + '</li>';
  }).join('');
}

${SPONSOR_EDITOR_SCRIPT}

for (const button of sponsorViews) button.addEventListener('click', () => {
  sponsorView = button.dataset.sponsorView;
  for (const view of sponsorViews) view.setAttribute('aria-pressed', String(view === button));
  renderSponsors();
});
sponsorSearch.addEventListener('input', renderSponsors);
sponsorList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-sponsor-record]');
  if (button) openSponsorDetails(button);
});
$('refresh-btn').addEventListener('click', loadSponsors);
$('sponsor-detail-close').addEventListener('click', () => sponsorDetails.close());
$('sponsor-detail-retry').addEventListener('click', loadSponsorDetails);
$('sponsor-detail-add').addEventListener('click', () => {
  openSponsorEditor({ kind: 'order', uuid: sponsorDetail.group.uuid });
});
$('sponsor-detail-name').addEventListener('click', () => {
  const { uuid, customName } = sponsorDetail.group;
  openSponsorEditor({ kind: 'name', uuid, name: customName });
});
$('sponsor-accounts').addEventListener('click', (event) => {
  const button = event.target.closest('[data-account-index]');
  if (!button) return;
  const { uuid, accounts } = sponsorDetail.group;
  openSponsorEditor({ kind: 'account', uuid, account: accounts[Number(button.dataset.accountIndex)] });
});
$('sponsor-payments').addEventListener('click', (event) => {
  const button = event.target.closest('[data-order-index]');
  if (!button) return;
  const { uuid, orders } = sponsorDetail.group;
  openSponsorEditor({ kind: 'order', uuid, order: orders[Number(button.dataset.orderIndex)] });
});
sponsorDetails.addEventListener('close', () => {
  if (!sponsorDetails.open) sponsorDetailLoad?.abort();
  if (!sponsorDialog.open && document.activeElement === document.body) {
    (sponsorDetailTrigger?.isConnected ? sponsorDetailTrigger : sponsorSearch).focus();
  }
});
loadSponsors();
`;
