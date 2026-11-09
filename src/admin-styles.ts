// Matches MikWeb's default green palette, translucent chrome and content-browser layout.
export const ADMIN_STYLES = /* css */ `
  *, *::before, *::after { box-sizing: border-box; }
  :root {
    color-scheme: light dark;
    --bg: light-dark(#edf2ec, #111710);
    --surface: light-dark(#f7fcf6, #1a2019);
    --surface-strong: light-dark(#f7fcf6, #181e17);
    --surface-muted: light-dark(#e5e9e4, #212720);
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
    --blue: light-dark(#38649c, #9fc4f4);
    --green: light-dark(#28653a, #9bd6a9);
    --amber: light-dark(#80500b, #ebc67d);
    --scrim: light-dark(rgba(32, 49, 38, .24), rgba(4, 12, 9, .56));
    --shadow: light-dark(rgba(22, 40, 29, .12), rgba(0, 0, 0, .32));
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", sans-serif;
    font-synthesis: none;
  }
  :root[data-theme="light"] { color-scheme: light; }
  :root[data-theme="dark"] { color-scheme: dark; }
  html { background: var(--bg); scrollbar-gutter: stable; }
  body { margin: 0; color: var(--text); font-size: 15px; line-height: 1.6; -webkit-font-smoothing: antialiased; }
  body::before {
    content: "";
    position: fixed;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    background: radial-gradient(circle at 12% 0%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 36rem);
  }
  [hidden] { display: none !important; }
  button, input, select, textarea { font: inherit; letter-spacing: normal; }
  button { cursor: pointer; touch-action: manipulation; }
  button:disabled { cursor: not-allowed; opacity: .5; }
  button, a, input, select, textarea, summary { -webkit-tap-highlight-color: transparent; }
  :focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 4px; }
  input, select, textarea {
    width: 100%;
    min-width: 0;
    min-height: 44px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: color-mix(in srgb, var(--surface-muted) 40%, transparent);
    color: var(--text);
    transition: border-color 160ms ease, background 160ms ease;
  }
  input:focus, select:focus, textarea:focus { border-color: var(--accent-strong); background: var(--surface); }
  input::placeholder, textarea::placeholder { color: var(--muted); opacity: 1; }
  textarea { min-height: 100px; resize: vertical; line-height: 1.6; }
  input[type="file"] { padding: 8px; }
  input::file-selector-button { border: 0; border-radius: 8px; padding: 6px 12px; margin-right: 10px; background: var(--surface-muted); color: var(--text); cursor: pointer; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
  .skip-link { position: fixed; top: 12px; left: 16px; z-index: 100; transform: translateY(-160%); border-radius: 12px; padding: 10px 16px; background: var(--surface-strong); color: var(--heading); }
  .skip-link:focus { transform: none; }
  .icon { width: 18px; height: 18px; flex: 0 0 auto; }
  .is-loading .icon { animation: admin-spin 1s linear infinite; }
  @keyframes admin-spin { to { transform: rotate(360deg); } }
  .app { min-height: 100vh; min-height: 100dvh; padding-bottom: calc(56px + env(safe-area-inset-bottom, 0px)); }
  .topbar {
    position: sticky;
    top: 0;
    z-index: 20;
    background: color-mix(in srgb, var(--bg) 84%, transparent);
    backdrop-filter: blur(18px) saturate(150%);
    -webkit-backdrop-filter: blur(18px) saturate(150%);
  }
  .topbar-inner { width: min(1540px, 100%); min-height: 80px; margin: auto; display: flex; align-items: center; gap: 16px; padding: calc(12px + env(safe-area-inset-top, 0px)) max(24px, env(safe-area-inset-right, 0px)) 12px max(24px, env(safe-area-inset-left, 0px)); }
  .brand { display: inline-flex; align-items: center; gap: 16px; white-space: nowrap; color: var(--heading); }
  .brand strong { font-size: 20px; font-weight: 800; letter-spacing: .06em; }
  .brand span { padding-left: 16px; border-left: 1px solid var(--line); font-size: 14px; color: var(--muted); }
  .identity { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; white-space: nowrap; }
  .identity .icon { width: 15px; height: 15px; }
  .grow { flex: 1; }
  .header-actions, .page-actions { display: flex; align-items: center; gap: 8px; }
  .btn { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 10px 18px; border: 0; border-radius: 999px; font-size: 14px; font-weight: 550; line-height: 1.4; white-space: nowrap; text-decoration: none; transition: background 160ms ease, color 160ms ease; }
  .primary { background: var(--accent); color: var(--on-accent); }
  .primary:hover:not(:disabled) { background: var(--accent-hover); }
  .quiet { background: color-mix(in srgb, var(--surface-muted) 70%, transparent); color: var(--text); }
  .quiet:hover:not(:disabled), .ghost:hover:not(:disabled) { background: var(--line); color: var(--heading); }
  .ghost { background: transparent; color: var(--muted); }
  .danger { background: color-mix(in srgb, var(--red) 9%, transparent); color: var(--red); }
  .danger:hover:not(:disabled) { background: color-mix(in srgb, var(--red) 17%, transparent); }
  .icon-btn { width: 44px; padding: 0; flex: 0 0 auto; }
  .sm { min-height: 36px; padding: 8px 12px; font-size: 13px; }
  main { width: min(1344px, 100%); margin: 0 auto; padding: 48px 32px 0; }
  .admin-hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 400px); align-items: center; gap: 24px; margin-bottom: 32px; }
  h1 { margin: 0; color: var(--heading); font-size: clamp(28px, 3vw, 36px); font-weight: 550; line-height: 1.3; letter-spacing: -.03em; }
  .admin-hero p { margin: 10px 0 0; color: var(--muted); font-size: 14px; }
  .search-field { display: flex; align-items: center; gap: 10px; min-width: 0; min-height: 48px; padding: 0 16px; border: 1px solid var(--line); border-radius: 999px; background: color-mix(in srgb, var(--surface) 48%, transparent); color: var(--muted); }
  .search-field:focus-within { border-color: var(--accent-strong); background: var(--surface); }
  .search-field input { min-height: 46px; padding: 0; border: 0; outline: none; background: transparent; font-size: 15px; }
  .search-field input:focus { background: transparent; }
  .search-clear { flex-shrink: 0; width: 32px; min-height: 32px; margin-right: -8px; }
  .workspace-bar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
  .view-tabs { display: flex; gap: 4px; padding: 4px; border-radius: 999px; background: color-mix(in srgb, var(--surface-muted) 75%, transparent); }
  .view-tab { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; padding: 8px 18px; border: 0; border-radius: 999px; background: transparent; color: var(--muted); font-size: 14px; font-weight: 550; transition: background 160ms ease, color 160ms ease; }
  .view-tab:hover { color: var(--heading); }
  .view-tab[aria-selected="true"] { background: var(--surface); color: var(--heading); box-shadow: 0 1px 4px var(--shadow); }
  .tab-count { min-width: 20px; padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent-strong); font-size: 12px; font-variant-numeric: tabular-nums; }
  .tools { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 20px 0; }
  .summary { display: flex; flex-wrap: wrap; gap: 6px; }
  .filter-chip { display: inline-flex; align-items: center; gap: 7px; min-height: 36px; padding: 6px 12px; border: 0; border-radius: 999px; background: transparent; color: var(--muted); font-size: 13px; transition: background 160ms ease, color 160ms ease; }
  .filter-chip strong { font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
  .filter-chip:hover { background: var(--surface-muted); color: var(--heading); }
  .filter-chip[aria-pressed="true"] { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent-strong); }
  .result-count { margin: 0; color: var(--muted); font-size: 13px; white-space: nowrap; }
  .table { border-block: 1px solid var(--line-soft); }
  table { width: 100%; table-layout: fixed; border-collapse: collapse; }
  .col-building { width: 27%; }
  .col-location { width: 22%; }
  .col-type { width: 9%; }
  .col-builders { width: 15%; }
  .col-date { width: 13%; }
  .col-actions { width: 132px; }
  th { padding: 14px 12px; color: var(--muted); font-size: 12px; font-weight: 500; text-align: left; background: color-mix(in srgb, var(--surface-muted) 38%, transparent); }
  td { padding: 20px 12px; border-top: 1px solid var(--line-soft); vertical-align: middle; font-size: 14px; overflow-wrap: anywhere; }
  th:first-child, td:first-child { padding-left: 16px; }
  tbody tr:hover { background: color-mix(in srgb, var(--surface) 60%, transparent); }
  .title { color: var(--heading); font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
  .meta { margin-top: 4px; color: var(--muted); font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
  .record-id { font-size: 11px; opacity: .9; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .date { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .badge { display: inline-flex; align-items: center; min-height: 24px; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 500; white-space: nowrap; }
  .original, .status-approved { background: color-mix(in srgb, var(--green) 10%, transparent); color: var(--green); }
  .derivative { background: color-mix(in srgb, var(--blue) 10%, transparent); color: var(--blue); }
  .replica, .status-pending { background: color-mix(in srgb, var(--amber) 10%, transparent); color: var(--amber); }
  .status-rejected { background: color-mix(in srgb, var(--red) 10%, transparent); color: var(--red); }
  .row-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .empty { padding: 72px 20px; text-align: center; color: var(--muted); }
  .empty .icon { width: 28px; height: 28px; margin-bottom: 12px; color: var(--accent-strong); }
  .empty strong { display: block; color: var(--heading); font-size: 16px; font-weight: 550; }
  .empty p { margin: 8px auto 16px; max-width: 28rem; font-size: 14px; }
  .empty .btn { margin-inline: auto; }
  .review-board__head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-block: 24px; }
  .review-board__head h2 { margin: 0; color: var(--heading); font-size: 16px; font-weight: 550; }
  .review-board__head p { margin: 6px 0 0; color: var(--muted); font-size: 13px; }
  .review-list { border-block: 1px solid var(--line-soft); }
  .review-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 20px; padding: 24px 16px; border-bottom: 1px solid var(--line-soft); }
  .review-item:last-child { border-bottom: 0; }
  .review-item__meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .overlay { position: fixed; inset: 0; width: 100%; max-width: none; height: 100%; max-height: none; margin: 0; padding: max(24px, env(safe-area-inset-top, 0px)) max(24px, env(safe-area-inset-right, 0px)) max(24px, env(safe-area-inset-bottom, 0px)) max(24px, env(safe-area-inset-left, 0px)); border: 0; background: transparent; color: var(--text); }
  .overlay[open] { display: flex; align-items: center; justify-content: center; }
  .overlay::backdrop { background: var(--scrim); backdrop-filter: blur(14px) saturate(115%); -webkit-backdrop-filter: blur(14px) saturate(115%); }
  html:has(.overlay[open]) { overflow: hidden; }
  .modal { width: min(800px, 100%); max-height: 100%; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; overflow: hidden; border: 1px solid var(--line-soft); border-radius: 24px; background: var(--surface-strong); box-shadow: 0 24px 100px var(--shadow); }
  .modal--import { width: min(640px, 100%); }
  .modal-head, .modal-foot { display: flex; align-items: center; gap: 12px; padding: 20px 28px; }
  .modal-head { border-bottom: 1px solid var(--line-soft); }
  .modal-title { margin: 0; color: var(--heading); font-size: 20px; font-weight: 550; line-height: 1.4; overflow-wrap: anywhere; }
  .modal-subtitle { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
  .modal-foot { flex-wrap: wrap; justify-content: flex-end; border-top: 1px solid var(--line-soft); }
  .modal-body { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 24px 28px 32px; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
  .field { display: grid; align-content: start; gap: 8px; min-width: 0; }
  .full { grid-column: 1 / -1; }
  label { color: var(--text); font-size: 13px; font-weight: 550; }
  label span { margin-left: 6px; color: var(--muted); font-size: 12px; font-weight: 400; }
  .hint { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
  .section { grid-column: 1 / -1; margin: 8px 0 -4px; padding-top: 24px; border-top: 1px solid var(--line-soft); color: var(--heading); font-size: 15px; font-weight: 600; }
  .section:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
  .coordinate-grid { display: grid; grid-template-columns: 1.4fr repeat(3, 1fr); gap: 12px; }
  .source-fields { padding-top: 20px; border-top: 1px solid var(--line-soft); }
  .source-fields summary { min-height: 44px; color: var(--heading); font-size: 14px; font-weight: 550; cursor: pointer; }
  .source-fields summary span { margin-left: 8px; color: var(--muted); font-size: 12px; font-weight: 400; }
  .source-fields[open] .grid { padding-top: 8px; }
  #import-json { min-height: 240px; }
  .preview { border-radius: 12px; padding: 12px 16px; background: var(--surface-muted); color: var(--muted); font-size: 13px; }
  #toast { position: fixed; right: max(24px, env(safe-area-inset-right, 0px)); bottom: max(24px, env(safe-area-inset-bottom, 0px)); z-index: 80; width: min(400px, calc(100% - 48px)); padding: 16px 20px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface-strong); color: var(--text); box-shadow: 0 12px 48px var(--shadow); font-size: 14px; }
  #toast.ok { border-color: color-mix(in srgb, var(--green) 50%, var(--line)); }
  #toast.err { border-color: var(--red); }
  @media (max-width: 1000px) {
    .identity { display: none; }
    .admin-hero { grid-template-columns: minmax(0, 1fr); gap: 24px; }
    .admin-hero .search-field { max-width: none; }
    .col-building { width: 26%; }
    .col-location { width: 21%; }
    .col-builders { width: 12%; }
    td { padding-inline: 8px; }
  }
  @media (max-width: 760px) {
    .topbar-inner { min-height: 68px; gap: 8px; padding-inline: max(16px, env(safe-area-inset-left, 0px)); }
    .brand { gap: 12px; }
    .brand span { padding-left: 12px; }
    .header-actions { gap: 0; }
    #theme-btn { width: 44px; padding: 0; }
    #theme-label { display: none; }
    main { padding: 28px 20px 0; }
    .admin-hero { margin-bottom: 24px; }
    .workspace-bar { align-items: stretch; gap: 16px; }
    .view-tabs { width: 100%; }
    .view-tab { flex: 1; padding-inline: 12px; }
    .page-actions { justify-content: flex-end; width: 100%; }
    .tools { flex-wrap: wrap; gap: 12px; padding-block: 16px; }
    .summary { gap: 2px; }
    .filter-chip { min-height: 40px; padding-inline: 10px; }
    .result-count { width: 100%; padding-left: 10px; font-size: 12px; }
    table, tbody { display: block; }
    colgroup, thead { display: none; }
    tr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; padding: 20px 4px; border-top: 1px solid var(--line-soft); }
    tr:first-child { border-top: 0; }
    td, td:first-child { display: block; border: 0; padding: 0; }
    td[data-label]::before { content: attr(data-label); display: block; margin-bottom: 4px; color: var(--muted); font-size: 12px; }
    .building-cell { grid-column: 1 / -1; }
    .actions-cell { display: flex; grid-column: 1 / -1; align-items: flex-end; justify-content: flex-end; }
    .actions-cell .btn { min-height: 44px; padding-inline: 16px; }
    .empty-cell { grid-column: 1 / -1; }
    .record-id { font-size: 11px; }
    .review-board__head { align-items: flex-start; gap: 12px; }
    .review-item { grid-template-columns: minmax(0, 1fr); gap: 16px; padding: 24px 4px; }
    .review-item .row-actions { justify-content: flex-end; }
    .review-item .btn { min-height: 44px; }
    .overlay { padding: 12px; }
    .modal { border-radius: 20px; }
    .modal-head, .modal-foot { padding: 16px 20px; gap: 8px; }
    .modal-body { padding: 20px; }
    .modal-title { font-size: 18px; }
    .grid { grid-template-columns: minmax(0, 1fr); gap: 16px; }
    .coordinate-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .coordinate-grid .field:first-child { grid-column: 1 / -1; }
    input, textarea, select { font-size: 16px; }
    .modal-foot .btn { padding-inline: 14px; font-size: 13px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
  }
`;
