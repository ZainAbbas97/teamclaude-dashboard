// Weekly run-out forecast for the Claude pool.
//
// Rate:  each account's weekly usage so far ÷ time since its weekly window opened
//        (reset − 7 days) — your real average, idle time included. Right after a
//        reset (< 12h of the new week) it falls back to the recorded samples.
// Model: spend goes to the top-priority account under the switch limit, then the
//        next, as rotation does; each account drops to 0 at its weekly reset.
// Views: Combined (mean of all accounts) or one account.

const HOUR = 3600e3, DAY = 24 * HOUR, WEEK = 7 * DAY;
const STEP = 10 * 60e3;
const SVGNS = 'http://www.w3.org/2000/svg';
const EPS = 1e-9;

const parseTs = (v) => (v == null ? NaN : typeof v === 'number' ? v : Date.parse(v));
function domainName(name) {
  const d = name.split('@')[1];
  if (!d) return name;
  const b = d.split('.')[0];
  return b[0].toUpperCase() + b.slice(1);
}

// ---------- model ----------
export function buildModel(status) {
  const now = Date.now();
  const T = typeof status.switchThreshold === 'number' ? status.switchThreshold : status.switchThreshold?.default ?? 0.98;
  const hist = status.weeklyHistory || {};
  const labels = status.labels || {};
  const accts = (status.accounts || [])
    .filter((a) => a.provider === 'anthropic' && !a.disabled)
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map((a) => {
      const series = (hist[`anthropic:${a.name}`] || []).slice();
      const u = a.quota?.unified7d;
      const resetAt = parseTs(a.quota?.unified7dReset);
      if (u != null) series.push([now, u, resetAt]);
      return { name: a.name, label: labels[a.name] || domainName(a.name), u: u ?? null, resetAt, series,
        fallbackRate: a.quota?.forecast?.unified7d?.ratePerHour ?? null };
    })
    .filter((a) => a.u != null);
  if (!accts.length) return null;
  const n = accts.length;

  // Burn rate per account.
  for (const a of accts) {
    const elapsed = isNaN(a.resetAt) ? NaN : (now - (a.resetAt - WEEK)) / HOUR;
    if (elapsed >= 12) { a.rate = a.u / elapsed; continue; }
    const s = a.series;
    let inc = 0;
    for (let i = 1; i < s.length; i++) { const d = s[i][1] - s[i - 1][1]; if (d > 0) inc += d; }
    const span = s.length > 1 ? (s[s.length - 1][0] - s[0][0]) / HOUR : 0;
    a.rate = span >= 6 ? inc / span : (a.fallbackRate ?? 0);
  }
  const rate = accts.reduce((sum, a) => sum + a.rate, 0);

  // Recorded: merge sample times, carrying each account's last reading forward.
  const times = [...new Set(accts.flatMap((a) => a.series.map((r) => r[0])))].sort((x, y) => x - y);
  const actual = [];
  const last = accts.map(() => null), idx = accts.map(() => 0);
  for (const t of times) {
    accts.forEach((a, i) => { while (idx[i] < a.series.length && a.series[idx[i]][0] <= t) last[i] = a.series[idx[i]++][1]; });
    if (last.some((v) => v == null)) continue;
    actual.push({ t, per: last.slice(), kind: 'actual' });
  }

  // Projection.
  const u = accts.map((a) => a.u);
  const resets = accts.map((a) => { let r = isNaN(a.resetAt) ? now + WEEK : a.resetAt; while (r <= now) r += WEEK; return r; });
  const projected = [{ t: now, per: u.slice(), kind: 'projected' }];
  const events = []; // { t, i, type: 'out' | 'reset' }
  const isOut = u.map((v) => v >= T - EPS);
  isOut.forEach((o, i) => { if (o) events.push({ t: now, i, type: 'out' }); });
  let runout = isOut.every(Boolean) ? now : null, backAt = null;
  for (let t = now + STEP; t <= now + 9 * DAY; t += STEP) {
    accts.forEach((a, i) => {
      if (t >= resets[i]) {
        u[i] = 0; isOut[i] = false;
        events.push({ t: resets[i], i, type: 'reset' });
        if (runout != null && backAt == null) backAt = resets[i];
        resets[i] += WEEK;
      }
    });
    let spend = rate * (STEP / HOUR);
    for (let i = 0; i < n && spend > EPS; i++) {
      const take = Math.min(Math.max(0, T - u[i]), spend);
      u[i] += take; spend -= take;
    }
    u.forEach((v, i) => { if (!isOut[i] && v >= T - EPS && rate > 0) { isOut[i] = true; events.push({ t, i, type: 'out' }); } });
    if (runout == null && isOut.every(Boolean)) runout = t;
    projected.push({ t, per: u.slice(), kind: 'projected' });
  }

  return { now, T, n, accts, rate, actual, projected, events, runout, backAt,
    usedNow: accts.reduce((sum, a) => sum + a.u, 0) / n };
}

// ---------- formatting ----------
function fmtWhen(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return `today ${time}`;
  if (d.toDateString() === new Date(Date.now() + DAY).toDateString()) return `tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
function fmtShort(ts) {
  const d = new Date(ts);
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${d.toLocaleTimeString([], { hour: 'numeric' })}`;
}
function fmtIn(ms) {
  const hh = Math.floor(ms / HOUR), d = Math.floor(hh / 24), m = Math.floor((ms % HOUR) / 60e3);
  if (d) return `${d}d ${hh % 24}h`;
  if (hh) return `${hh}h ${m}m`;
  return `${m}m`;
}
const pct = (v) => `${Math.round(v * 100)}%`;

// ---------- DOM helpers ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
function s(tag, attrs = {}, text) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}

// ---------- render ----------
export function renderForecast(root, model, { view, onView }) {
  root.replaceChildren();
  if (!model) { root.hidden = true; return; }
  root.hidden = false;

  const vi = model.accts.findIndex((a) => a.name === view); // -1 = combined
  const acct = vi >= 0 ? model.accts[vi] : null;
  const firstEvent = (i, type) => model.events.find((e) => e.i === i && e.type === type);

  let big, sub;
  if (model.rate <= 0) {
    big = 'No weekly usage yet';
    sub = 'The forecast starts once chats run through TeamClaude.';
  } else if (!acct) {
    big = model.runout ? `Runs out ${fmtWhen(model.runout)}` : 'Lasts the week';
    sub = `${pct(model.usedNow)} used` +
      (model.runout ? ` · in ${fmtIn(model.runout - model.now)} at your usual pace` + (model.backAt ? ` · back ${fmtWhen(model.backAt)}` : '')
        : ' · resets before you run out');
  } else {
    const out = firstEvent(vi, 'out'), reset = firstEvent(vi, 'reset');
    const outFirst = out && (!reset || out.t <= reset.t);
    big = outFirst ? `${acct.label} runs out ${fmtWhen(out.t)}` : `${acct.label} lasts the week`;
    sub = `${pct(acct.u)} used` + (reset ? ` · resets ${fmtWhen(reset.t)}` : '');
  }

  const views = [{ id: 'all', label: 'Combined' }, ...model.accts.map((a) => ({ id: a.name, label: a.label }))];
  root.append(
    h('div', { class: 'fc-top' },
      h('h2', {}, 'Weekly forecast'),
      h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Forecast for' },
        views.map((v) => h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(v.id === (acct ? acct.name : 'all')),
          onclick: () => onView(v.id),
        }, v.label))),
    ),
    h('div', { class: 'fc-big' }, big),
    h('div', { class: 'fc-sub' }, sub),
  );
  const chartBox = h('div', { class: 'fc-chart' });
  root.append(chartBox);
  drawChart(chartBox, model, vi);
}

function drawChart(box, model, vi) {
  const W = Math.max(320, Math.round(box.clientWidth || box.parentElement.clientWidth || 800));
  const H = 210;
  const m = { l: 40, r: 16, t: 22, b: 26 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const val = (p) => (vi >= 0 ? p.per[vi] : p.per.reduce((sum, v) => sum + v, 0) / model.n);

  // Range: through the moment quota comes back (combined) or the account's reset.
  let end;
  if (vi >= 0) {
    const r = model.events.find((e) => e.i === vi && e.type === 'reset');
    end = r ? r.t + 10 * HOUR : model.now + WEEK;
  } else if (model.runout) end = model.backAt ? model.backAt + 10 * HOUR : model.runout + 12 * HOUR;
  else {
    const r = model.events.find((e) => e.type === 'reset');
    end = r ? r.t + 10 * HOUR : model.now + WEEK;
  }
  end = Math.min(end, model.now + 8 * DAY);
  const x0 = Math.min(model.actual.length ? model.actual[0].t : model.now, model.now - HOUR);
  const X = (t) => m.l + ((t - x0) / (end - x0)) * iw;
  const Y = (v) => m.t + ih - Math.max(0, Math.min(1, v)) * ih;

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', class: 'fc-svg',
    'aria-label': 'Weekly usage forecast' });
  box.replaceChildren(svg);

  for (const v of [0, 0.5, 1]) {
    svg.append(s('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'grid' }));
    svg.append(s('text', { x: m.l - 8, y: Y(v) + 4, class: 'tick', 'text-anchor': 'end' }, pct(v)));
  }
  const first = new Date(x0); first.setHours(24, 0, 0, 0);
  for (let t = first.getTime(); t < end; t += DAY) {
    svg.append(s('text', { x: X(t), y: H - 6, class: 'tick', 'text-anchor': 'middle' }, new Date(t).toLocaleDateString([], { weekday: 'short' })));
  }

  const proj = model.projected.filter((p) => p.t <= end);
  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(val(p)).toFixed(1)}`).join(' ');
  if (model.actual.length > 1) svg.append(s('path', { d: path(model.actual), class: 'line' }));
  if (proj.length > 1) svg.append(s('path', { d: path(proj), class: 'line proj' }));

  // Markers: where accounts run out (filled) and where they reset (hollow).
  const valAt = (t, after) => {
    // value at time t; for resets use the first point after the drop
    const p = after ? proj.find((q) => q.t >= t + 1) : [...proj].reverse().find((q) => q.t <= t);
    return p ? val(p) : 0;
  };
  const marks = model.events
    .filter((e) => e.t <= end && (vi < 0 || e.i === vi))
    .filter((e) => !(e.type === 'out' && e.t === model.now && vi < 0 && model.events.filter((x) => x.type === 'out' && x.t === model.now).length < model.n));
  const placed = [];
  const place = (x, y, w, dir) => {
    // nudge a label vertically until it doesn't overlap one already placed
    let yy = y;
    for (let k = 0; k < 4; k++) {
      if (!placed.some((b) => Math.abs(b.x - x) < (b.w + w) / 2 + 6 && Math.abs(b.y - yy) < 14)) break;
      yy += dir * 14;
    }
    placed.push({ x, y: yy, w });
    return yy;
  };
  for (const e of marks) {
    const name = model.accts[e.i].label;
    const isReset = e.type === 'reset';
    const x = X(e.t), y = Y(valAt(e.t, isReset));
    const allOut = !isReset && vi < 0 && model.runout === e.t;
    const text = isReset ? `${name} resets · ${fmtShort(e.t)}` : `${allOut ? 'All out' : `${name} out`} · ${fmtShort(e.t)}`;
    const w = text.length * 6.2;
    let anchor, tx, ty;
    if (isReset) {
      // resets: label to the left of the dot, on the dot's line
      anchor = 'end'; tx = x - 10;
      ty = place(tx - w / 2, y + 4, w, -1);
    } else {
      // run-outs: label above the dot
      anchor = x + w / 2 > W - m.r ? 'end' : x - w / 2 < m.l ? 'start' : 'middle';
      tx = x;
      ty = place(anchor === 'end' ? x - w / 2 : anchor === 'start' ? x + w / 2 : x, y - 12, w, -1);
    }
    svg.append(s('circle', { cx: x, cy: y, r: 6.5, class: 'ring' }));
    svg.append(s('circle', { cx: x, cy: y, r: 4, class: isReset ? 'mk-reset' : 'mk-out' }));
    svg.append(s('text', { x: tx, y: ty, class: 'mk-label', 'text-anchor': anchor }, text));
  }

  // Hover / focus: crosshair snaps to the nearest point.
  const pts = [...model.actual, ...proj.slice(1)];
  const cross = s('line', { y1: m.t, y2: m.t + ih, class: 'cross', visibility: 'hidden' });
  const dot = s('circle', { r: 4.5, class: 'hover-dot', visibility: 'hidden' });
  svg.append(cross, dot);
  const tip = h('div', { class: 'fc-tip', hidden: true });
  box.append(tip);
  let cur = -1;
  const show = (i) => {
    if (i < 0 || i >= pts.length) return;
    cur = i;
    const p = pts[i], x = X(p.t), y = Y(val(p));
    cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('visibility', 'visible');
    tip.replaceChildren(
      h('div', { class: 'tv' }, pct(val(p)), h('span', {}, vi >= 0 ? ` ${model.accts[vi].label}` : ' combined')),
      h('div', { class: 'tt' }, `${fmtWhen(p.t)} · ${p.kind === 'actual' ? 'recorded' : 'projected'}`),
      vi < 0 ? model.accts.map((a, j) => h('div', { class: 'tr' }, h('span', {}, a.label), h('b', {}, pct(p.per[j])))) : null,
    );
    tip.hidden = false;
    const bw = box.clientWidth, tw = tip.offsetWidth;
    const left = (x / W) * bw;
    tip.style.left = `${Math.min(Math.max(8, left + 12 + tw > bw ? left - tw - 12 : left + 12), bw - tw - 8)}px`;
    tip.style.top = `${Math.max(0, (y / H) * box.clientHeight - 40)}px`;
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; cur = -1; };
  const nearest = (clientX) => {
    const r = svg.getBoundingClientRect();
    const t = x0 + (((clientX - r.left) / r.width) * W - m.l) / iw * (end - x0);
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].t - t) < Math.abs(pts[best].t - t)) best = i;
    return best;
  };
  svg.addEventListener('pointermove', (e) => show(nearest(e.clientX)));
  svg.addEventListener('pointerleave', hide);
  svg.setAttribute('tabindex', '0');
  svg.addEventListener('focus', () => show(pts.findIndex((p) => p.t >= model.now)));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    const step = Math.max(1, Math.round(pts.length / 60));
    if (e.key === 'ArrowRight') { e.preventDefault(); show(Math.min(pts.length - 1, cur + step)); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(Math.max(0, cur - step)); }
  });
}
