// TeamClaude Dashboard — zero-dependency local server.
//  - serves ./public
//  - proxies /teamclaude/* to the TeamClaude proxy (same-origin POSTs only)
//  - /events (SSE): pushes live status every POLL_MS, and a "reload" event
//    whenever a file in ./public changes (hot reload)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4567);
const HOST = '127.0.0.1';
const UPSTREAM = new URL(process.env.TEAMCLAUDE_URL || 'http://127.0.0.1:3456');
const POLL_MS = Number(process.env.POLL_MS || 2000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

// ---------- upstream ----------
function upstream(method, urlPath, body) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: UPSTREAM.hostname,
        port: UPSTREAM.port,
        path: urlPath,
        method,
        headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
        timeout: 8000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ status: 502, body: JSON.stringify({ ok: false, error: 'TeamClaude unreachable: ' + err.message }) }));
    if (body) req.write(body);
    req.end();
  });
}

// ---------- last chat per account ----------
// TeamClaude's activity log (--activity-log) has one line per request:
//   "15:24:13  11ffe7 POST /v1/messages?beta=true (model) → admin@x.com (200, 1.2s)"
// The 6 hex chars are the start of the Claude Code session id. Titles come from
// the Claude desktop app's session files (what the sidebar shows).
const HOME = process.env.HOME || '';
const ACTIVITY_LOG = process.env.TEAMCLAUDE_ACTIVITY_LOG || path.join(HOME, 'Library/Logs/teamclaude-activity.log');
const DESKTOP_SESSIONS = path.join(HOME, 'Library/Application Support/Claude/claude-code-sessions');
const PROJECTS = path.join(HOME, '.claude/projects');
const LINE_RE = /^(\d\d):(\d\d):(\d\d)\s+(?:\[[^\]]*\]\s+)?([0-9a-f]{6}) [A-Z]+ (\S+).* → (\S+?)(?: \[pin\])? \((\d{3})/;

let titles = new Map(); // full session id -> { title, project }
let titlesAt = 0;

function loadTitles() {
  if (Date.now() - titlesAt < 30000) return;
  titlesAt = Date.now();
  const next = new Map();
  const best = new Map();
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 2) walk(p, depth + 1);
      else if (e.isFile() && e.name.startsWith('local_') && e.name.endsWith('.json')) {
        try {
          const o = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (!o.cliSessionId || !o.title) continue;
          const at = o.lastActivityAt || 0;
          if ((best.get(o.cliSessionId) || -1) >= at) continue;
          best.set(o.cliSessionId, at);
          next.set(o.cliSessionId, { title: o.title, project: o.cwd ? path.basename(o.cwd) : null });
        } catch { /* skip unreadable */ }
      }
    }
  };
  walk(DESKTOP_SESSIONS, 0);
  // Terminal sessions have a transcript but no desktop title: fall back to the project folder.
  try {
    for (const dir of fs.readdirSync(PROJECTS)) {
      let files = [];
      try { files = fs.readdirSync(path.join(PROJECTS, dir)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const id = f.slice(0, -6);
        if (!next.has(id)) next.set(id, { title: null, project: dir.split('-').filter(Boolean).pop() || null });
      }
    }
  } catch { /* no projects dir */ }
  titles = next;
}

function resolveTitle(prefix) {
  for (const [id, info] of titles) if (id.startsWith(prefix)) return info;
  return null;
}

function readTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size, mtimeMs } = fs.fstatSync(fd);
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return { text: buf.toString('utf8'), mtimeMs };
  } catch { return null; } finally { if (fd != null) fs.closeSync(fd); }
}

// "301k" -> 301000, "1.2M" -> 1200000, "4" -> 4
function kNum(v) {
  if (v == null) return 0;
  const m = /^([\d.]+)([kKmM]?)$/.exec(v);
  if (!m) return 0;
  return Math.round(parseFloat(m[1]) * (m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1));
}

//  HH:MM:SS  [client ]sid METHOD path (model·effort) → account [pin] (status, 1.2s) cache r301k w1k in4 [MISS]
const REQ_RE = /^(\d\d):(\d\d):(\d\d)\s+(?:\[[^\]]*\]\s+)?([0-9a-f]{6}) [A-Z]+ (\S+)(?: \(([^)]*)\))? → (\S+?)(?: \[pin\])? \((\d{3}), ([\d.?]+)s\)(?: cache r(\S+) w(\S+) in(\S+))?( MISS)?/;
const RECENT_PER_ACCOUNT = 30;

function lastChats() {
  const tail = readTail(ACTIVITY_LOG, 1024 * 1024);
  if (!tail) return { available: false, byAccount: {} };
  loadTitles();

  // Lines carry only a time of day. Walk backwards from the newest line and step
  // back a day whenever the clock goes forward (we crossed midnight).
  const parsed = [];
  for (const line of tail.text.split('\n')) {
    const m = REQ_RE.exec(line);
    if (m) parsed.push(m);
  }
  const now = Date.now();
  let day = new Date(); day.setHours(0, 0, 0, 0);
  let dayStart = day.getTime();
  let prevSec = Infinity;
  const entries = [];
  for (let i = parsed.length - 1; i >= 0; i--) {
    const m = parsed[i];
    const sec = +m[1] * 3600 + +m[2] * 60 + +m[3];
    if (i === parsed.length - 1 && dayStart + sec * 1000 > now + 60000) dayStart -= 86400000;
    else if (sec > prevSec + 60) dayStart -= 86400000;
    prevSec = sec;
    entries.push({ m, at: dayStart + sec * 1000 });
  }
  entries.reverse();

  const byAccount = {};
  for (const { m, at } of entries) {
    const [, , , , sid, reqPath, modelRaw, account, status, dur, cr, cw, cin, miss] = m;
    const isCodex = reqPath.includes('/backend-api/codex');
    const isMessages = /^\/v1\/messages(\?|$)/.test(reqPath);
    if (!isCodex && !isMessages) continue; // skip count_tokens, metrics, etc.
    const provider = isCodex ? 'codex' : 'anthropic';
    const key = `${provider}:${account}`;
    const info = resolveTitle(sid);
    const project = info?.project || 'Unknown folder';
    const title = info?.title || null;
    const [model, effort] = (modelRaw || '').split('·');

    const acct = (byAccount[key] ||= {
      at: 0, sid: null, title: null, project: null, projects: {}, recent: [],
      stats: { since: at, requests: 0, errors: 0, durSum: 0, durN: 0, cacheRead: 0, cacheWrite: 0, input: 0, withUsage: 0, misses: 0, models: {} },
    });
    const p = (acct.projects[project] ||= { at: 0, requests: 0, chats: {} });
    p.at = Math.max(p.at, at);
    p.requests++;
    const c = (p.chats[sid] ||= { at: 0, title, requests: 0 });
    c.at = Math.max(c.at, at); c.requests++;
    if (at >= acct.at) Object.assign(acct, { at, sid, title, project });

    const st = acct.stats;
    st.requests++;
    if (+status >= 400) st.errors++;
    if (dur !== '?') { st.durSum += +dur; st.durN++; }
    if (cr != null) { st.cacheRead += kNum(cr); st.cacheWrite += kNum(cw); st.input += kNum(cin); st.withUsage++; }
    if (miss) st.misses++;
    if (model) st.models[model] = (st.models[model] || 0) + 1;

    acct.recent.push({
      at, sid, title, project, model: model || null, effort: effort || null, status: +status, dur: dur === '?' ? null : +dur,
      cacheRead: cr != null ? kNum(cr) : null, cacheWrite: cw != null ? kNum(cw) : null, input: cin != null ? kNum(cin) : null, miss: !!miss,
    });
    if (acct.recent.length > RECENT_PER_ACCOUNT) acct.recent.shift();
  }

  // Flatten: latest folder first, chats latest first; newest requests first.
  for (const acct of Object.values(byAccount)) {
    acct.projects = Object.entries(acct.projects)
      .map(([name, p]) => ({
        name, at: p.at, requests: p.requests,
        chats: Object.entries(p.chats).map(([sid, c]) => ({ sid, ...c })).sort((a, b) => b.at - a.at),
      }))
      .sort((a, b) => b.at - a.at);
    acct.recent.reverse();
    const st = acct.stats;
    st.avgSec = st.durN ? st.durSum / st.durN : null;
    delete st.durSum; delete st.durN;
  }
  return { available: true, byAccount };
}

// ---------- weekly usage history ----------
// TeamClaude samples each account every 15 min into teamclaude.quota-series.json:
//   { accounts: { <accountId>: [[t, weekly, weeklyResetAt, fiveHour, fiveHourResetAt], ...] } }
// Account ids map to names via teamclaude.json.
const CONFIG_DIR = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
const SERIES_FILE = path.join(CONFIG_DIR, 'teamclaude.quota-series.json');
const CONFIG_FILE = path.join(CONFIG_DIR, 'teamclaude.json');

// Short display names for accounts (edit labels.json: { "email": "Name" }).
function readLabels() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'labels.json'), 'utf8')); } catch { return {}; }
}

function weeklyHistory() {
  try {
    const series = JSON.parse(fs.readFileSync(SERIES_FILE, 'utf8'));
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const out = {};
    for (const a of config.accounts || []) {
      const rows = series.accounts?.[a.id];
      if (!rows) continue;
      const provider = a.provider === 'codex' ? 'codex' : 'anthropic';
      out[`${provider}:${a.name}`] = rows
        .filter((r) => r[1] != null)
        .map((r) => [r[0], r[1], r[2]]); // [t, weekly 0-1, weeklyResetAt]
    }
    return out;
  } catch { return {}; }
}

// ---------- live status via SSE ----------
const clients = new Set();
let lastStatus = null;

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${data}\n\n`;
  for (const res of clients) res.write(msg);
}

async function poll() {
  const r = await upstream('GET', '/teamclaude/status');
  // SSE data must be a single line, so re-serialize the (pretty-printed) JSON.
  let payload;
  try { payload = r.status === 200 ? JSON.stringify({ ...JSON.parse(r.body), lastChats: lastChats(), weeklyHistory: weeklyHistory(), labels: readLabels() }) : null; } catch { payload = null; }
  if (!payload) payload = JSON.stringify({ offline: true, error: safeError(r) });
  lastStatus = payload;
  if (clients.size) broadcast('status', payload);
}

function safeError(r) {
  try { return JSON.parse(r.body).error || `HTTP ${r.status}`; } catch { return `HTTP ${r.status}`; }
}

setInterval(poll, POLL_MS);
poll();

// ---------- hot reload ----------
let reloadTimer = null;
fs.watch(PUBLIC, { recursive: true }, () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => broadcast('reload', '{}'), 80);
});

// ---------- same-origin guard (mirrors TeamClaude's own CSRF gate) ----------
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://${req.headers.host}`;
}

const ALLOWED_POST = new Set([
  '/teamclaude/switch',
  '/teamclaude/priority',
  '/teamclaude/disable',
  '/teamclaude/account-cordon',
  '/teamclaude/reload',
  '/teamclaude/probe',
  '/teamclaude/threshold',
]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- http ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`retry: 1500\n\n`);
    if (lastStatus) res.write(`event: status\ndata: ${lastStatus}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (url.pathname.startsWith('/teamclaude/')) {
    if (req.method === 'POST') {
      if (!ALLOWED_POST.has(url.pathname)) return send(res, 404, { ok: false, error: 'not allowed' });
      if (!sameOrigin(req)) return send(res, 403, { ok: false, error: 'cross-origin request refused' });
      let body = '';
      try { body = await readBody(req); } catch (e) { return send(res, 413, { ok: false, error: e.message }); }
      const r = await upstream('POST', url.pathname, body || undefined);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.body);
      setTimeout(poll, 150);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/teamclaude/status') {
      const r = await upstream('GET', url.pathname);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      return res.end(r.body);
    }
    return send(res, 405, { ok: false, error: 'method not allowed' });
  }

  // static
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
});

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, HOST, () => {
  console.log(`TeamClaude Dashboard → http://localhost:${PORT}`);
  console.log(`Reading TeamClaude at ${UPSTREAM.origin} every ${POLL_MS}ms · hot reload on ./public`);
  // OPEN_BROWSER=1: open the page once the server is up — but only if no tab is
  // already showing it (an open tab reconnects within ~1.5s after a restart).
  if (process.env.OPEN_BROWSER === '1') {
    setTimeout(() => {
      if (clients.size) return;
      execFile('open', [`http://localhost:${PORT}`], () => {});
    }, 4000);
  }
});
