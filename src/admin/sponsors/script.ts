import { SPONSOR_EDITOR_SCRIPT } from './editor';

export const SPONSORS_SCRIPT = /* js */ String.raw`
const sponsorBase = '/admin/sponsors';
const sponsorSearch = $('sponsor-search');
const sponsorList = $('sponsor-list');
const sponsorSearches = { players: '', pending: '' };
const sponsorDate = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset',
});
const sponsorStatusMessages = {
  unavailable: '爱发电暂不可用。手动订单仍可查看和编辑。',
  stale: '正在显示上一次同步的爱发电数据。',
  partial: '爱发电订单历史不完整，受影响的玩家暂不显示累计金额。',
};
let sponsorRoute = readSponsorRoute();
let sponsorData = { players: [], pending: [] };
let sponsorCatalogLoad;
let sponsorLoadError = '';
let sponsorDetail;
let sponsorDetailLoad;
let sponsorOrderToShow;
let sponsorBindingNotice;

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
      404: '记录已不存在。',
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

function readSponsorRoute() {
  const params = new URLSearchParams(location.search);
  const player = params.get('player');
  if (player) return { view: 'players', id: player };
  const account = params.get('account');
  return { view: account || params.get('view') === 'pending' ? 'pending' : 'players', id: account };
}

function sponsorUrl(view, id) {
  if (id) return sponsorBase + (view === 'players' ? '?player=' : '?account=') + encodeURIComponent(id);
  return sponsorBase + (view === 'pending' ? '?view=pending' : '');
}

function sponsorRecordId(record) {
  return record.uuid || record.accounts[0].afdianUserId;
}

function findSponsors(records, value) {
  const query = value.trim().toLowerCase();
  const uuidQuery = /^[a-f0-9-]+$/.test(query) ? query.replaceAll('-', '') : '';
  return records.filter((record) => !query || [record.name, record.uuid, ...record.accounts.flatMap(
    (account) => [account.name, account.afdianUserId],
  )].some((field) => field?.toLowerCase().includes(query)) ||
    (uuidQuery && record.uuid?.replaceAll('-', '').includes(uuidQuery)))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function renderSponsors() {
  const { view } = sponsorRoute;
  const pending = view === 'pending';
  const loading = Boolean(sponsorCatalogLoad);
  const records = findSponsors(sponsorData[view], sponsorSearch.value);
  const message = sponsorLoadError || sponsorStatusMessages[sponsorData.afdianStatus];
  const count = $('sponsor-pending-count');
  count.textContent = '(' + sponsorData.pending.length + ')';
  count.hidden = sponsorData.afdianStatus === undefined;
  $('refresh-btn').disabled = loading;
  $('refresh-btn').classList.toggle('is-loading', loading);
  sponsorList.setAttribute('aria-busy', String(loading));
  $('sponsor-count').textContent = loading ? '正在加载…' : records.length + (pending ? ' 个账号' : ' 位玩家');
  $('sponsor-load-error').hidden = !message;
  $('sponsor-load-error').textContent = message || '';
  $('sponsor-empty').hidden = loading || records.length > 0 || Boolean(sponsorLoadError);
  $('sponsor-empty-label').textContent = sponsorSearch.value.trim() ? '没有匹配的记录'
    : pending ? '暂无待绑定的爱发电账号' : '暂无赞助玩家';

  const notice = pending && sponsorBindingNotice;
  $('sponsor-binding-notice').hidden = !notice;
  if (notice) {
    $('sponsor-binding-message').textContent = '已绑定「' + notice.name + '」';
    $('sponsor-bound-player').href = sponsorUrl('players', notice.uuid);
  }

  sponsorList.innerHTML = records.map((record) => {
    const id = sponsorRecordId(record);
    const source = [record.accounts.length ? '爱发电' : '', record.manual ? '手动赞助' : ''].filter(Boolean).join('、');
    const amount = record.totalAmount === undefined ? '累计金额未确认' : '<span>累计</span> ¥' + esc(record.totalAmount);
    return '<li class="sponsor-row' + (pending ? ' sponsor-row-pending' : '') + '">' +
      '<a class="sponsor-record-link" data-sponsor-link href="' + esc(sponsorUrl(view, id)) + '">' +
      '<strong>' + esc(record.name) + '</strong>' +
      (record.name === id ? '' : '<span class="mono">' + esc(id) + '</span>') + '</a>' +
      (pending ? '' : '<span class="sponsor-source">' + source + '</span>') +
      '<div class="sponsor-amount">' + amount + '</div>' +
      (pending ? '<button class="btn ghost sponsor-bind" type="button" data-sponsor-bind="' + esc(id) +
        '" aria-label="为 ' + esc(record.name) + ' 绑定玩家">绑定玩家</button>' : '') + '</li>';
  }).join('');
}

async function loadSponsors() {
  sponsorCatalogLoad?.abort();
  const controller = new AbortController();
  sponsorCatalogLoad = controller;
  renderSponsors();
  try {
    const data = await sponsorRequest('/sponsor-catalog', { signal: controller.signal });
    if (controller.signal.aborted) return;
    sponsorData = data;
    if (sponsorBindingNotice) {
      const { uuid, accountId } = sponsorBindingNotice;
      const player = data.players.find((record) => record.uuid === uuid);
      if (!player?.accounts.some((account) => account.afdianUserId === accountId)) sponsorBindingNotice = undefined;
    }
    sponsorLoadError = '';
    return sponsorData;
  } catch (error) {
    if (!controller.signal.aborted) sponsorLoadError = error.message;
  } finally {
    if (!controller.signal.aborted) {
      sponsorCatalogLoad = undefined;
      renderSponsors();
      renderSponsorPlayerOptions();
    }
  }
}

function showSponsorPage({ focus = false, orderId } = {}) {
  sponsorRoute = readSponsorRoute();
  sponsorDetailLoad?.abort();
  sponsorDetail = undefined;
  sponsorOrderToShow = orderId;
  const { view, id } = sponsorRoute;
  const pending = view === 'pending';
  $('sponsor-overview').hidden = Boolean(id);
  $('sponsor-details').hidden = !id;
  if (id) {
    const back = $('sponsor-detail-back');
    const returnView = pending || history.state?.sponsorReturn === sponsorUrl('pending') ? 'pending' : 'players';
    back.href = sponsorUrl(returnView);
    back.textContent = returnView === 'pending' ? '返回待绑定爱发电' : '返回赞助玩家';
    $('sponsor-detail-title').textContent = sponsorData[view].find((record) => sponsorRecordId(record) === id)?.name ||
      (pending ? '爱发电账号' : '玩家赞助');
    $('sponsor-detail-source').textContent = id;
    $('sponsor-detail-source').hidden = false;
    loadSponsorDetails();
    if (focus && !orderId) $('sponsor-detail-title').focus();
    return;
  }

  for (const link of [$('sponsor-players-view'), $('sponsor-pending-view')]) {
    if (link === $(pending ? 'sponsor-pending-view' : 'sponsor-players-view')) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  sponsorSearch.value = sponsorSearches[view];
  sponsorSearch.placeholder = pending ? '搜索爱发电名称或账号' : '搜索名称、UUID 或爱发电账号';
  $('sponsor-search-label').textContent = pending ? '搜索待绑定的爱发电账号' : '搜索赞助玩家';
  sponsorList.setAttribute('aria-label', pending ? '待绑定爱发电账号' : '赞助玩家');
  renderSponsors();
  if (focus) $(pending ? 'sponsor-pending-view' : 'sponsor-players-view').focus();
}

function navigateSponsors(url, { replace = false, orderId } = {}) {
  const current = location.pathname + location.search;
  if (url === current && !orderId) return;
  if (url !== current) {
    const sponsorReturn = sponsorRoute.id ? history.state?.sponsorReturn : sponsorUrl(sponsorRoute.view);
    const state = { sponsorReturn };
    if (replace) history.replaceState(state, '', url);
    else history.pushState(state, '', url);
  }
  showSponsorPage({ focus: true, orderId });
}

function returnToSponsorList() {
  const url = $('sponsor-detail-back').getAttribute('href');
  if (history.state?.sponsorReturn === url) history.back();
  else navigateSponsors(url, { replace: true });
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
  const { id, view } = sponsorRoute;
  const article = $('sponsor-details');
  article.setAttribute('aria-busy', 'true');
  $('sponsor-detail-content').hidden = true;
  $('sponsor-detail-add').hidden = true;
  $('sponsor-detail-name').hidden = true;
  $('sponsor-detail-bind').hidden = true;
  $('sponsor-detail-retry').hidden = true;
  showSponsorDetailStatus('正在加载赞助明细…');
  try {
    const path = view === 'players' ? '/sponsor-catalog/' : '/sponsor-accounts/';
    const group = await sponsorRequest(path + encodeURIComponent(id), { signal: controller.signal });
    if (controller.signal.aborted) return;
    sponsorDetail = group;
    renderSponsorDetails(group);
    showSponsorDetailStatus('');
  } catch (error) {
    if (controller.signal.aborted) return;
    showSponsorDetailStatus(error.message, true);
    $('sponsor-detail-retry').hidden = false;
    if (sponsorOrderToShow) $('sponsor-detail-retry').focus();
  } finally {
    if (!controller.signal.aborted) article.removeAttribute('aria-busy');
  }
}

function renderSponsorDetails(group) {
  const identity = sponsorRecordId(group);
  $('sponsor-detail-title').textContent = group.name;
  $('sponsor-detail-source').textContent = identity;
  $('sponsor-detail-source').hidden = group.name === identity;
  $('sponsor-summary').innerHTML =
    '<div><dt>累计金额</dt><dd>' + (group.totalAmount === undefined ? '未确认' : '¥' + esc(group.totalAmount)) + '</dd></div>' +
    '<div><dt>已读取订单</dt><dd>' + group.orders.length + '</dd></div>';
  $('sponsor-account-section').hidden = !(group.uuid && group.accounts.length);
  $('sponsor-accounts').innerHTML = group.uuid ? group.accounts.map((account, index) =>
    '<li><div><strong>' + esc(account.name || account.afdianUserId) + '</strong>' +
    (account.name ? '<div class="mono">' + esc(account.afdianUserId) + '</div>' : '') + '</div>' +
    '<button type="button" class="btn ghost" data-account-index="' + index + '">编辑绑定</button></li>',
  ).join('') : '';
  $('sponsor-detail-add').hidden = !group.uuid;
  $('sponsor-detail-name').hidden = !group.uuid;
  $('sponsor-detail-bind').hidden = Boolean(group.uuid);
  const orderStatus = group.totalAmount === undefined ? '爱发电订单历史不完整。' : group.orders.length ? '' : '暂无订单';
  $('sponsor-orders-status').hidden = !orderStatus;
  $('sponsor-orders-status').textContent = orderStatus;
  $('sponsor-payments').innerHTML = group.orders.map((order, index) => {
    const date = new Date(order.at * 1000);
    const time = '<time datetime="' + date.toISOString() + '">' + esc(sponsorDate.format(date)) + '</time>';
    const manual = order.source === 'manual';
    const selected = order.id === sponsorOrderToShow;
    const message = order.message
      ? '<p class="sponsor-payment-message"><strong>留言</strong><span>' + esc(order.message) + '</span></p>'
      : '';
    return '<li' + (selected ? ' class="sponsor-payment-selected" tabindex="-1"' : '') +
      '><div class="sponsor-payment-content"><div class="sponsor-payment-info"><strong>¥' + esc(order.amount) + '</strong>' +
      '<span>' + (manual ? '手动赞助' : '爱发电') + '</span>' + time + '</div>' +
      message + '</div>' +
      (manual ? '<button type="button" class="btn ghost" data-order-index="' +
        index + '">编辑订单</button>' : '') + '</li>';
  }).join('');
  $('sponsor-detail-content').hidden = false;
  const selected = $('sponsor-payments').querySelector('.sponsor-payment-selected');
  if (selected) {
    sponsorOrderToShow = undefined;
    selected.focus();
  }
}

async function refreshAfterSponsorRemoval(route) {
  const refreshed = await loadSponsors();
  if (sponsorRoute !== route || !route.id) return;
  const id = route.view === 'players' ? canonicalSponsorUuid(route.id) : route.id;
  if (refreshed && !refreshed[route.view].some((record) => sponsorRecordId(record) === id)) {
    returnToSponsorList();
  } else {
    $('sponsor-detail-title').focus();
    loadSponsorDetails();
  }
}

${SPONSOR_EDITOR_SCRIPT}

$('main').addEventListener('click', (event) => {
  if (event instanceof MouseEvent && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
    const link = event.target.closest('a[data-sponsor-link]');
    if (link) {
      event.preventDefault();
      if (link.id === 'sponsor-detail-back') returnToSponsorList();
      else navigateSponsors(link.getAttribute('href'));
    }
  }
});
window.addEventListener('popstate', () => {
  const route = readSponsorRoute();
  if (route.id === sponsorRoute.id && route.view === sponsorRoute.view) return;
  if (sponsorDialog.open && !sponsorSaving) sponsorDialog.close();
  showSponsorPage({ focus: true });
});
sponsorSearch.addEventListener('input', () => {
  sponsorSearches[sponsorRoute.view] = sponsorSearch.value;
  renderSponsors();
});
sponsorList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-sponsor-bind]');
  if (!button) return;
  const record = sponsorData.pending.find((item) => sponsorRecordId(item) === button.dataset.sponsorBind);
  if (record) openSponsorEditor({ kind: 'account', account: record.accounts[0] });
});
$('refresh-btn').addEventListener('click', () => {
  loadSponsors();
  if (sponsorRoute.id) loadSponsorDetails();
});
$('sponsor-detail-retry').addEventListener('click', loadSponsorDetails);
$('sponsor-detail-add').addEventListener('click', () => {
  openSponsorEditor({ kind: 'order', uuid: sponsorDetail.uuid, name: sponsorDetail.name });
});
$('sponsor-detail-name').addEventListener('click', () => {
  const { uuid, customName } = sponsorDetail;
  openSponsorEditor({ kind: 'name', uuid, name: customName });
});
$('sponsor-detail-bind').addEventListener('click', () => {
  openSponsorEditor({ kind: 'account', account: sponsorDetail.accounts[0] });
});
$('sponsor-accounts').addEventListener('click', (event) => {
  const button = event.target.closest('[data-account-index]');
  if (!button) return;
  const { uuid, accounts } = sponsorDetail;
  openSponsorEditor({ kind: 'account', uuid, account: accounts[Number(button.dataset.accountIndex)] });
});
$('sponsor-payments').addEventListener('click', (event) => {
  const button = event.target.closest('[data-order-index]');
  if (!button) return;
  const { uuid, orders } = sponsorDetail;
  openSponsorEditor({ kind: 'order', uuid, order: orders[Number(button.dataset.orderIndex)] });
});
loadSponsors();
showSponsorPage();
`;
