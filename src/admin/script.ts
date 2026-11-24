export const WORKSPACE_SCRIPT = /* js */ `
const $ = (id) => document.getElementById(id);
const THEME_KEY = 'mikdata-admin-theme';
const THEMES = ['system', 'light', 'dark'];
const themeLabel = { system: '跟随系统', light: '浅色模式', dark: '深色模式' };
let theme = readTheme();
let toastTimer;
function readTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return THEMES.includes(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme() {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.dataset.theme = theme;
  }

  $('theme-label').textContent = themeLabel[theme];
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  $('theme-btn').setAttribute('aria-label', '配色：' + themeLabel[theme] + '，点击切换' + themeLabel[next]);
  $('theme-btn').title = '配色：' + themeLabel[theme];
}

function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  theme = next;

  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {}

  applyTheme();
}

function writeHeaders(extra) {
  return { 'Content-Type': 'application/json', ...(extra || {}) };
}

async function contentHeaders(record) {
  const content = JSON.stringify(record, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
  });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { 'If-Match': '"' + hash + '"' };
}

async function readJson(res) {
  return res.json().catch(() => ({}));
}

function toast(message, ok) {
  const el = $('toast');
  (document.querySelector('dialog[open]') || document.body).append(el);
  el.hidden = false;
  el.textContent = message;
  el.classList.toggle('err', !ok);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ok ? 3500 : 6000);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

$('theme-btn').addEventListener('click', cycleTheme);
applyTheme();
`;
