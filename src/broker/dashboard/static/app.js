/* XBus communication console UI — a pure CLIENT of the authenticated dashboard API
 * (ADR 0015/0018/0020/0021). Contains NO secrets and NO session data (inert asset). It:
 *   1. reads the one-time nonce from location.hash, immediately strips the fragment
 *      (history.replaceState) so a reload/bookmark/back cannot replay it,
 *   2. exchanges it at POST /auth/exchange for a short-lived tab token,
 *   3. holds the token in sessionStorage ONLY (never persistent storage, a cookie, or the URL),
 *   4. sends the token as Authorization: Bearer on every /api/* request + the stream.
 * Beta.6: adds the operator communication console — select a routable session, open/continue
 * a thread, send as local-operator, and watch the ordered timeline + unread live. Every
 * visible state comes from the authenticated API + SQLite; the browser never sets a sender.
 * No inline handlers (strict CSP: script-src 'self'); everything wires up here. */
'use strict';

const TOKEN_KEY = 'xbus.tabToken';

/* ── shared auth + fetch ── */
function setStatus(msg, cls) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status' + (cls ? ' ' + cls : '');
}
function takeNonceFromFragment() {
  const hash = location.hash || '';
  const m = /[#&]n=([^&]+)/.exec(hash);
  const nonce = m ? decodeURIComponent(m[1]) : null;
  if (hash) history.replaceState(null, '', location.pathname + location.search);
  return nonce;
}
async function exchangeNonce(nonce) {
  const res = await fetch('/auth/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce }) });
  if (!res.ok) return null;
  const { token } = await res.json();
  return token || null;
}
function authHeaders(extra) {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const h = token ? { Authorization: 'Bearer ' + token } : {};
  return extra ? Object.assign(h, extra) : h;
}
async function api(path) {
  const res = await fetch(path, { headers: authHeaders() });
  if (res.status === 401) { onExpired(); throw new Error('unauthorized'); }
  if (!res.ok) throw new Error('request failed: ' + res.status);
  return res.json();
}
/** Authenticated write (POST JSON). Returns {ok, status, body}. Never throws on HTTP error. */
async function apiPost(path, obj) {
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(obj) });
  } catch (e) { return { ok: false, status: 0, body: { error: 'network', message: String(e && e.message || e) } }; }
  if (res.status === 401) { onExpired(); return { ok: false, status: 401, body: { error: 'unauthorized' } }; }
  let body = null; try { body = await res.json(); } catch { /* no body */ }
  return { ok: res.ok, status: res.status, body: body || {} };
}
function onExpired() {
  sessionStorage.removeItem(TOKEN_KEY);
  setStatus('Session expired — reopen from XBus (run `xbus dashboard`).', 'err');
}

/* ── small DOM helpers ── */
function text(s) { return document.createTextNode(s == null ? '' : String(s)); }
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.appendChild(text(txt)); return e; }
function cell(row, value) { const td = document.createElement('td'); td.appendChild(text(value)); row.appendChild(td); return td; }
function hhmmss(iso) { return iso ? String(iso).slice(11, 19) : ''; }

/* ── sessions / ledger / audit (unchanged behavior) ── */
function msgCell(m, who) { if (!m) return '—'; return `${m[who]} · ${m.state} · ${m.at.slice(11, 19)}`; }
function renderSessions(sessions) {
  window.__sessions = sessions; // cache for the console selector
  const body = document.getElementById('sessions-body');
  body.replaceChildren();
  if (!sessions.length) { const r = body.insertRow(); const c = cell(r, 'No sessions yet.'); c.colSpan = 7; }
  else for (const s of sessions) {
    const r = document.createElement('tr');
    const label = document.createElement('td');
    const badge = el('span', 'badge badge-' + s.label); badge.appendChild(text(s.name || s.sessionId.slice(0, 8)));
    label.appendChild(badge); r.appendChild(label);
    cell(r, s.label); cell(r, `${s.connection}/${s.readiness}`);
    cell(r, msgCell(s.lastSent, 'to')); cell(r, msgCell(s.lastReceived, 'from'));
    const d = s.delivery || { queued: 0, delivered: 0, acknowledged: 0, replied: 0, failed: 0 };
    cell(r, `${d.queued}/${d.delivered}/${d.acknowledged}/${d.replied}/${d.failed}`);
    cell(r, s.project); body.appendChild(r);
  }
  renderSessionSelect(sessions);
}
function renderAudit(a) {
  const elx = document.getElementById('audit');
  if (!a) { elx.textContent = ''; elx.className = 'audit'; return; }
  if (a.ok) { elx.className = 'audit audit-ok'; elx.textContent = `Audit ledger: chain OK (${a.checked} events verified${a.lastVerifiedAt ? ', last broker verify ' + a.lastVerifiedAt.slice(0, 19) : ''}).`; }
  else { elx.className = 'audit audit-broken'; elx.textContent = `Audit ledger: CHAIN BROKEN at seq ${a.firstBreakSeq}. Historical audit integrity is compromised — routing/delivery are unaffected, but investigate the ledger.`; }
}
function renderLedger(events) {
  const body = document.getElementById('ledger-body');
  body.replaceChildren();
  if (!events.length) { const r = body.insertRow(); const c = cell(r, 'No events yet.'); c.colSpan = 5; return; }
  for (const e of events) {
    const r = document.createElement('tr');
    cell(r, e.seq); cell(r, e.eventType); cell(r, e.actor);
    cell(r, e.subject && (e.subject.threadId || e.subject.sessionId) ? String(e.subject.threadId || e.subject.sessionId).slice(0, 8) : '—');
    cell(r, e.createdAt); body.appendChild(r);
  }
}
function renderBanner(banner) {
  const elx = document.getElementById('banner');
  if (banner && banner.possibleUnmanaged > 0) { elx.hidden = false; elx.textContent = banner.possibleUnmanaged + ' Claude session(s) may be running that started before XBus and aren’t managed yet — resume or restart them so XBus registers them at SessionStart.'; }
  else { elx.hidden = true; }
}

/* ── console state ── */
const consoleState = { selectedThreadId: null, threads: [], routableSessions: [] };

/** Populate the "new thread to" selector with ROUTABLE Claude sessions (never local-operator). */
function renderSessionSelect(sessions) {
  const routable = (sessions || []).filter((s) => s.routable && s.sessionId !== 'local-operator');
  consoleState.routableSessions = routable;
  const sel = document.getElementById('session-select');
  const prev = sel.value;
  sel.replaceChildren();
  if (!routable.length) {
    const o = el('option', null, 'No routable sessions'); o.value = ''; sel.appendChild(o);
    document.getElementById('new-thread-btn').disabled = true;
    return;
  }
  for (const s of routable) {
    const o = document.createElement('option'); o.value = s.sessionId;
    o.appendChild(text((s.name || s.sessionId.slice(0, 8)) + ' · ' + s.project)); sel.appendChild(o);
  }
  if (prev && routable.some((s) => s.sessionId === prev)) sel.value = prev;
  document.getElementById('new-thread-btn').disabled = false;
}

function renderThreadList(threads) {
  consoleState.threads = threads || [];
  const list = document.getElementById('thread-list');
  list.replaceChildren();
  if (!consoleState.threads.length) {
    list.appendChild(el('li', 'empty', 'No threads yet. Select a session and start one.'));
    return;
  }
  for (const t of consoleState.threads) {
    const li = el('li', t.threadId === consoleState.selectedThreadId ? 'selected' : null);
    li.dataset.threadId = t.threadId;
    const main = el('div', 'thread-item-main');
    main.appendChild(el('span', 'thread-item-peer', t.peerName || (t.peerSessionId ? t.peerSessionId.slice(0, 8) : 'unknown')));
    main.appendChild(el('span', 'thread-item-sub', t.subject || ('turn ' + t.lastThreadSequence + ' · ' + t.lastTurnState)));
    li.appendChild(main);
    if (t.unreadCount > 0) li.appendChild(el('span', 'unread', String(t.unreadCount)));
    li.addEventListener('click', () => selectThread(t.threadId));
    list.appendChild(li);
  }
}

async function selectThread(threadId) {
  consoleState.selectedThreadId = threadId;
  renderThreadList(consoleState.threads); // reflect selection highlight
  await loadThread(threadId);
}

async function loadThread(threadId) {
  let thread;
  try { thread = await api('/api/thread/' + encodeURIComponent(threadId)); }
  catch (e) { if (String(e.message) !== 'unauthorized') renderTimelineError('Could not load the thread: ' + e.message); return; }
  renderTimeline(thread);
  // Mark read up to the latest sequence (best-effort; advances the operator's cursor).
  if (thread && thread.lastThreadSequence > thread.lastReadThreadSequence) {
    void apiPost('/api/thread/' + encodeURIComponent(threadId) + '/read', { upToSequence: thread.lastThreadSequence });
  }
}

function renderTimelineError(msg) {
  const tl = document.getElementById('timeline');
  tl.replaceChildren(); tl.appendChild(el('p', 'empty', msg));
}

function renderTimeline(thread) {
  const header = document.getElementById('thread-header');
  const peerEl = document.getElementById('thread-peer');
  const subjEl = document.getElementById('thread-subject');
  const stateEl = document.getElementById('thread-state');
  const tl = document.getElementById('timeline');
  const composer = document.getElementById('composer');
  if (!thread) { header.hidden = true; composer.hidden = true; renderTimelineError('Select a thread to see its timeline, or start a new one.'); return; }
  header.hidden = false;
  peerEl.textContent = thread.peerName || 'unknown';
  subjEl.textContent = thread.subject ? '· ' + thread.subject : '';
  stateEl.textContent = thread.state === 'closed' ? 'closed' : (thread.turns.length + ' turn(s)');

  tl.replaceChildren();
  if (!thread.turns.length) { tl.appendChild(el('p', 'empty', 'No turns yet.')); }
  for (const turn of thread.turns) {
    const div = el('div', 'turn ' + (turn.authorType === 'operator' ? 'operator' : 'claude'));
    const meta = el('div', 'turn-meta');
    meta.appendChild(el('span', null, turn.senderName));
    meta.appendChild(el('span', null, '#' + turn.threadSequence));
    meta.appendChild(el('span', null, hhmmss(turn.createdAt)));
    div.appendChild(meta);
    div.appendChild(el('div', 'turn-body', turn.text));
    const st = el('div', 'turn-state state-' + turn.deliveryState);
    let label = turn.deliveryState;
    if (turn.ackStatus === 'rejected') label = 'rejected by recipient';
    else if (turn.deliveryState === 'queued' && turn.authorType === 'operator') label = 'queued — waiting for recipient checkpoint';
    else if (turn.deliveryState === 'failed') label = 'failed' + (turn.failureCategory ? ' (' + turn.failureCategory + ')' : '');
    st.appendChild(text(label));
    // Safe retry for a FAILED operator turn: re-send with a fresh idempotency key in the thread.
    if (turn.deliveryState === 'failed' && turn.authorType === 'operator') {
      const btn = el('button', 'secondary retry-btn', 'Retry'); btn.type = 'button';
      btn.addEventListener('click', () => retryTurn(thread, turn, btn));
      st.appendChild(btn);
    }
    div.appendChild(st);
    tl.appendChild(div);
  }
  tl.scrollTop = tl.scrollHeight;

  // Composer: enabled when the thread is open. Disconnected recipient → an informational note.
  composer.hidden = false;
  document.getElementById('send-btn').disabled = thread.state === 'closed';
  const peerSession = (consoleState.routableSessions || []).find((s) => s.sessionId === thread.peerSessionId);
  let note = document.getElementById('disc-note');
  if (!peerSession) {
    if (!note) { note = el('p', 'disconnected-note'); note.id = 'disc-note'; composer.appendChild(note); }
    note.textContent = 'Recipient is not currently routable — messages will queue until it reaches a checkpoint.';
    note.hidden = false;
  } else if (note) { note.hidden = true; }
}

/** A stable-ish idempotency key per compose action (no crypto dependency in the inert asset). */
function newIdempotencyKey() {
  return 'op-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
}

function composerError(msg) {
  const e = document.getElementById('composer-error');
  if (!msg) { e.hidden = true; e.textContent = ''; return; }
  e.hidden = false; e.textContent = msg;
}

async function sendComposed() {
  const ta = document.getElementById('composer-text');
  const text = ta.value.trim();
  if (!text) return;
  const requiresReply = document.getElementById('req-reply').checked;
  const threadId = consoleState.selectedThreadId;
  const btn = document.getElementById('send-btn');
  btn.disabled = true; composerError('');
  const body = { text, requiresAck: true, requiresReply, idempotencyKey: newIdempotencyKey() };
  let r;
  if (threadId) {
    const t = consoleState.threads.find((x) => x.threadId === threadId);
    body.to = (t && t.peerSessionId) || '';
    r = await apiPost('/api/thread/' + encodeURIComponent(threadId) + '/send', body);
  } else {
    // Should not happen (send is only shown for a selected thread), but guard anyway.
    composerError('Select or start a thread first.'); btn.disabled = false; return;
  }
  btn.disabled = false;
  if (!r.ok) { composerError('Send failed (' + r.status + '): ' + (r.body.message || r.body.error || 'error')); return; }
  ta.value = '';
  await loadThread(threadId);
  refreshThreads();
}

async function retryTurn(thread, turn, btn) {
  btn.disabled = true;
  const r = await apiPost('/api/thread/' + encodeURIComponent(thread.threadId) + '/send', {
    to: thread.peerSessionId, text: turn.text, requiresAck: turn.requiresAck, requiresReply: turn.requiresReply, idempotencyKey: newIdempotencyKey(),
  });
  if (!r.ok) { btn.disabled = false; return; }
  await loadThread(thread.threadId);
  refreshThreads();
}

async function startNewThread() {
  const sel = document.getElementById('session-select');
  const to = sel.value;
  if (!to) return;
  const btn = document.getElementById('new-thread-btn');
  btn.disabled = true;
  const r = await apiPost('/api/thread', { to, text: 'Hello from the operator console.', requiresAck: true, requiresReply: true, idempotencyKey: newIdempotencyKey() });
  btn.disabled = false;
  if (!r.ok) { composerError('Could not start a thread (' + r.status + '): ' + (r.body.message || r.body.error || 'error')); return; }
  await refreshThreads();
  if (r.body.threadId) await selectThread(r.body.threadId);
}

/* ── refresh + live stream ── */
async function refreshThreads() {
  try {
    const { threads } = await api('/api/threads');
    renderThreadList(threads);
    // If the selected thread is open, keep its timeline fresh.
    if (consoleState.selectedThreadId) await loadThreadQuiet(consoleState.selectedThreadId);
  } catch (e) { if (String(e.message) !== 'unauthorized') { /* leave prior list */ } }
}
/** Reload a thread's timeline WITHOUT re-issuing a mark-read (used by the live refresh). */
async function loadThreadQuiet(threadId) {
  try { const thread = await api('/api/thread/' + encodeURIComponent(threadId)); renderTimeline(thread); }
  catch (e) { if (String(e.message) !== 'unauthorized') { /* keep prior */ } }
}

async function refresh() {
  const [{ sessions }, ledger, banner, audit, threads] = await Promise.all([
    api('/api/sessions'),
    api('/api/ledger?limit=100'),
    api('/api/unmanaged').catch(() => null),
    api('/api/audit').catch(() => null),
    api('/api/threads').catch(() => ({ threads: [] })),
  ]);
  renderSessions(sessions);
  renderLedger(ledger.events || []);
  if (banner) renderBanner(banner);
  renderAudit(audit);
  renderThreadList(threads.threads || []);
  setStatus('Connected · ' + sessions.length + ' session(s)', 'ok');
}

async function stream() {
  try {
    const res = await fetch('/api/stream', { headers: authHeaders() });
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'sessions') renderSessions(evt.sessions);
          else if (evt.type === 'threads') { renderThreadList(evt.threads || []); if (consoleState.selectedThreadId) void loadThreadQuiet(consoleState.selectedThreadId); }
        } catch { /* ignore a partial line */ }
      }
    }
  } catch { /* stream dropped; the poll below keeps the UI fresh */ }
}

function wireUp() {
  document.getElementById('new-thread-btn').addEventListener('click', () => { void startNewThread(); });
  document.getElementById('composer').addEventListener('submit', (e) => { e.preventDefault(); void sendComposed(); });
}

async function boot() {
  wireUp();
  let token = sessionStorage.getItem(TOKEN_KEY);
  const nonce = takeNonceFromFragment();
  if (!token && nonce) { token = await exchangeNonce(nonce); if (token) sessionStorage.setItem(TOKEN_KEY, token); }
  if (!token) { setStatus('No session token — open the dashboard via `xbus dashboard`.', 'err'); return; }
  try {
    await refresh();
    void stream();
    setInterval(() => { refresh().catch(() => {}); }, 5000);
  } catch (e) {
    if (String(e.message) !== 'unauthorized') setStatus('Error: ' + e.message, 'err');
  }
}

document.addEventListener('DOMContentLoaded', boot);
