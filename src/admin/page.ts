import { ADMIN_STYLES } from './styles';
import { BUILDING_EDITOR_HTML } from './buildings/editor';
import { ADMIN_IMAGE_PREVIEW } from './buildings/gallery';
import { BUILDING_IMPORT_HTML } from './buildings/import';
import { BUILDINGS_LIST_HTML } from './buildings/list';
import { BUILDINGS_SCRIPT } from './buildings/script';
import { icon } from './icons';
import { WORKSPACE_SCRIPT } from './script';
import { SPONSORS_HTML } from './sponsors/page';
import { SPONSORS_SCRIPT } from './sponsors/script';

export function adminPage(imageBaseUrl?: string, view: 'buildings' | 'sponsors' = 'buildings'): Response {
  const nonce = createNonce();

  return new Response(workspaceHtml(view).replaceAll('__NONCE__', nonce), {
    headers: htmlHeaders(nonce, imageBaseUrl ? new URL(imageBaseUrl).origin : undefined),
  });
}

function htmlHeaders(nonce: string, imageOrigin?: string): HeadersInit {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy':
      `default-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'${imageOrigin ? ' ' + imageOrigin : ''}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
  };
}

function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function workspaceHtml(view: 'buildings' | 'sponsors'): string {
  const sponsors = view === 'sponsors';
  return /* html */ `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${sponsors ? '赞助管理 | ' : ''}MIK 管理工作台</title>
<script nonce="__NONCE__">
try {
  const theme = localStorage.getItem('mikdata-admin-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {}
</script>
<style nonce="__NONCE__">${ADMIN_STYLES}</style>
</head>
<body>
<a class="skip-link" href="#main">跳转到内容</a>
<div class="app">
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand"><strong>MIK</strong><span>管理工作台</span></div>
      <div class="grow"></div>
      <div class="header-actions">
        <button class="btn ghost" id="theme-btn" type="button" aria-label="配色：跟随系统，点击切换浅色">${icon('theme')}<span id="theme-label">跟随系统</span></button>
        <button class="btn ghost icon-btn" id="refresh-btn" type="button" aria-label="刷新全部数据" title="刷新全部数据">${icon('refresh')}</button>
      </div>
    </div>
  </header>
  <nav class="module-nav" aria-label="管理模块">
    <a class="module-link" href="/admin"${sponsors ? '' : ' aria-current="page"'}>${icon('building')}建筑管理</a>
    <a class="module-link" href="/admin/sponsors"${sponsors ? ' aria-current="page"' : ''}>${icon('heart')}赞助管理</a>
  </nav>
  ${sponsors ? SPONSORS_HTML : BUILDINGS_LIST_HTML}
</div>
${sponsors ? '' : BUILDING_EDITOR_HTML + BUILDING_IMPORT_HTML + ADMIN_IMAGE_PREVIEW}
<div id="toast" role="status" aria-live="polite" hidden></div>
<script nonce="__NONCE__">
${WORKSPACE_SCRIPT}
${sponsors ? SPONSORS_SCRIPT : BUILDINGS_SCRIPT}
</script>
</body>
</html>`;
}
