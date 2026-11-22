import { icon } from '../icons';

export const SPONSORS_HTML = /* html */ `
<main id="main" tabindex="-1" class="sponsors-workspace">
  <div id="sponsor-overview">
    <div class="module-head">
      <h1 id="sponsor-overview-title" tabindex="-1">赞助管理</h1>
      <button class="btn primary" id="sponsor-add" type="button">${icon('plus')}<span>新增手动订单</span></button>
    </div>
    <div class="workspace-bar">
      <nav class="sponsor-views" aria-label="赞助管理视图">
        <a class="view-tab" id="sponsor-players-view" data-sponsor-link href="/admin/sponsors" aria-current="page">赞助玩家</a>
        <a class="view-tab" id="sponsor-pending-view" data-sponsor-link href="/admin/sponsors?view=pending">待绑定爱发电<span id="sponsor-pending-count" hidden></span></a>
      </nav>
      <label class="search-field">
        ${icon('search')}
        <span class="sr-only" id="sponsor-search-label">搜索赞助玩家</span>
        <input type="search" id="sponsor-search" placeholder="搜索名称、UUID 或爱发电账号" autocomplete="off">
      </label>
    </div>
    <div class="tools">
      <p class="result-count" id="sponsor-count" role="status"></p>
    </div>
    <div class="sponsor-notice" id="sponsor-binding-notice" hidden>
      <span id="sponsor-binding-message"></span>
      <a class="btn ghost" id="sponsor-bound-player" data-sponsor-link href="/admin/sponsors">查看玩家</a>
    </div>
    <div id="sponsor-load-error" class="sponsor-error" role="status" hidden></div>
    <div id="sponsor-empty" class="empty" hidden>
      <strong id="sponsor-empty-label"></strong>
    </div>
    <ul class="sponsor-list" id="sponsor-list" aria-label="赞助玩家"></ul>
  </div>
  <article class="sponsor-detail" id="sponsor-details" aria-labelledby="sponsor-detail-title" hidden>
    <a class="sponsor-back" id="sponsor-detail-back" data-sponsor-link href="/admin/sponsors">返回赞助玩家</a>
    <header class="sponsor-detail-header">
      <div>
        <h1 id="sponsor-detail-title" tabindex="-1"></h1>
        <p id="sponsor-detail-source" class="mono"></p>
      </div>
      <div class="sponsor-detail-actions">
        <button type="button" class="btn primary" id="sponsor-detail-add" hidden>${icon('plus')}新增手动订单</button>
        <button type="button" class="btn ghost" id="sponsor-detail-name" hidden>设置显示名称</button>
        <button type="button" class="btn primary" id="sponsor-detail-bind" hidden>绑定玩家</button>
      </div>
    </header>
    <p id="sponsor-detail-status" class="sponsor-detail-status" role="status" hidden></p>
    <button type="button" class="btn ghost" id="sponsor-detail-retry" hidden>重试</button>
    <div id="sponsor-detail-content" hidden>
      <dl class="sponsor-summary" id="sponsor-summary"></dl>
      <section class="sponsor-detail-section" aria-labelledby="sponsor-orders-heading">
        <h2 class="sponsor-payment-heading" id="sponsor-orders-heading">赞助订单</h2>
        <p class="hint" id="sponsor-orders-status" hidden></p>
        <ol id="sponsor-payments" class="sponsor-payments"></ol>
      </section>
      <section class="sponsor-detail-section" id="sponsor-account-section" aria-labelledby="sponsor-account-heading" hidden>
        <h2 class="sponsor-payment-heading" id="sponsor-account-heading">已绑定的爱发电账号</h2>
        <ul id="sponsor-accounts" class="sponsor-accounts"></ul>
      </section>
    </div>
  </article>
</main>
<dialog id="sponsor-dialog" class="overlay" aria-labelledby="sponsor-editor-title">
  <form id="sponsor-form" class="modal modal--sponsor">
    <div class="modal-head">
      <h2 id="sponsor-editor-title" class="modal-title"></h2>
      <div class="grow"></div>
      <button type="button" class="btn ghost icon-btn" aria-label="关闭" id="sponsor-close">${icon('close')}</button>
    </div>
    <div class="modal-body">
      <p id="sponsor-form-error" class="sponsor-error" role="alert" tabindex="-1" hidden></p>
      <div class="grid" id="sponsor-fields"></div>
    </div>
    <div class="modal-foot">
      <div id="sponsor-confirm" class="sponsor-confirm" hidden>
        <p id="sponsor-confirm-text"></p>
        <button class="btn ghost" type="button" id="sponsor-keep">返回</button>
        <button class="btn danger" type="button" id="sponsor-delete">确认删除</button>
      </div>
      <div id="sponsor-form-actions" class="sponsor-form-actions">
        <button class="btn danger" type="button" id="sponsor-remove" hidden></button>
        <div class="grow"></div>
        <button class="btn ghost" type="button" id="sponsor-cancel">取消</button>
        <button class="btn primary" type="submit" id="sponsor-save">保存</button>
      </div>
    </div>
  </form>
</dialog>
`;
