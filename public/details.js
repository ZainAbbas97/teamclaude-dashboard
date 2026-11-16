// Account details drawer: everything we know about one account.
const SVGNS = 'http://www.w3.org/2000/svg';
const HOUR = 3600e3;

const parseTs = (v) => (v == null ? NaN : typeof v === 'number' ? v : Date.parse(v));

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

function fmtNum(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'K';
  return Math.round(n).toLocaleString();
}
function fmtIn(ms) {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${hh}h`;
  if (hh) return `${hh}h ${m}m`;
  return `${m}m`;
}
function fmtWhen(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  if (d.toDateString() === new Date(Date.now() - 864e5).toDateString()) return `yesterday ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
function fmtAgo(ts) {
  const t = parseTs(ts);
  if (isNaN(t)) return '—';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
const level = (r) => (r >= 0.9 ? 'bad' : r >= 0.7 ? 'warn' : '');
function modelName(id) {
  if (!id) return 'Unknown';
  const m = /^claude-(\w+)-(\d+)-(\d+)/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}

// ---------- sections ----------
function section(title, ...kids) {
  return h('section', { class: 'd-sec' }, h('h3', {}, title), ...kids);
}
function kv(rows) {
  return h('dl', { class: 'd-kv' }, rows.filter(Boolean).map(([k, v, hint]) =>
    h('div', {}, h('dt', {}, k), h('dd', {}, v, hint ? h('span', { class: 'hint' }, ' ' + hint) : null))));
}
function tiles(items) {
  return h('div', { class: 'd-tiles' }, items.map(([k, v, hint]) =>
    h('div', { class: 'd-tile' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), hint ? h('div', { class: 'hint' }, hint) : null)));
}

function quotaRow(label, ratio, resetAt, extra) {
  const r = ratio == null ? null : Math.max(0, Math.min(1, Number(ratio)));
  const t = parseTs(resetAt);
  const future = !isNaN(t) && t > Date.now();
  return h('div', { class: 'd-quota' },
    h('div', { class: 'd-qtop' }, h('span', { class: 'lbl' }, label), h('b', {}, pct(r))),
    h('div', { class: 'bar' }, r == null ? null : h('i', { class: level(r), style: `width:${(r * 100).toFixed(1)}%` })),
    h('div', { class: 'sub' },
      h('span', {}, future ? `resets ${fmtWhen(t)} · in ${fmtIn(t - Date.now())}` : r == null ? 'no reading yet' : 'reset time unknown'),
      extra ? h('span', {}, extra) : null),
  );
}

function sparkline(series, T) {
  // series: [[t, weekly, reset], ...] — recorded weekly usage
  if (!series || series.length < 2) return h('div', { class: 'd-note' }, 'Weekly history appears after about 30 minutes of samples.');
  const W = 400, H = 64, pad = 4;
  const t0 = series[0][0], t1 = series[series.length - 1][0];
  const X = (t) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad * 2);
  const Y = (v) => H - pad - Math.min(1, v) * (H - pad * 2);
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'd-spark');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Weekly usage went from ${pct(series[0][1])} to ${pct(series[series.length - 1][1])}`);
  const mk = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); svg.append(e); return e; };
  mk('line', { x1: pad, x2: W - pad, y1: Y(T), y2: Y(T), class: 'lim' });
  const d = series.map((r, i) => `${i ? 'L' : 'M'}${X(r[0]).toFixed(1)},${Y(r[1]).toFixed(1)}`).join(' ');
  mk('path', { d: `${d} L${X(t1)},${H - pad} L${X(t0)},${H - pad} Z`, class: 'wash' });
  mk('path', { d, class: 'ln' });
  const last = series[series.length - 1];
  mk('circle', { cx: X(last[0]), cy: Y(last[1]), r: 4, class: 'dot' });
  return h('div', {}, svg, h('div', { class: 'd-spark-axis' }, h('span', {}, fmtWhen(t0)), h('span', {}, 'now')));
}

// Banked usage-limit resets: the claude.ai "Resets" offers (Codex: reset credits).
function resetsSection(a, status) {
  const r = a.quota?.resetCredits;
  const now = Date.now();
  const stale = !r || (Number.isFinite(r.seenAt) && now - r.seenAt > 7 * 864e5);
  const expired = r && Number.isFinite(r.expiresAt) && r.expiresAt <= now;
  if (stale || expired || !(r.available > 0)) {
    return section('Banked resets', h('div', { class: 'd-note' },
      stale ? 'Not read yet. Refresh quotas to check.' : 'None right now.'));
  }
  const fable = Math.min(Math.max(r.fable || 0, 0), r.available);
  const full = r.available - fable;
  const isCodex = a.provider === 'codex';
  return section('Banked resets',
    kv([
      isCodex ? ['Reset credits', String(r.available), 'clear an exhausted Codex window'] : null,
      !isCodex && full ? ['Full resets', String(full), 'clear 5-hour + weekly'] : null,
      !isCodex && fable ? ['Fable resets', String(fable), 'clear the Fable weekly only'] : null,
      ['Usable now', r.applicable >= r.available ? 'Yes' : `${r.applicable || 0} of ${r.available}`],
      Number.isFinite(r.expiresAt) ? ['Expire', fmtWhen(r.expiresAt), `in ${fmtIn(r.expiresAt - now)}`] : null,
      ['Checked', fmtAgo(r.seenAt)],
    ]),
    h('div', { class: 'd-note', style: 'margin-top:10px' },
      isCodex ? 'Redeem from the Codex app when a window runs out.'
        : 'Redeem on claude.ai when this account is out. TeamClaude can also spend them automatically when every account is out (autoRedeemResets, off by default).'),
  );
}

// ---------- main ----------
export function renderDetails(root, ctx) {
  const { account: a, status, rank, current, onClose, actions } = ctx;
  const prevScroll = root.querySelector('.d-body')?.scrollTop || 0;
  root.replaceChildren();
  if (!a) { root.hidden = true; return; }
  root.hidden = false;

  const q = a.quota || {};
  const u = a.usage || {};
  const T = typeof status.switchThreshold === 'number' ? status.switchThreshold : status.switchThreshold?.default ?? 0.98;
  const act = status.lastChats?.byAccount?.[`${a.provider}:${a.name}`];
  const st = act?.stats;
  const hist = status.weeklyHistory?.[`${a.provider}:${a.name}`];

  // tokens (TeamClaude's running totals for this account)
  const tIn = u.totalInputTokens || 0, tOut = u.totalOutputTokens || 0, tCr = u.totalCacheReadTokens || 0, tCw = u.totalCacheCreationTokens || 0;
  const tAll = tIn + tOut + tCr + tCw;
  const promptSide = tIn + tCr + tCw;
  const hitRate = promptSide ? tCr / promptSide : null;

  // This account's average weekly burn (same basis as the forecast): usage so far
  // over the time since its weekly window opened, idle time included.
  const reset7 = parseTs(q.unified7dReset);
  const openedHrs = isNaN(reset7) ? NaN : (Date.now() - (reset7 - 7 * 24 * HOUR)) / HOUR;
  let weeklyExtra = null;
  if (q.unified7d != null && openedHrs >= 1) {
    const avg = q.unified7d / openedHrs;
    const hitsAt = avg > 0 ? Date.now() + ((T - q.unified7d) / avg) * HOUR : Infinity;
    weeklyExtra = `avg ${(avg * 100).toFixed(1)}%/h` +
      (hitsAt < reset7 ? ` · on its own, hits ${Math.round(T * 100)}% ${fmtWhen(hitsAt)}` : ' · lasts to reset on its own');
  }

  const scoped = Object.entries(q.scopedWeekly || {}).map(([fam, b]) => [fam[0].toUpperCase() + fam.slice(1), b?.utilization, b?.resetAt]);
  if (!q.scopedWeekly?.fable && q.unified7dFable != null) scoped.push(['Fable', q.unified7dFable, q.unified7dFableReset]);
  if (!q.scopedWeekly?.sonnet && q.unified7dSonnet != null) scoped.push(['Sonnet', q.unified7dSonnet, q.unified7dSonnetReset]);

  const health = [];
  if (a.disabled) health.push(['Disabled', 'muted']);
  if (a.cordoned) health.push(['Cordoned', 'warn']);
  if (a.errorReason) health.push([a.errorReason, 'bad']);
  if (parseTs(a.rateLimitedUntil) > Date.now()) health.push([`Rate limited until ${fmtWhen(parseTs(a.rateLimitedUntil))}`, 'warn']);
  if (parseTs(a.pausedUntil) > Date.now()) health.push([`Paused until ${fmtWhen(parseTs(a.pausedUntil))}`, 'warn']);
  if (parseTs(a.credentialRejectedUntil) > Date.now()) health.push(['Login rejected — sign in again', 'bad']);
  if (!health.length) health.push(['Healthy', 'ok']);

  const models = st ? Object.entries(st.models).sort((x, y) => y[1] - x[1]) : [];

  const body = h('div', { class: 'd-body' },
    // Quota
    section('Quota',
      quotaRow('5-hour session', q.unified5h, q.unified5hReset),
      quotaRow('Weekly', q.unified7d, q.unified7dReset, weeklyExtra),
      scoped.map(([label, ut, rs]) => quotaRow(`${label} weekly`, ut, rs)),
    ),
    resetsSection(a, status),
    section('Weekly usage over time', sparkline(hist, T)),

    // Tokens
    section('Tokens',
      tiles([
        ['Total', fmtNum(tAll), 'all token types'],
        ['Output', fmtNum(tOut), 'written by Claude'],
        ['Cache hit rate', hitRate == null ? '—' : Math.round(hitRate * 100) + '%', 'of prompt tokens'],
      ]),
      kv([
        ['Cache reads', fmtNum(tCr), 'reused context, cheapest'],
        ['Cache writes', fmtNum(tCw)],
        ['Uncached input', fmtNum(tIn)],
        ['Requests', fmtNum(u.totalRequests || 0)],
        ['Last used', fmtAgo(u.lastUsed)],
      ]),
    ),

    // Activity from the log
    section(st ? `Activity since ${fmtWhen(st.since)}` : 'Activity',
      st ? [
        tiles([
          ['Requests', fmtNum(st.requests), st.errors ? `${st.errors} failed` : 'none failed'],
          ['Avg response', st.avgSec == null ? '—' : `${st.avgSec.toFixed(1)}s`, 'per request'],
          ['Cache misses', fmtNum(st.misses), 'full context resent'],
        ]),
        models.length ? h('div', { class: 'd-models' }, models.map(([m, c]) =>
          h('div', { class: 'd-model' },
            h('span', {}, modelName(m)),
            h('div', { class: 'bar' }, h('i', { style: `width:${(c / st.requests * 100).toFixed(1)}%` })),
            h('b', {}, `${Math.round(c / st.requests * 100)}%`),
          ))) : null,
        kv([['Live chats', `${a.sessions || 0} active`, `${a.knownSessions || 0} seen in the last hour`]]),
      ] : h('div', { class: 'd-note' }, 'No requests logged on this account yet.'),
    ),

    // Folders & chats
    act?.projects?.length ? section('Folders & chats',
      h('div', { class: 'd-folders' }, act.projects.map((p) =>
        h('div', { class: 'd-folder' },
          h('div', { class: 'd-ftop' }, h('b', {}, p.name), h('span', {}, `${p.requests} requests · ${fmtAgo(p.at)}`)),
          h('ul', {}, p.chats.map((c) => h('li', {},
            h('span', { class: 'ttl', title: c.title || '' }, c.title || `Session ${c.sid}`),
            h('span', { class: 'meta' }, `${c.requests} req · ${fmtAgo(c.at)}`)))),
        ))),
    ) : null,

    // Recent requests
    act?.recent?.length ? section('Recent requests',
      h('div', { class: 'd-table-wrap' }, h('table', { class: 'd-table' },
        h('thead', {}, h('tr', {}, ['Time', 'Chat', 'Model', 'Took', 'Cache read', 'Status'].map((x) => h('th', {}, x)))),
        h('tbody', {}, act.recent.map((r) => h('tr', {},
          h('td', { class: 'num' }, new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })),
          h('td', { class: 'ttl', title: [r.title, r.project].filter(Boolean).join(' · ') }, r.title || r.project || r.sid),
          h('td', {}, modelName(r.model) + (r.effort ? ` · ${r.effort}` : '')),
          h('td', { class: 'num' }, r.dur == null ? '—' : `${r.dur.toFixed(1)}s`),
          h('td', { class: 'num' }, r.cacheRead == null ? '—' : fmtNum(r.cacheRead) + (r.miss ? ' · miss' : '')),
          h('td', {}, h('span', { class: 'st ' + (r.status >= 400 ? 'bad' : 'ok') }, r.status)),
        ))),
      )),
    ) : null,

    // Account
    section('Account',
      kv([
        ['Status', h('span', { class: 'd-health' }, health.map(([t, c]) => h('span', { class: 'pill ' + c }, t)))],
        ['Organisation', a.orgName || '—'],
        ['Plan', a.type === 'oauth' ? 'Subscription (OAuth)' : a.type],
        ['Rotation', `#${rank} · priority ${a.priority ?? 0}`],
        ['Switches at', a.switchThreshold != null ? pct(typeof a.switchThreshold === 'number' ? a.switchThreshold : a.switchThreshold.default) : `${Math.round(T * 100)}% (fleet default)`],
        ['Paid extra usage', a.allowExtraUsage ? 'Allowed' : 'Off'],
        ['Token refreshed', a.lastRefreshAt ? fmtAgo(a.lastRefreshAt) : 'not yet this run'],
        a.routing ? ['Own proxy', 'yes'] : null,
      ]),
    ),
  );

  const panel = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'd-title' },
    h('header', { class: 'd-head' },
      h('div', { class: 'd-id' },
        h('div', { class: 'd-title', id: 'd-title' }, a.name),
        h('div', { class: 'd-sub' }, [a.provider === 'codex' ? 'Codex' : 'Claude', a.orgName, `#${rank} in rotation`].filter(Boolean).join(' · '),
          current ? h('span', { class: 'tag' }, ' · In use') : null),
      ),
      h('div', { class: 'd-actions' }, actions, h('button', { class: 'btn more d-close', 'aria-label': 'Close details', onclick: onClose }, '✕')),
    ),
    body,
  );
  root.append(h('div', { class: 'd-backdrop', onclick: onClose }), panel);
  body.scrollTop = prevScroll;
}
