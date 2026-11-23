import { MAX_ORDER_AT } from '../../sponsors/model';

export const SPONSOR_TIME_EDITOR_SCRIPT = /* js */ String.raw`
const sponsorLocalZone = sponsorDate.resolvedOptions().timeZone;
const sponsorZoneIds = Intl.supportedValuesOf?.('timeZone') ?? [];
const sponsorZonePresets = {
  local: { label: '本地（' + sponsorLocalZone + '）', ...sponsorRegionalZone(sponsorLocalZone) },
  beijing: { label: '北京时间（UTC+08:00）', offset: () => 8 * 3600 },
  utc: { label: 'UTC', offset: () => 0 },
};

function sponsorTimeFields() {
  return '<fieldset class="sponsor-payment-time"><legend>付款时间</legend>' +
    '<div class="sponsor-time-inputs">' +
    sponsorField('日期', 'sponsor-order-date', 'type="date" required') +
    '<div class="field"><label for="sponsor-order-time">时间</label>' +
    '<input id="sponsor-order-time" type="time" step="1" required aria-describedby="sponsor-order-time-feedback"></div></div>' +
    '<div class="field"><label for="sponsor-order-zone">时区</label>' +
    '<select id="sponsor-order-zone">' +
    Object.entries(sponsorZonePresets).map(([id, zone]) =>
      '<option value="' + id + '">' + esc(zone.label) + '</option>',
    ).join('') +
    '<option id="sponsor-order-custom-zone" value="custom" hidden></option>' +
    '<option value="choose">自定义时区…</option></select></div>' +
    '<div class="sponsor-time-tools sponsor-time-actions">' +
    '<label class="sponsor-zone-keep"><input type="checkbox" id="sponsor-order-zone-keep">切换时区时保留日期和时间</label>' +
    '<button type="button" class="btn ghost" id="sponsor-order-now">设为现在</button></div>' +
    '<div class="field" id="sponsor-order-zone-search" hidden>' +
    '<label for="sponsor-order-zone-query">地区时区或 UTC 偏移</label>' +
    '<div class="sponsor-time-tools"><input type="search" id="sponsor-order-zone-query" autocomplete="off" spellcheck="false" maxlength="80" ' +
    'aria-describedby="sponsor-order-zone-hint"><button type="button" class="btn ghost" id="sponsor-order-zone-apply">应用</button></div>' +
    '<p class="hint" id="sponsor-order-zone-hint">可搜索城市英文名，或输入 Asia/Tokyo、+05:30。</p>' +
    '<ul class="sponsor-zone-results" id="sponsor-order-zone-results" aria-label="匹配的时区" hidden></ul></div>' +
    '<div class="field" id="sponsor-order-offset-field" hidden><label for="sponsor-order-offset">重复时段的 UTC 偏移</label>' +
    '<select id="sponsor-order-offset" aria-describedby="sponsor-order-time-feedback"></select></div>' +
    '<p class="hint sponsor-time-feedback" id="sponsor-order-time-feedback" role="status"></p></fieldset>';
}

function sponsorOffsetSeconds(sign, hours, minutes = 0, seconds = 0) {
  return (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * (sign === '-' ? -1 : 1);
}

function sponsorOffsetLabel(offset) {
  const absolute = Math.abs(offset);
  const pad = (number) => String(number).padStart(2, '0');
  const seconds = absolute % 60;
  return 'UTC' + (offset < 0 ? '-' : '+') + pad(Math.floor(absolute / 3600)) + ':' +
    pad(Math.floor(absolute / 60) % 60) + (seconds ? ':' + pad(seconds) : '');
}

function sponsorRegionalZone(timeZone) {
  const format = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
  return {
    id: format.resolvedOptions().timeZone,
    offset(at) {
      const part = format.formatToParts(new Date(at * 1000)).find((part) => part.type === 'timeZoneName');
      const match = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(part.value);
      return match ? sponsorOffsetSeconds(...match.slice(1)) : 0;
    },
  };
}

function parseSponsorZone(text) {
  const value = text.trim().replace('−', '-');
  const fixed = /^(?:UTC)?([+-])(\d{1,2})(?::([0-5]\d))?$/i.exec(value);
  if (fixed && Number(fixed[2]) <= 23) {
    const offset = sponsorOffsetSeconds(...fixed.slice(1));
    return { id: sponsorOffsetLabel(offset), offset: () => offset };
  }
  if (!/^[a-z][a-z0-9_+-]*(?:\/[a-z0-9_+-]+)*$/i.test(value)) return;
  try {
    return sponsorRegionalZone(value);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
}

function sponsorWallValue(at) {
  return new Date(at * 1000).toISOString().split('.')[0].replace(/^\+0*/, '');
}

function sponsorWallSeconds(value) {
  const iso = value.replace(/^\d{5,6}(?=-)/, (year) => '+' + year.padStart(6, '0'));
  const wall = Date.parse(iso + 'Z') / 1000;
  return Number.isFinite(wall) && sponsorWallValue(wall) === value ? wall : NaN;
}

function sponsorTimeCandidates(wall, zone) {
  // Resolve the offsets on both sides of any nearby clock change.
  const offsets = new Set([-86400, 0, 86400].map((delta) => zone.offset(wall + delta)));
  return [...offsets].map((offset) => wall - offset)
    .filter((at) => at + zone.offset(at) === wall)
    .sort((a, b) => a - b);
}

function initSponsorTime(initialAt) {
  const date = $('sponsor-order-date');
  const time = $('sponsor-order-time');
  const zoneSelect = $('sponsor-order-zone');
  const zoneSearch = $('sponsor-order-zone-search');
  const query = $('sponsor-order-zone-query');
  const results = $('sponsor-order-zone-results');
  const offsetField = $('sponsor-order-offset-field');
  const offsetSelect = $('sponsor-order-offset');
  const feedback = $('sponsor-order-time-feedback');
  let zone = sponsorZonePresets.local;
  let customZone;
  let selection;

  function wallValue() {
    if (!date.value || !time.value) return '';
    return date.value + 'T' + (time.value.length === 5 ? time.value + ':00' : time.value);
  }

  function resolveTime() {
    const value = wallValue();
    const wall = value ? sponsorWallSeconds(value) : NaN;
    const outOfRange = wall <= -86400 || wall > ${MAX_ORDER_AT} + 86400;
    const candidates = Number.isFinite(wall) && !outOfRange ? sponsorTimeCandidates(wall, zone) : [];
    const choices = candidates.filter((at) => at > 0 && at <= ${MAX_ORDER_AT});
    const saved = selection?.value === value && selection.zone === zone ? selection.at : undefined;
    const at = choices.includes(saved) ? saved : choices.length === 1 ? choices[0] : undefined;
    let error = '';
    if (value && !choices.length) {
      if (outOfRange || candidates.length) error = '付款时间超出可保存范围。';
      else if (!Number.isFinite(wall)) error = '请输入有效的日期和时间。';
      else error = '所选时区的时钟跳过了这个时间。请调整时间或时区。';
    }
    return { choices, at, error };
  }

  function renderTime() {
    const { choices, at, error } = resolveTime();
    const repeat = choices.length > 1;
    offsetField.hidden = !repeat;
    offsetSelect.required = repeat;
    if (repeat) {
      offsetSelect.innerHTML = '<option value="">选择 UTC 偏移</option>' + choices.map((instant, index) =>
        '<option value="' + instant + '">' + (index === 0 ? '第一次' : '第二次') +
        '（' + sponsorOffsetLabel(zone.offset(instant)) + '）</option>',
      ).join('');
      offsetSelect.value = at === undefined ? '' : String(at);
    }

    time.setCustomValidity(error);
    time.setAttribute('aria-invalid', String(Boolean(error)));
    feedback.classList.toggle('sponsor-time-error', Boolean(error));
    let message = error;
    if (at !== undefined) {
      message = zone === sponsorZonePresets.utc || zone.id === 'UTC'
        ? '本地 ' + sponsorDate.format(new Date(at * 1000))
        : 'UTC ' + sponsorWallValue(at).replace('T', ' ') + ' · ' + sponsorOffsetLabel(zone.offset(at));
    } else if (repeat) {
      message = '这个时间在所选时区出现了两次，请选择 UTC 偏移。';
    }
    feedback.textContent = message;
  }

  function setTime(at) {
    const value = sponsorWallValue(at + zone.offset(at));
    [date.value, time.value] = value.split('T');
    selection = { value, zone, at };
    renderTime();
  }

  function setZone(next) {
    const at = $('sponsor-order-zone-keep').checked ? undefined : resolveTime().at;
    zone = next;
    zoneSearch.hidden = true;
    query.required = false;
    query.setCustomValidity('');
    if (at === undefined) renderTime();
    else setTime(at);
  }

  function renderZoneResults() {
    const words = query.value.trim().toLowerCase().split(/[\s/_]+/).filter(Boolean);
    const matches = words.length ? sponsorZoneIds.filter((id) => {
      const name = id.toLowerCase();
      return words.every((word) => name.includes(word));
    }).slice(0, 5) : [];
    results.hidden = matches.length === 0;
    results.innerHTML = matches.map((id) =>
      '<li><button type="button" class="sponsor-player-option" data-time-zone="' + esc(id) + '">' +
      esc(id) + '</button></li>',
    ).join('');
    query.setCustomValidity(query.value.trim() ? '请先应用此时区。' : '');
  }

  function applyZone(value) {
    const match = results.children.length === 1 ? results.querySelector('[data-time-zone]') : null;
    const next = parseSponsorZone(value) ?? (match ? sponsorRegionalZone(match.dataset.timeZone) : undefined);
    if (!next) {
      query.setCustomValidity('请输入有效的地区时区或 UTC 偏移。');
      query.reportValidity();
      return;
    }
    customZone = next;
    const option = $('sponsor-order-custom-zone');
    option.textContent = next.id;
    option.hidden = false;
    zoneSelect.value = 'custom';
    setZone(next);
    zoneSelect.focus();
  }

  date.addEventListener('input', renderTime);
  time.addEventListener('input', renderTime);
  zoneSelect.addEventListener('change', () => {
    if (zoneSelect.value === 'choose') {
      zoneSearch.hidden = false;
      query.required = true;
      query.value = customZone?.id ?? '';
      renderZoneResults();
      query.focus();
    } else {
      setZone(zoneSelect.value === 'custom' ? customZone : sponsorZonePresets[zoneSelect.value]);
    }
  });
  query.addEventListener('input', renderZoneResults);
  query.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    applyZone(query.value);
  });
  $('sponsor-order-zone-apply').addEventListener('click', () => applyZone(query.value));
  results.addEventListener('click', (event) => {
    const option = event.target.closest('[data-time-zone]');
    if (option) applyZone(option.dataset.timeZone);
  });
  offsetSelect.addEventListener('change', () => {
    selection = offsetSelect.value ? { value: wallValue(), zone, at: Number(offsetSelect.value) } : undefined;
    renderTime();
  });
  $('sponsor-order-now').addEventListener('click', () => setTime(Math.floor(Date.now() / 1000)));
  if (initialAt !== undefined) setTime(initialAt);
  return () => resolveTime().at;
}
`;
