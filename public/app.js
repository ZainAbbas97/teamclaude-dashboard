// TeamClaude Dashboard — client
import { buildModel, renderForecast } from './forecast.js';
import { renderDetails } from './details.js';

const $ = (sel) => document.querySelector(sel);
const POOLS = [['anthropic', 'Claude'], ['codex', 'Codex']];

const state = { status: null, online: false, lastUpdate: 0, busy: new Set(), openMenu: null };

// ---------- prefs / theme ----------
function readPref(k) { try { return localStorage.getItem('tcd.' + k); } catch { return null; } }
function writePref(k, v) { try { localStorage.setItem('tcd.' + k, v); } catch { /* private mode */ } }
if (readPref('theme')) document.documentElement.dataset.theme = readPref('theme');
$('#theme').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  writePref('theme', next);
});

// ---------- formatting ----------
const parseTs = (v) => (v == null ? NaN : typeof v === 'number' ? v : Date.parse(v));

function fmtIn(ms) {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}
function fmtClock(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
function fmtAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
const level = (r) => (r >= 0.9 ? 'bad' : r >= 0.7 ? 'warn' : '');

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// ---------- data helpers ----------
const keyOf = (a) => `${a.provider}:${a.name}:${a.orgName || ''}`;

function accountsFor(pool) {
  return (state.status?.accounts || [])
    .filter((a) => a.provider === pool)
    .sort((a, b) => (a.disabled - b.disabled) || ((a.priority ?? 99) - (b.priority ?? 99)));
}
function isCurrent(a) {
  const s = state.status;
  if (s?.currentAccounts?.[a.provider] !== a.name) return false;
  const idx = s.currentIndexes?.[a.provider];
  return idx == null || s.accounts[idx] === a;
}
function problem(a) {
  if (a.disabled) return ['Disabled', ''];
  if (a.credentialRejectedUntil || a.status === 'error' || a.errorReason) return ['Needs re-login', 'bad'];
  if (a.cordoned) return ['Cordoned', 'warn'];
  if (parseTs(a.rateLimitedUntil) > Date.now()) return ['Rate limited', 'warn'];
  return null;
}
// Banked usage-limit resets (claude.ai "Resets" offers; Codex reset credits).
// TeamClaude refreshes the count on each quota probe; drop readings older than
// 7 days or past their expiry, as TeamClaude's own screens do.
export function bankedResets(a) {
  const r = a?.quota?.resetCredits;
  if (!r || !(r.available > 0)) return null;
  const now = Date.now();
  if (Number.isFinite(r.seenAt) && now - r.seenAt > 7 * 864e5) return null;
  if (Number.isFinite(r.expiresAt) && r.expiresAt <= now) return null;
  const fable = Math.min(Math.max(r.fable || 0, 0), r.available);
  return {
    total: r.available, full: r.available - fable, fable, usableNow: r.applicable || 0,
    expiresAt: Number.isFinite(r.expiresAt) ? r.expiresAt : null, codex: a.provider === 'codex',
  };
}
function resetsText(b) {
  if (b.codex) return `${b.total} reset credit${b.total === 1 ? '' : 's'}`;
  const parts = [];
  if (b.full) parts.push(`${b.full} full`);
  if (b.fable) parts.push(`${b.fable} Fable`);
  return `${b.total} reset${b.total === 1 ? '' : 's'} (${parts.join(' + ')})`;
}

function threshold() {
  const t = state.status?.switchThreshold;
  return typeof t === 'number' ? t : typeof t?.default === 'number' ? t.default : 0.98;
}

// ---------- render ----------
function render() {
  const live = $('#live');
  live.className = 'live ' + (state.online ? 'on' : 'off');
  $('#live-text').textContent = state.online ? 'Live' : 'Offline';
  live.title = state.lastUpdate ? 'Updated ' + new Date(state.lastUpdate).toLocaleTimeString() : '';
  $('#offline').hidden = state.online || !state.lastUpdate;
  const inp = $('#threshold');
  if (state.status && document.activeElement !== inp) inp.value = Math.round(threshold() * 1000) / 10;

  renderForecastIfChanged();
  renderWeeklyBar();

  const box = $('#pools');
  box.replaceChildren();
  if (!state.status) { box.append(h('div', { class: 'table empty' }, 'Connecting to TeamClaude…')); return; }
  for (const [pool, label] of POOLS) {
    const list = accountsFor(pool);
    if (!list.length) continue;
    box.append(h('section', { class: 'pool' },
      h('h2', {}, label),
      h('div', { class: 'table' },
        h('div', { class: 'cols', 'aria-hidden': 'true' },
          h('span', {}, 'Account'), h('span', {}, '5-hour session'), h('span', {}, 'Weekly'), h('span', {}, 'Last chat'), h('span', {})),
        list.map((a, i) => row(a, i, list.length)),
      ),
    ));
  }
  renderDrawer();
}

function row(a, i, n) {
  const cur = isCurrent(a);
  const q = a.quota || {};
  const p = problem(a);
  const key = keyOf(a);
  const br = bankedResets(a);
  const brTag = br ? h('span', {
    class: 'reset-tag',
    title: `${resetsText(br)}` + (br.expiresAt ? ` · expire ${fmtClock(br.expiresAt)}` : '') + (br.usableNow < br.total ? ` · ${br.usableNow} usable now` : ''),
  }, `↺ ${br.total}`) : null;
  const sub = [a.orgName, cur ? h('span', { class: 'tag' }, 'In use') : null, p ? h('span', { class: 'tag ' + p[1] }, p[0]) : null, brTag]
    .filter(Boolean)
    .flatMap((x, j) => (j ? [' · ', x] : [x]));

  const open = () => { state.detail = key; state.detailReturn = key; render(); };
  return h('div', {
    class: 'row clickable' + (cur ? ' current' : '') + (a.disabled ? ' off' : ''),
    tabindex: '0', 'data-key': key, 'aria-label': `Show details for ${a.name}`,
    onclick: open,
    onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); open(); } },
  },
    h('div', { class: 'acct' },
      h('span', { class: 'rank', title: 'Rotation order' }, i + 1),
      h('div', {}, h('div', { class: 'name', title: a.name }, a.name), h('div', { class: 'sub' }, sub)),
    ),
    quota('5-hour', q.unified5h, q.unified5hReset),
    quota('Weekly', q.unified7d, q.unified7dReset),
    lastChat(a),
    actions(a, i, n, cur, key),
  );
}

function quota(label, ratio, resetAt) {
  const r = ratio == null ? null : Math.max(0, Math.min(1, Number(ratio)));
  const t = parseTs(resetAt);
  const future = !isNaN(t) && t > Date.now();
  return h('div', { class: 'q' },
    h('div', { class: 'top-line' },
      h('span', { class: 'pct' + (r == null ? ' none' : '') }, h('span', { class: 'label' }, label + ' '), r == null ? '—' : Math.round(r * 100) + '%'),
      future ? h('span', { class: 'when' }, fmtClock(t)) : null,
    ),
    h('div', { class: 'bar' }, r == null ? null : h('i', { class: level(r), style: `width:${(r * 100).toFixed(1)}%` })),
    h('div', { class: 'cd', 'data-reset': future ? t : null },
      r == null ? 'no reading yet' : future ? `resets in ${fmtIn(t - Date.now())}` : 'reset time unknown'),
  );
}

function lastChat(a) {
  const lc = state.status?.lastChats;
  const c = lc?.byAccount?.[`${a.provider}:${a.name}`];
  if (!c) {
    return h('div', { class: 'chat' }, h('span', { class: 'none' },
      lc && !lc.available ? 'activity log not on yet' : 'no chats yet'));
  }
  const folders = c.projects?.length ? c.projects : [{ name: c.project || 'Unknown folder', at: c.at, chats: [{ sid: c.sid, title: c.title, at: c.at }] }];
  const top = folders[0];
  const latest = top.chats[0];
  const others = folders.slice(1).map((f) => f.name);
  const chatTitles = top.chats.map((x) => x.title || `Session ${x.sid}`);
  return h('div', { class: 'chat' },
    h('div', { class: 'title', title: chatTitles.join('\n') },
      h('span', { class: 'folder' }, top.name),
      top.chats.length > 1 ? h('span', { class: 'count' }, ` · ${top.chats.length} chats`) : null),
    h('div', { class: 'meta', title: latest.title || '' },
      [latest.title, fmtAgo(top.at)].filter(Boolean).join(' · ')),
    others.length ? h('div', { class: 'meta also', title: others.join(', ') }, 'also ' + others.join(', ')) : null,
  );
}

function actions(a, i, n, cur, key) {
  if (a.provider === 'codex') return h('div', { class: 'act' });
  const busy = state.busy.has(key);
  const open = state.openMenu === key;
  return h('div', { class: 'act', onclick: (e) => e.stopPropagation(), onkeydown: (e) => e.stopPropagation() },
    cur ? null : h('button', { class: 'btn', disabled: busy || a.disabled, onclick: () => act(a, 'switch') }, 'Use'),
    h('button', {
      class: 'btn more', 'aria-label': 'More actions', 'aria-expanded': String(open),
      onclick: (e) => { e.stopPropagation(); state.openMenu = open ? null : key; render(); },
    }, '⋯'),
    open ? h('div', { class: 'menu', onclick: (e) => e.stopPropagation() },
      h('button', { disabled: busy || i === 0, onclick: () => act(a, 'first') }, 'Move to first'),
      h('button', { disabled: busy || i === n - 1, onclick: () => act(a, 'last') }, 'Move to last'),
      h('button', { disabled: busy, onclick: () => act(a, a.cordoned ? 'uncordon' : 'cordon') }, a.cordoned ? 'Uncordon' : 'Cordon (finish current chats)'),
      h('button', { class: a.disabled ? '' : 'danger', disabled: busy, onclick: () => act(a, a.disabled ? 'enable' : 'disable') }, a.disabled ? 'Enable' : 'Disable'),
    ) : null,
  );
}
// ---------- weekly forecast ----------
const fc = { view: readPref("fcview") || "all", sig: "" };

function renderForecastIfChanged(force = false) {
  const s = state.status;
  if (!s) return;
  const el = $("#forecast");
  // Redraw only when the inputs move (keeps the hover crosshair steady between polls),
  // and at least once a minute so the projection starts from now.
  const sig = JSON.stringify([
    fc.view, s.switchThreshold, s.labels, el.clientWidth, Math.floor(Date.now() / 60000),
    (s.accounts || []).map((a) => [a.name, a.provider, a.disabled, a.priority, a.quota?.unified7d, a.quota?.unified7dReset]),
    Object.values(s.weeklyHistory || {}).map((r) => r.length),
  ]);
  if (!force && sig === fc.sig) return;
  if (!force && el.contains(document.activeElement) && document.activeElement.tagName === "svg") return;
  fc.sig = sig;
  renderForecast(el, buildModel(s), {
    view: fc.view,
    onView: (id) => { fc.view = id; writePref("fcview", id); renderForecastIfChanged(true); },
  });
}
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => renderForecastIfChanged(true), 150); });

document.addEventListener('click', () => { if (state.openMenu) { state.openMenu = null; render(); } });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.openMenu) { state.openMenu = null; render(); return; }
  if (state.detail) closeDetail();
});

// ---------- combined weekly bar (top) ----------
function renderWeeklyBar() {
  const el = $('#weekly-bar');
  const s = state.status;
  const accts = (s?.accounts || [])
    .filter((a) => a.provider === 'anthropic' && !a.disabled && a.quota?.unified7d != null)
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  if (!accts.length) { el.hidden = true; return; }
  el.hidden = false;
  const labels = s.labels || {};
  const name = (a) => labels[a.name] || a.name.split('@')[0];
  const r = accts.reduce((sum, a) => sum + a.quota.unified7d, 0) / accts.length;
  const resets = accts.map((a) => parseTs(a.quota.unified7dReset)).filter((t) => t > Date.now()).sort((x, y) => x - y);
  el.replaceChildren(
    h('div', { class: 'wk-line' },
      h('span', { class: 'wk-title' }, `Weekly usage · ${accts.length} Claude accounts combined`),
      h('span', { class: 'wk-pct' }, Math.round(r * 100) + '%')),
    h('div', { class: 'bar', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(r * 100)), 'aria-label': 'Combined weekly usage' },
      h('i', { class: level(r), style: `width:${(r * 100).toFixed(1)}%` })),
    h('div', { class: 'wk-meta' },
      h('span', {}, accts.map((a) => `${name(a)} ${Math.round(a.quota.unified7d * 100)}%`).join(' · ')),
      h('span', {}, [
        resets.length ? `weekly resets ${fmtClock(resets[0])}` : null,
        bankedSummary(accts),
      ].filter(Boolean).join(' · '))),
  );
}

// "1 full reset banked" — the kind that clears the shared weekly; Fable-only ones listed after.
function bankedSummary(accts) {
  let full = 0, fable = 0, exp = null;
  for (const a of accts) {
    const b = bankedResets(a);
    if (!b) continue;
    full += b.full; fable += b.fable;
    if (b.expiresAt && (exp == null || b.expiresAt < exp)) exp = b.expiresAt;
  }
  if (!full && !fable) return null;
  const parts = [];
  if (full) parts.push(`${full} full`);
  if (fable) parts.push(`${fable} Fable`);
  return `↺ ${parts.join(' + ')} reset${full + fable === 1 ? '' : 's'} banked` + (exp ? `, expire ${fmtClock(exp)}` : '');
}

// ---------- account details drawer ----------
function closeDetail() {
  const back = state.detailReturn;
  state.detail = null;
  render();
  document.querySelector(`.row[data-key="${CSS.escape(back || '')}"]`)?.focus();
}
function renderDrawer() {
  const root = $('#drawer');
  const s = state.status;
  const a = state.detail && s ? (s.accounts || []).find((x) => keyOf(x) === state.detail) : null;
  const wasOpen = !root.hidden;
  if (!a) { if (wasOpen) { root.replaceChildren(); root.hidden = true; document.body.classList.remove('locked'); } return; }
  const list = accountsFor(a.provider);
  const cur = isCurrent(a);
  const busy = state.busy.has(state.detail);
  renderDetails(root, {
    account: a, status: s, rank: list.indexOf(a) + 1, current: cur, onClose: closeDetail,
    actions: a.provider === 'codex' || cur ? null
      : h('button', { class: 'btn', disabled: busy || a.disabled, onclick: () => act(a, 'switch') }, 'Use now'),
  });
  document.body.classList.add('locked');
  if (!wasOpen) root.querySelector('.d-close')?.focus();
}

// Tick countdowns without a full re-render.
setInterval(() => {
  const now = Date.now();
  document.querySelectorAll('[data-reset]').forEach((el) => { el.textContent = `resets in ${fmtIn(Number(el.dataset.reset) - now)}`; });
  if (state.online && state.lastUpdate && now - state.lastUpdate > 8000) { state.online = false; render(); }
}, 1000);

// ---------- actions ----------
function toast(text, kind = '') {
  const t = h('div', { class: 'toast ' + kind }, text);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3500);
}
async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
async function act(a, kind) {
  const key = keyOf(a);
  const base = { account: a.name, ...(a.orgName ? { org: a.orgName } : {}) };
  const map = {
    switch: ['/teamclaude/switch', { account: a.name }, `Now using ${a.name}`],
    first: ['/teamclaude/priority', { ...base, place: 'first' }, `${a.name} is now first`],
    last: ['/teamclaude/priority', { ...base, place: 'last' }, `${a.name} is now last`],
    disable: ['/teamclaude/disable', { ...base, disabled: true }, `Disabled ${a.name}`],
    enable: ['/teamclaude/disable', { ...base, disabled: false }, `Enabled ${a.name}`],
    cordon: ['/teamclaude/account-cordon', { ...base, cordoned: true }, `Cordoned ${a.name}`],
    uncordon: ['/teamclaude/account-cordon', { ...base, cordoned: false }, `Uncordoned ${a.name}`],
  };
  if (kind === 'disable' && isCurrent(a) && !confirm(`Disable ${a.name}? New requests move to the next account.`)) return;
  const [path, body, okText] = map[kind];
  state.openMenu = null;
  state.busy.add(key); render();
  try {
    const res = await post(path, body);
    toast(kind === 'switch' && res.eligible === false ? `${a.name} isn't eligible right now` : okText, kind === 'switch' && res.eligible === false ? 'error' : '');
  } catch (e) { toast(e.message, 'error'); } finally { state.busy.delete(key); render(); }
}
async function topAction(btn, path, okText) {
  btn.disabled = true;
  try { await post(path); toast(okText); } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
}
$('#probe').addEventListener('click', (e) => topAction(e.currentTarget, '/teamclaude/probe', 'Refreshing quotas…'));
$('#reload').addEventListener('click', (e) => topAction(e.currentTarget, '/teamclaude/reload', 'Config reloaded'));
$('#threshold-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = Number($('#threshold').value);
  if (!(v >= 1 && v <= 100)) { toast('Enter a number from 1 to 100', 'error'); return; }
  try { await post('/teamclaude/threshold', { percent: v }); toast(`Switching at ${v}%`); $('#threshold').blur(); }
  catch (err) { toast(err.message, 'error'); }
});
$('#threshold').addEventListener('change', () => $('#threshold-form').requestSubmit());

// ---------- live connection + hot reload ----------
function connect() {
  const es = new EventSource('/events');
  es.addEventListener('status', (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (data.offline) { state.online = false; state.lastUpdate ||= Date.now(); render(); return; }
    state.status = data; state.online = true; state.lastUpdate = Date.now();
    render();
  });
  es.addEventListener('reload', () => location.reload());
  es.onerror = () => { state.online = false; render(); };
}
connect();
render();
