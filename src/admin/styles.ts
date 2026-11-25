export const ADMIN_STYLES = /* css */ `
  *, *::before, *::after { box-sizing: border-box; }
  :root {
    color-scheme: light dark;
    --bg: light-dark(#fbfcfa, #171a17);
    --surface: light-dark(#fff, #1e221e);
    --sidebar: light-dark(#f2f5f0, #131713);
    --surface-muted: light-dark(#eff2ee, #282d27);
    --line: light-dark(#d2dacf, #343d32);
    --line-soft: light-dark(#dce3d9, #2a3328);
    --text: light-dark(#293328, #e6ece3);
    --heading: light-dark(#191f18, #f7fcf6);
    --muted: light-dark(#596654, #a5b09f);
    --accent: light-dark(#46833c, #79b86f);
    --accent-hover: light-dark(#3a7730, #85c57b);
    --on-accent: light-dark(#ffffff, #111710);
    --accent-strong: light-dark(#255e1c, #99cf90);
    --red: light-dark(#a74444, #f89696);
    --scrim: light-dark(rgba(32, 49, 38, .24), rgba(4, 12, 9, .56));
    --shadow: light-dark(rgba(22, 40, 29, .12), rgba(0, 0, 0, .32));
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", sans-serif;
    font-synthesis: none;
  }
  :root[data-theme="light"] { color-scheme: light; }
  :root[data-theme="dark"] { color-scheme: dark; }
  html { background: var(--bg); scrollbar-gutter: stable; }
  body { margin: 0; color: var(--text); font-size: 14px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
  [hidden] { display: none !important; }
  button, input, select, textarea { font: inherit; letter-spacing: normal; }
  button { cursor: pointer; touch-action: manipulation; }
  button:disabled { cursor: not-allowed; opacity: .5; }
  button, a, input, select, textarea, summary { -webkit-tap-highlight-color: transparent; }
  :focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 4px; }
  input, select, textarea {
    width: 100%;
    min-width: 0;
    min-height: 38px;
    padding: 7px 10px;
    border: 1px solid var(--line);
    border-radius: 5px;
    background: var(--surface);
    color: var(--text);
    transition: border-color 160ms ease, background 160ms ease;
  }
  input:focus, select:focus, textarea:focus { border-color: var(--accent-strong); background: var(--surface); }
  input::placeholder, textarea::placeholder { color: var(--muted); opacity: 1; }
  textarea { min-height: 80px; resize: vertical; line-height: 1.6; }
  input[type="file"] { padding: 8px; }
  input::file-selector-button { border: 0; border-radius: 8px; padding: 6px 12px; margin-right: 10px; background: var(--surface-muted); color: var(--text); cursor: pointer; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
  .skip-link { position: fixed; top: 12px; left: 16px; z-index: 100; transform: translateY(-160%); border-radius: 12px; padding: 10px 16px; background: var(--surface); color: var(--heading); }
  .skip-link:focus { transform: none; }
  .icon { width: 18px; height: 18px; flex: 0 0 auto; }
  .is-loading .icon { animation: admin-spin 1s linear infinite; }
  @keyframes admin-spin { to { transform: rotate(360deg); } }
  .app { display: grid; grid-template-columns: 168px minmax(0, 1fr); grid-template-rows: auto 1fr; min-height: 100dvh; }
  .topbar { position: sticky; top: 0; z-index: 20; grid-column: 1 / -1; background: var(--surface); border-bottom: 1px solid var(--line); }
  .topbar-inner { min-height: 51px; display: flex; align-items: center; gap: 16px; padding: 4px 20px; }
  .module-nav { position: sticky; top: 52px; align-self: start; height: calc(100dvh - 52px); padding: 16px 12px; background: var(--sidebar); }
  .module-link { display: flex; align-items: center; gap: 9px; border-inline-start: 2px solid transparent; padding: 8px 10px; color: var(--muted); text-decoration: none; font-size: 14px; font-weight: 600; }
  .module-link:hover { color: var(--heading); }
  .module-link[aria-current="page"] { border-color: var(--accent-strong); color: var(--accent-strong); }
  .brand { display: inline-flex; align-items: center; gap: 10px; white-space: nowrap; color: var(--heading); }
  .brand strong { font-size: 20px; font-weight: 800; letter-spacing: .06em; }
  .brand span { font-size: 14px; color: var(--muted); }
  .grow { flex: 1; }
  .header-actions, .page-actions { display: flex; align-items: center; gap: 8px; }
  .btn { min-height: 38px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 7px 12px; border: 0; border-radius: 5px; font-size: 14px; font-weight: 550; line-height: 1.4; white-space: nowrap; text-decoration: none; transition: background 160ms ease, color 160ms ease; }
  .primary { background: var(--accent); color: var(--on-accent); }
  .primary:hover:not(:disabled) { background: var(--accent-hover); }

  .ghost:hover:not(:disabled) { background: var(--surface-muted); color: var(--heading); }
  .ghost { background: transparent; color: var(--muted); }
  .danger { background: transparent; color: var(--red); }
  .row-actions .danger:not(:hover, :focus-visible), .gallery-actions .danger:not(:hover, :focus-visible) { color: var(--muted); }
  .danger:hover:not(:disabled) { background: color-mix(in srgb, var(--red) 17%, transparent); }
  .icon-btn { width: 38px; padding: 0; flex: 0 0 auto; }
  .sm { min-height: 32px; padding: 5px 9px; font-size: 13px; }
  main { min-width: 0; padding: 22px clamp(20px, 2.5vw, 44px) 40px; }
  .module-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; margin-bottom: 10px; }
  h1 { margin: 0; color: var(--heading); font-size: 24px; font-weight: 650; line-height: 1.3; }
  .search-field { display: flex; align-items: center; gap: 8px; min-width: 0; width: clamp(160px, 22vw, 340px); min-height: 36px; margin-block: 4px; padding: 0 8px; border: 1px solid transparent; border-radius: 5px; background: var(--surface-muted); color: var(--muted); }
  .search-field:focus-within { border-color: var(--accent-strong); }
  .search-field input { min-height: 36px; padding: 0; border: 0; outline: none; background: transparent; font-size: 13px; }
  .search-field input:focus { background: transparent; }
  .search-field input::-webkit-search-cancel-button { display: none; }
  .search-clear { flex-shrink: 0; width: 28px; min-height: 28px; margin-right: -6px; }
  .workspace-bar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; min-height: 48px; border-bottom: 1px solid var(--line); }
  .view-tabs { display: flex; align-self: stretch; gap: 16px; }
  .view-tab { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 44px; padding: 6px 2px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--muted); font-size: 14px; font-weight: 550; }
  .view-tab:hover { color: var(--heading); }
  .view-tab[aria-selected="true"] { border-bottom-color: var(--accent-strong); color: var(--accent-strong); }
  #pending-count { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .tools { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 0; }
  .filters { display: flex; flex-wrap: wrap; gap: 6px; }
  .filter { display: inline-flex; align-items: center; gap: 7px; min-height: 34px; padding: 4px 8px; border: 0; border-radius: 5px; background: transparent; color: var(--muted); font-size: 13px; transition: background 160ms ease, color 160ms ease; }
  .filter:hover { background: var(--surface-muted); color: var(--heading); }
  .filter[aria-pressed="true"] { color: var(--accent-strong); font-weight: 650; }
  .result-count { margin: 0; color: var(--muted); font-size: 13px; white-space: nowrap; }
  table { width: 100%; table-layout: fixed; border-collapse: collapse; }
  .col-building { width: 32%; }
  .col-location { width: 18%; }
  .col-type { width: 8%; }
  .col-date { width: 110px; }
  .col-actions { width: 116px; }
  th { padding: 8px 10px; color: var(--muted); font-size: 12px; font-weight: 500; text-align: left; }
  td { padding: 7px 10px; border-top: 1px solid var(--line-soft); vertical-align: middle; font-size: 14px; overflow-wrap: anywhere; }
  th:first-child, td:first-child { padding-left: 4px; }
  tbody tr:hover { background: var(--surface-muted); }
  .title { color: var(--heading); font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
  .meta { margin-top: 4px; color: var(--muted); font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
  .building-summary { display: flex; align-items: center; gap: 10px; }
  .building-summary > div { min-width: 0; }
  .building-summary .meta { margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .record-thumb { display: block; flex: 0 0 auto; width: 72px; aspect-ratio: 16 / 10; object-fit: cover; border-radius: 5px; background: var(--surface-muted); }
  .record-thumb-empty { display: grid; place-items: center; color: var(--muted); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .date { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .row-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .empty { margin: 0; padding: 38px 12px; text-align: center; color: var(--muted); }
  .empty strong { display: block; color: var(--heading); font-size: 16px; font-weight: 550; }
  .empty p { margin: 8px auto 16px; max-width: 28rem; font-size: 14px; }
  .review-item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 12px; border-bottom: 1px solid var(--line-soft); }
  .review-item:last-child { border-bottom: 0; }
  .overlay { position: fixed; inset: 0; width: 100%; max-width: none; height: 100%; max-height: none; margin: 0; padding: max(24px, env(safe-area-inset-top, 0px)) max(24px, env(safe-area-inset-right, 0px)) max(24px, env(safe-area-inset-bottom, 0px)) max(24px, env(safe-area-inset-left, 0px)); border: 0; background: transparent; color: var(--text); }
  .overlay[open] { display: flex; align-items: center; justify-content: center; }
  .overlay::backdrop { background: var(--scrim); }
  html:has(.overlay[open]) { overflow: hidden; }
  .modal { width: min(1340px, 100%); max-height: 100%; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; overflow: hidden; border-radius: 8px; background: var(--surface); box-shadow: 0 10px 36px var(--shadow); }
  .modal--import { width: min(640px, 100%); }
  .modal-head, .modal-foot { display: flex; align-items: center; gap: 12px; padding: 12px 20px; }
  .modal-title { margin: 0; color: var(--heading); font-size: 20px; font-weight: 550; line-height: 1.4; overflow-wrap: anywhere; }
  .modal-subtitle { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
  .modal-foot { flex-wrap: wrap; justify-content: flex-end; border-top: 1px solid var(--line-soft); }
  .modal-body { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 16px 20px 22px; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
  .editor-body { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); align-items: start; gap: 24px; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 14px; }
  .field { display: grid; align-content: start; gap: 4px; min-width: 0; }
  .full { grid-column: 1 / -1; }
  label { color: var(--text); font-size: 13px; font-weight: 550; }
  .hint { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
  .section { grid-column: 1 / -1; margin: 5px 0 -4px; color: var(--heading); font-size: 15px; font-weight: 600; }
  .coordinate-grid { display: grid; grid-template-columns: 1.4fr repeat(3, 1fr); gap: 12px; }
  .source-fields { margin-top: 5px; }
  .source-fields summary { min-height: 32px; color: var(--heading); font-size: 14px; font-weight: 550; cursor: pointer; }
  .source-fields[open] .grid { padding-top: 8px; }
  #import-json { min-height: 240px; }
  #toast { position: fixed; right: max(24px, env(safe-area-inset-right, 0px)); bottom: max(24px, env(safe-area-inset-bottom, 0px)); z-index: 80; width: min(400px, calc(100% - 48px)); padding: 12px 16px; border: 1px solid var(--line-soft); border-radius: 6px; background: var(--surface); color: var(--text); box-shadow: 0 12px 48px var(--shadow); font-size: 14px; }
  #toast.err { border-color: var(--red); }
  #gallery-jump { display: none; }
  .gallery { min-width: 0; }
  .gallery.file-target { outline: 2px dashed var(--accent-strong); outline-offset: 4px; }
  .gallery-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .gallery-head > div { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
  .gallery-head h2, .gallery-head h3 { margin: 0; color: var(--heading); font-size: 15px; }
  #gallery-count { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .gallery .hint { margin-top: 5px; }
  .gallery-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(132px, 100%), 1fr)); align-items: start; gap: 10px; padding: 0; margin: 12px 0 0; list-style: none; }
  .gallery-list:empty { display: none; }
  .gallery-tile { min-width: 0; }
  .gallery-tile.dragging { opacity: .45; }
  .gallery-tile.drop-target { outline: 2px solid var(--accent-strong); outline-offset: 1px; }
  .gallery-preview { position: relative; display: block; width: 100%; padding: 0; border: 0; border-radius: 4px; overflow: hidden; background: var(--surface-muted); cursor: zoom-in; }
  .gallery-preview:focus-visible { outline-offset: -3px; }
  .gallery-preview img { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; }
  .gallery-preview span { position: absolute; top: 5px; left: 5px; padding: 1px 5px; border-radius: 4px; background: #131913e6; color: #fff; font-size: 11px; }
  .gallery-actions { display: flex; align-items: center; gap: 2px; }
  .gallery-actions .btn { min-width: 30px; padding-inline: 6px; }
  .gallery-actions .btn:focus-visible { outline-offset: -2px; }
  .gallery-actions button:last-child { margin-left: auto; }
  .gallery-empty { margin-top: 12px; padding-block: 18px; color: var(--muted); font-size: 13px; }
  .gallery-status, .gallery-errors { margin: 8px 0 0; overflow-wrap: anywhere; color: var(--muted); font-size: 13px; }
  .gallery-status:empty { margin: 0; }
  .gallery-errors { padding-left: 22px; color: var(--red); }
  .image-preview-panel { display: flex; flex-direction: column; gap: 10px; max-width: 100%; max-height: 100%; padding: 12px; border-radius: 10px; background: var(--surface); }
  .image-preview-panel picture { display: flex; min-height: 0; justify-content: center; }
  .image-preview-panel img { min-height: 0; max-width: 100%; object-fit: contain; }
  .sponsors-workspace .primary, .modal--sponsor .primary { background: var(--accent-strong); }
  .sponsors-workspace .primary:hover:not(:disabled), .modal--sponsor .primary:hover:not(:disabled) { background: var(--accent-hover); }
  .sponsor-views { display: flex; flex-wrap: wrap; align-self: stretch; gap: 0 18px; }
  .sponsor-views .view-tab { text-decoration: none; }
  .sponsor-views [aria-current="page"] { color: var(--accent-strong); border-bottom-color: var(--accent-strong); }
  #sponsor-pending-count { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .sponsors-workspace .search-field { width: clamp(260px, 28vw, 360px); }
  .sponsor-list { margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--line-soft); }
  .sponsor-list:empty { display: none; }
  .sponsor-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, .45fr) minmax(0, .45fr); align-items: center; gap: 4px 20px; min-height: 64px; padding: 8px 4px; border-bottom: 1px solid var(--line-soft); }
  .sponsor-row-pending { grid-template-columns: minmax(0, 1fr) minmax(0, .35fr) auto; }
  .sponsor-record-link { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; justify-self: start; min-width: 0; max-width: 100%; min-height: 44px; color: var(--heading); text-decoration: none; overflow-wrap: anywhere; }
  .sponsor-record-link strong { font-size: 15px; font-weight: 650; }
  .sponsor-record-link:hover strong { color: var(--accent-strong); text-decoration: underline; text-underline-offset: 3px; }
  .sponsor-source { color: var(--muted); font-size: 13px; }
  .sponsor-amount { color: var(--heading); text-align: right; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .sponsor-amount span { color: var(--muted); font-size: 12px; }
  .sponsor-bind { min-height: 44px; color: var(--accent-strong); }
  .sponsor-notice { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: 2px 12px; margin: 0 0 8px; padding: 4px 8px 4px 12px; border-inline-start: 2px solid var(--accent-strong); background: var(--surface-muted); overflow-wrap: anywhere; }
  .sponsor-notice .btn { color: var(--accent-strong); }
  .sponsor-error { margin: 8px 0 12px; padding: 8px 12px; border-inline-start: 2px solid var(--red); color: var(--red); background: var(--surface); overflow-wrap: anywhere; }
  .modal--sponsor { width: min(660px, 100%); }
  #sponsor-uuid { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .sponsor-player-target { display: grid; gap: 8px; }
  .sponsor-player-options { display: grid; max-height: 182px; overflow: auto; border: 1px solid var(--line); border-radius: 5px; }
  .sponsor-player-options p { padding: 8px 10px; }
  .sponsor-player-option { display: grid; gap: 2px; min-height: 44px; padding: 6px 10px; border: 0; background: var(--surface); color: var(--heading); text-align: left; overflow-wrap: anywhere; }
  .sponsor-player-option + .sponsor-player-option { border-top: 1px solid var(--line-soft); }
  .sponsor-player-option:hover { background: var(--surface-muted); }
  .sponsor-player-option:focus-visible { outline-offset: -3px; }
  #sponsor-player-match { color: var(--accent-strong); overflow-wrap: anywhere; }
  .sponsor-confirm, .sponsor-form-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .sponsor-editor-account { margin: 0; overflow-wrap: anywhere; }
  .sponsor-order-payment { display: grid; grid-template-columns: minmax(120px, .68fr) minmax(0, 2fr); align-items: start; gap: 12px; }
  .sponsor-payment-time { display: grid; min-inline-size: 0; gap: 8px; margin: 0; padding: 6px 12px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-muted); }
  .sponsor-payment-time legend { padding-inline: 4px; color: var(--heading); font-size: 13px; font-weight: 600; }
  .sponsor-time-inputs, .sponsor-time-tools { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .sponsor-time-tools { grid-template-columns: minmax(0, 1fr) auto; align-items: end; }
  .sponsor-time-tools .btn { min-height: 38px; color: var(--accent-strong); }
  .sponsor-time-actions { align-items: center; }
  .sponsor-zone-keep { display: flex; align-items: center; gap: 8px; min-height: 32px; font-size: 12px; cursor: pointer; }
  .sponsor-zone-keep input { flex: 0 0 auto; width: 16px; min-height: 0; height: 16px; margin: 0; accent-color: var(--accent-strong); }
  .sponsor-zone-results { max-height: 137px; margin: 0; padding: 0; overflow: auto; border: 1px solid var(--line); border-radius: 5px; list-style: none; }
  .sponsor-zone-results li + li { border-top: 1px solid var(--line-soft); }
  .sponsor-zone-results button { width: 100%; overflow-wrap: anywhere; }
  .sponsor-time-feedback { overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .sponsor-time-feedback:empty { margin-block-start: -8px; }
  .sponsor-time-error { color: var(--red); }
  .sponsor-confirm, .sponsor-form-actions { width: 100%; }
  .sponsor-confirm { justify-content: flex-end; }
  .sponsor-confirm p { margin: 0 auto 0 0; color: var(--text); }
  .sponsor-detail { max-width: 920px; }
  .sponsor-back { display: inline-flex; align-items: center; min-height: 44px; color: var(--accent-strong); font-size: 13px; text-underline-offset: 3px; }
  .sponsor-detail-header { display: flex; align-items: flex-end; flex-wrap: wrap; justify-content: space-between; gap: 12px 18px; margin: 4px 0 14px; }
  .sponsor-detail-header > div { min-width: 0; }
  #sponsor-detail-title { overflow-wrap: anywhere; }
  #sponsor-detail-source { margin: 4px 0 0; overflow-wrap: anywhere; }
  .sponsor-detail-actions { display: flex; flex-wrap: wrap; gap: 4px 8px; }
  .sponsor-detail-actions .btn { min-height: 44px; }
  .sponsor-detail-status:not(.sponsor-error) { color: var(--muted); font-size: 13px; }
  .sponsor-detail-section { margin-top: 22px; }
  .sponsor-summary { display: flex; flex-wrap: wrap; gap: 10px 32px; margin: 0; padding: 12px 0; border-block: 1px solid var(--line); }
  .sponsor-summary dt { color: var(--muted); font-size: 13px; }
  .sponsor-summary dd { margin: 1px 0 0; color: var(--heading); font-size: 19px; font-weight: 650; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .sponsor-payment-heading { margin: 0; color: var(--heading); font-size: 15px; }
  #sponsor-orders-status { margin-top: 5px; }
  .sponsor-accounts, .sponsor-payments { margin: 6px 0 0; padding: 0; list-style: none; border-top: 1px solid var(--line-soft); }
  .sponsor-accounts li, .sponsor-payments li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 12px; min-height: 52px; padding: 4px 8px; border-bottom: 1px solid var(--line-soft); overflow-wrap: anywhere; }
  .sponsor-accounts .btn, .sponsor-payments .btn { min-height: 44px; }
  .sponsor-payments .btn { margin-inline-start: auto; }
  .sponsor-payment-content { flex: 1 1 0; min-width: 0; }
  .sponsor-payment-info { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; }
  .sponsor-payment-info strong { color: var(--heading); font-variant-numeric: tabular-nums; }
  .sponsor-payment-info :is(time, span) { color: var(--muted); font-size: 12px; }
  .sponsor-payment-message { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: baseline; gap: 8px; margin: 4px 0; }
  .sponsor-payment-message strong { color: var(--muted); font-size: 12px; }
  .sponsor-payment-message span { white-space: pre-wrap; }
  .sponsor-payment-selected { background: var(--surface-muted); box-shadow: inset 2px 0 var(--accent-strong); scroll-margin-block-start: 64px; }
  @media (max-width: 1020px) {
    .editor-body { gap: 14px; }
    .col-location { width: 20%; }
    .record-thumb { width: 56px; }
  }
  @media (max-width: 820px) {
    .app { display: block; }
    .module-nav { position: static; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; height: auto; padding: 5px 16px; }
    .module-link { padding-block: 6px; }
    main { padding: 16px 16px 32px; }
    .editor-body { grid-template-columns: minmax(0, 1fr); }
    #gallery-jump { display: inline-flex; }
    .gallery { margin-top: 12px; }
  }
  @media (max-width: 620px) {
    .topbar-inner { gap: 8px; padding-inline: 16px; }
    .brand { gap: 8px; }
    .header-actions { gap: 0; }
    #theme-btn, .icon-btn { width: 44px; padding: 0; }
    #theme-label { display: none; }
    .btn { min-height: 44px; }
    .module-head { margin-bottom: 8px; }
    .search-field { flex: 1 1 148px; min-height: 44px; }
    .search-field input { min-height: 42px; font-size: 16px; }
    .search-field input::placeholder { font-size: 13px; }
    .tools { flex-wrap: wrap; gap: 3px 12px; }
    .filters { gap: 2px; }
    .filter { min-height: 40px; }
    .result-count { font-size: 12px; }
    table, tbody { display: block; }
    colgroup, thead { display: none; }
    tr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 12px; padding-block: 10px; border-top: 1px solid var(--line-soft); }
    tr:first-child { border-top: 0; }
    td, td:first-child { display: block; border: 0; padding: 0; }
    td[data-label]::before { content: attr(data-label); display: block; color: var(--muted); font-size: 11px; }
    .building-cell, .actions-cell, .empty-cell { grid-column: 1 / -1; }
    .row-actions { justify-content: flex-end; }
    .review-item { grid-template-columns: auto minmax(0, 1fr); gap: 8px; }
    .review-item .row-actions { grid-column: 1 / -1; }
    .overlay { padding: 8px; }
    .modal-head, .modal-foot, .modal-body { padding: 10px 12px; }
    .modal-head, .modal-foot { gap: 5px; }
    .modal-title { font-size: 18px; }
    .grid { gap: 8px; }
    .coordinate-grid { gap: 6px; }
    input, textarea, select { min-height: 44px; font-size: 16px; }
    .modal-foot .btn { padding-inline: 9px; font-size: 13px; }
    .module-link { min-height: 44px; }
    .sponsor-row { grid-template-columns: minmax(0, 1fr) auto; column-gap: 12px; }
    .sponsor-record-link { grid-column: 1 / -1; }
    .sponsor-row-pending .sponsor-amount { text-align: left; }
    .sponsor-bind { justify-self: end; }
    .sponsors-workspace .search-field { margin-bottom: 8px; }
    .sponsor-views { width: 100%; gap: 14px; }
    .modal--sponsor .grid { grid-template-columns: minmax(0, 1fr); }
    .sponsor-time-tools .btn, .sponsor-zone-keep { min-height: 44px; }
    #sponsor-uuid { font-size: 16px; }
  }
  @media (max-width: 390px) {
    .grid { grid-template-columns: minmax(0, 1fr); }
    .coordinate-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .coordinate-grid .field:first-child { grid-column: 1 / -1; }
    .sponsor-time-inputs { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 540px) {
    .sponsor-order-payment { grid-template-columns: minmax(0, 1fr); }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
  }
`;
