import { icon } from '../icons';

export const SPONSORS_HTML = /* html */ `
<main id="main" tabindex="-1" class="sponsors-workspace">
  <div class="module-head">
    <h1>赞助管理</h1>
    <div class="page-actions">
      <button class="btn primary" id="sponsor-add" type="button">${icon('plus')}<span>新增手动订单</span></button>
    </div>
  </div>
  <div class="workspace-bar">
    <div class="sponsor-views" role="group" aria-label="赞助归属">
      <button class="view-tab" type="button" data-sponsor-view="all" aria-pressed="true" aria-controls="sponsor-results">全部赞助</button>
      <button class="view-tab" type="button" data-sponsor-view="players" aria-pressed="false" aria-controls="sponsor-results">已归集</button>
      <button class="view-tab" type="button" data-sponsor-view="pending" aria-pressed="false" aria-controls="sponsor-results">待绑定</button>
    </div>
    <label class="search-field">
      ${icon('search')}
      <span class="sr-only">搜索赞助者</span>
      <input type="search" id="sponsor-search" placeholder="搜索名称、账号或 UUID" autocomplete="off">
    </label>
  </div>
  <div id="sponsor-results" aria-label="赞助者列表">
    <div class="tools sponsor-tools">
      <p class="result-count" id="sponsor-count" role="status"></p>
    </div>
    <div id="sponsor-load-error" class="sponsor-error" role="status" hidden></div>
    <div id="sponsor-empty" class="empty" hidden>
      <strong id="sponsor-empty-label"></strong>
      <p id="sponsor-empty-hint" hidden>试试名称、爱发电账号或 Minecraft UUID。</p>
    </div>
    <ul class="sponsor-list" id="sponsor-list"></ul>
  </div>
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
<dialog id="sponsor-details" class="overlay" aria-labelledby="sponsor-detail-title">
  <div class="modal modal--sponsor">
    <div class="modal-head">
      <div>
        <h2 id="sponsor-detail-title" class="modal-title"></h2>
        <p id="sponsor-detail-source" class="modal-subtitle"></p>
      </div>
      <div class="grow"></div>
      <button type="button" class="btn ghost icon-btn" aria-label="关闭赞助明细" id="sponsor-detail-close">${icon('close')}</button>
    </div>
    <div class="modal-body">
      <dl class="sponsor-summary" id="sponsor-summary"></dl>
      <section id="sponsor-account-section" aria-labelledby="sponsor-account-heading" hidden>
        <h3 class="sponsor-payment-heading" id="sponsor-account-heading">爱发电账号</h3>
        <ul id="sponsor-accounts" class="sponsor-accounts"></ul>
      </section>
      <h3 class="sponsor-payment-heading">赞助订单</h3>
      <p id="sponsor-detail-status" role="status"></p>
      <ol id="sponsor-payments" class="sponsor-payments"></ol>
    </div>
    <div class="modal-foot">
      <button type="button" class="btn ghost" id="sponsor-detail-retry" hidden>重试</button>
      <button type="button" class="btn ghost" id="sponsor-detail-name" hidden>设置显示名称</button>
      <button type="button" class="btn primary" id="sponsor-detail-add" hidden>${icon('plus')}新增手动订单</button>
    </div>
  </div>
</dialog>
`;
