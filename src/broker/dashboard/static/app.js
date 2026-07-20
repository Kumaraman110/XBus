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

/* Beta.10 (Train B): a small, explicit API surface so the agent-management module (agents.js)
 * reuses the SAME authenticated fetch layer (token in sessionStorage → Authorization header)
 * rather than re-implementing auth. This is the ONLY coupling seam between the modules. */
window.XBusApi = {
  get: (path) => api(path),
  post: (path, obj) => apiPost(path, obj),
  /** Re-render the roster from the cached sessions (used after a filter/collection change). */
  rerender: () => { if (window.__sessions) renderSessions(window.__sessions); },
  /** Full authenticated refresh (used after a mutating action so state matches the broker). */
  refresh: () => refresh(),
};

/* ── small DOM helpers ── */
function text(s) { return document.createTextNode(s == null ? '' : String(s)); }
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.appendChild(text(txt)); return e; }
function cell(row, value) { const td = document.createElement('td'); td.appendChild(text(value)); row.appendChild(td); return td; }
function hhmmss(iso) { return iso ? String(iso).slice(11, 19) : ''; }
/** A 2-char monogram for the session avatar: initials of a hyphenated name, else first 2 chars. */
function monogram(name) {
  const parts = String(name || '').split(/[-_ ]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toLowerCase();
  return String(name || '?').slice(0, 2).toLowerCase();
}

/* ── sessions table (beta.7: separate delivery columns, friendly status, internal filter) ── */

/** Human-friendly status per SessionLabel (drill-down keeps the raw label + conn/readiness). */
const FRIENDLY_STATUS = {
  'active-ready': 'Ready',
  'active-starting': 'Waiting for recipient checkpoint',
  'active-disconnected': 'Disconnected — queuing',
  'dormant': 'Dormant',
  'unmanaged': 'Unmanaged',
  'expired': 'Expired',
};
function friendlyStatus(label) { return FRIENDLY_STATUS[label] || label; }
// Beta.10 (Train B): expose for the agent inspector (agents.js) so status wording stays consistent.
window.XBusFriendlyStatus = friendlyStatus;

/** A colored delivery-count cell (a "state pill"): the number carries the value, the
 *  column header + pill class carry the state (never color-alone). Zero renders muted. */
function deliveryCell(row, n, state) {
  const td = document.createElement('td');
  td.className = 'num';
  const pill = el('span', 'pill pill-' + state + (n ? '' : ' pill-zero'), String(n));
  td.appendChild(pill);
  row.appendChild(td);
}

/** A drill-down details cell: a keyboard-operable disclosure showing the technical detail
 *  (session id, connection/readiness, last sent/received) that the friendly row hides. */
function detailsCell(row, s) {
  const td = document.createElement('td');
  // Beta.10 (Train B): a "Manage" affordance opens the agent inspector (identity + instances +
  // authorized actions). Present only when the agent-management module is loaded.
  if (window.XBusAgents && window.XBusAgents.openInspector) {
    const manage = el('button', 'link-btn manage-btn', 'Manage');
    manage.type = 'button';
    manage.addEventListener('click', () => window.XBusAgents.openInspector(s.sessionId));
    td.appendChild(manage);
  }
  const btn = el('button', 'link-btn', 'Details');
  btn.type = 'button';
  btn.setAttribute('aria-expanded', 'false');
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!open));
    if (open) { if (td.__drawer) { td.__drawer.remove(); td.__drawer = null; } return; }
    const drawer = el('div', 'drill');
    const line = (k, v) => { const d = el('div', 'drill-line'); d.appendChild(el('span', 'drill-k', k)); d.appendChild(text(v)); drawer.appendChild(d); };
    line('id ', s.sessionId);
    line('conn/ready ', s.connection + ' / ' + s.readiness);
    line('mgmt ', s.managementState + (s.identifyConfidence ? ' · ' + s.identifyConfidence : ''));
    if (s.lastSent) line('last sent ', s.lastSent.to + ' · ' + s.lastSent.state + ' · ' + hhmmss(s.lastSent.at));
    if (s.lastReceived) line('last recv ', s.lastReceived.from + ' · ' + s.lastReceived.state + ' · ' + hhmmss(s.lastReceived.at));
    td.appendChild(drawer); td.__drawer = drawer;
  });
  td.appendChild(btn); row.appendChild(td);
}

function isInternal(s) {
  // Prefer the authoritative read-model flag; fall back to the id/slug heuristic for
  // older brokers that don't yet emit `internal`.
  if (typeof s.internal === 'boolean') return s.internal;
  return s.sessionId.startsWith('cli-') || s.sessionId === 'local-operator' || String(s.project).startsWith('proj-cli');
}

function renderSessions(sessions) {
  window.__sessions = sessions; // cache for re-render on filter toggle + the console selector
  const body = document.getElementById('sessions-body');
  body.replaceChildren();
  const showInternal = document.getElementById('show-internal') && document.getElementById('show-internal').checked;
  // Beta.10 (Train B): the agent-management module supplies the roster search/status/Collection
  // filters (all client-side over already-authorized data). Absent (module not loaded) → identity.
  const rosterFilter = (window.XBusAgents && window.XBusAgents.rosterFilter) || ((list) => list);
  const afterFilters = rosterFilter((sessions || []).filter((s) => showInternal || !isInternal(s)));
  const shown = afterFilters;
  const hiddenCount = (sessions || []).length - shown.length;
  if (!shown.length) {
    const r = body.insertRow(); const c = cell(r, sessions && sessions.length ? 'No user sessions — toggle “Internal sessions” to see XBus internals.' : 'No sessions yet.');
    c.colSpan = 8; c.className = 'state-cell';
  } else for (const s of shown) {
    const r = document.createElement('tr');
    if (isInternal(s)) r.className = 'row-internal';
    // Session cell: a monogram avatar + the name + a muted project/description subtitle
    // (matches the locked mock — a plain two-line identity cell, not a bordered badge).
    const nameStr = s.name || s.sessionId.slice(0, 8);
    const label = document.createElement('td');
    const svc = el('div', 'svc');
    const ico = el('span', 'svc-ico badge-' + s.label, monogram(nameStr)); // state class tints the avatar edge
    const main = el('div', 'svc-main');
    main.appendChild(el('span', 'svc-name', nameStr));
    if (s.project) main.appendChild(el('span', 'svc-desc', s.project));
    svc.appendChild(ico); svc.appendChild(main); label.appendChild(svc); r.appendChild(label);
    const st = document.createElement('td'); st.appendChild(el('span', 'status status-' + s.label, friendlyStatus(s.label))); r.appendChild(st);
    const d = s.delivery || { queued: 0, delivered: 0, acknowledged: 0, replied: 0, failed: 0 };
    deliveryCell(r, d.queued, 'queued');
    deliveryCell(r, d.delivered, 'delivered');
    deliveryCell(r, d.acknowledged, 'ack');
    deliveryCell(r, d.replied, 'replied');
    deliveryCell(r, d.failed, 'failed');
    detailsCell(r, s);
    body.appendChild(r);
  }
  // A muted footer note when internal sessions are hidden, so the filter is discoverable.
  const note = document.getElementById('sessions-hidden-note');
  if (note) { note.textContent = hiddenCount > 0 && !showInternal ? hiddenCount + (hiddenCount === 1 ? ' internal session hidden' : ' internal sessions hidden') : ''; }
  renderSessionSelect(sessions);
}
/* Hero + KPI band: live counts derived from the same authenticated payloads the table
 * uses (no new endpoint, no client-set state). Active = all sessions; visible/internal
 * split via isInternal; queued/failed = sums across delivery counts; audit from /api/audit. */
function renderHeroKpis(sessions, audit) {
  const list = sessions || [];
  const total = list.length;
  const internal = list.filter((s) => isInternal(s)).length;
  const visible = total - internal;
  let queued = 0, failed = 0;
  for (const s of list) { const d = s.delivery || {}; queued += d.queued || 0; failed += d.failed || 0; }
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('hero-count', String(total));
  set('hero-noun', total === 1 ? 'session' : 'sessions');
  const auditOk = audit ? audit.ok : null;
  const caption = document.getElementById('hero-caption');
  if (caption) {
    caption.replaceChildren();
    if (total === 0) { caption.appendChild(text('No Claude Code sessions on the bus yet.')); }
    else {
      caption.appendChild(text('on one bus. '));
      caption.appendChild(el('strong', null, queued + (queued === 1 ? ' queued' : ' queued')));
      caption.appendChild(text(' for delivery, '));
      caption.appendChild(el('strong', null, failed + ' failed'));
      caption.appendChild(text(auditOk === true ? ', and an audit chain that verifies itself end‑to‑end.'
        : auditOk === false ? ', and an audit chain that needs attention.' : '.'));
    }
  }
  set('kpi-active', String(total));
  set('kpi-active-sub', visible + ' visible · ' + internal + ' internal');
  set('kpi-queued', String(queued));
  set('kpi-failed', String(failed));
  // KPI accent: the Failed tile turns warning when non-zero.
  const failTile = document.getElementById('kpi-failed'); if (failTile && failTile.parentElement) failTile.parentElement.classList.toggle('kpi-alert', failed > 0);
  set('kpi-audit', auditOk === true ? 'OK' : auditOk === false ? 'BROKEN' : '—');
  set('kpi-audit-sub', audit && typeof audit.checked === 'number' ? audit.checked + ' verified · hash-linked' : 'hash-linked');
  const auditTile = document.getElementById('kpi-audit'); if (auditTile && auditTile.parentElement) auditTile.parentElement.classList.toggle('kpi-alert', auditOk === false);
}
/** The concise chain-status pill inside the ledger card (green OK / red broken), with a
 *  shield glyph — the verbose broker detail is conveyed via title for screen readers. */
function renderAudit(a) {
  const elx = document.getElementById('audit');
  if (!elx) return;
  elx.replaceChildren();
  if (!a) { elx.className = 'ledger-ok'; return; }
  const shield = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  shield.setAttribute('viewBox', '0 0 24 24'); shield.setAttribute('fill', 'none'); shield.setAttribute('stroke', 'currentColor');
  shield.setAttribute('stroke-width', '2'); shield.setAttribute('stroke-linecap', 'round'); shield.setAttribute('aria-hidden', 'true');
  const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p1.setAttribute('d', 'M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z'); shield.appendChild(p1);
  if (a.ok) {
    const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p2.setAttribute('d', 'M9 12l2 2 4-4'); shield.appendChild(p2);
    elx.className = 'ledger-ok';
    elx.appendChild(shield);
    elx.appendChild(el('span', null, `Chain OK · ${a.checked} verified`));
    elx.title = `Audit ledger: chain OK (${a.checked} events verified${a.lastVerifiedAt ? ', last broker verify ' + a.lastVerifiedAt.slice(0, 19) : ''}).`;
  } else {
    const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p2.setAttribute('d', 'M12 8v4M12 15.5v.5'); shield.appendChild(p2);
    elx.className = 'ledger-ok ledger-broken';
    elx.appendChild(shield);
    elx.appendChild(el('span', null, `CHAIN BROKEN at seq ${a.firstBreakSeq}`));
    elx.title = `Historical audit integrity is compromised — routing/delivery are unaffected, but investigate the ledger.`;
  }
}
/** Compact ledger rows (mock: a 3-col grid per row — seq · "EVENT · actor" · truncated
 *  hash + a green ok-dot). #ledger-body is a <div>, not a table. */
function renderLedger(events) {
  const body = document.getElementById('ledger-body');
  body.replaceChildren();
  if (!events.length) { body.appendChild(el('div', 'empty', 'No events yet.')); return; }
  const shortHash = (e) => {
    const h = e.subject && (e.subject.threadId || e.subject.sessionId);
    if (!h) return '—';
    const s = String(h);
    return s.length > 8 ? s.slice(0, 4) + '…' + s.slice(-2) : s;
  };
  for (const e of events) {
    const row = el('div', 'led-row');
    row.appendChild(el('span', 'led-seq', '#' + String(e.seq).padStart(2, '0')));
    const ev = el('div', 'led-ev');
    ev.appendChild(text(e.eventType + ' · '));
    ev.appendChild(el('b', null, e.actor));
    row.appendChild(ev);
    const hash = el('div', 'led-hash');
    hash.appendChild(text(shortHash(e)));
    hash.appendChild(el('span', 'ok-dot'));
    row.appendChild(hash);
    body.appendChild(row);
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
    // Keyboard-operable: a thread row behaves as a button (Enter/Space select it) + is
    // focusable + announces selection state for assistive tech.
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.setAttribute('aria-pressed', String(t.threadId === consoleState.selectedThreadId));
    li.addEventListener('click', () => selectThread(t.threadId));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void selectThread(t.threadId); } });
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

function showError(msg) {
  let b = document.getElementById('error-banner');
  if (!msg) { if (b) b.hidden = true; return; }
  if (!b) {
    b = el('section', 'error-banner'); b.id = 'error-banner'; b.setAttribute('role', 'alert');
    const main = document.querySelector('main');
    if (main && main.parentNode) main.parentNode.insertBefore(b, main);
  }
  b.hidden = false; b.textContent = msg;
}

async function refresh() {
  const [{ sessions }, ledger, banner, audit, threads] = await Promise.all([
    api('/api/sessions'),
    api('/api/ledger?limit=100'),
    api('/api/unmanaged').catch(() => null),
    api('/api/audit').catch(() => null),
    api('/api/threads').catch(() => ({ threads: [] })),
  ]);
  window.__audit = audit || null; // cache for the stream path (sessions events carry no audit)
  renderSessions(sessions);
  renderHeroKpis(sessions, audit);
  renderLedger(ledger.events || []);
  if (banner) renderBanner(banner);
  renderAudit(audit);
  renderThreadList(threads.threads || []);
  showError(null); // clear any prior error on a good refresh
  setStatus('Connected · ' + sessions.length + (sessions.length === 1 ? ' session' : ' sessions'), 'ok');
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
          if (evt.type === 'sessions') { renderSessions(evt.sessions); renderHeroKpis(evt.sessions, window.__audit); }
          else if (evt.type === 'threads') { renderThreadList(evt.threads || []); if (consoleState.selectedThreadId) void loadThreadQuiet(consoleState.selectedThreadId); }
        } catch { /* ignore a partial line */ }
      }
    }
  } catch { /* stream dropped; the poll below keeps the UI fresh */ }
}

function wireUp() {
  document.getElementById('new-thread-btn').addEventListener('click', () => { void startNewThread(); });
  document.getElementById('composer').addEventListener('submit', (e) => { e.preventDefault(); void sendComposed(); });
  // Internal-sessions filter: re-render the cached sessions on toggle (also honored by the
  // live stream via renderSessions reading the checkbox). Persist the preference in
  // sessionStorage so a reload keeps the operator's choice (CSP-safe; same store as the token).
  const showInternal = document.getElementById('show-internal');
  if (showInternal) {
    try { showInternal.checked = sessionStorage.getItem('xbus.showInternal') === '1'; } catch { /* ignore */ }
    showInternal.addEventListener('change', () => {
      try { sessionStorage.setItem('xbus.showInternal', showInternal.checked ? '1' : '0'); } catch { /* ignore */ }
      if (window.__sessions) renderSessions(window.__sessions);
    });
  }
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
    // Backstop poll: surface a persistent failure as a visible error banner (not silent).
    setInterval(() => { refresh().catch((e) => { if (String(e && e.message) !== 'unauthorized') showError('Lost contact with the broker: ' + (e && e.message || e) + ' — retrying…'); }); }, 5000);
  } catch (e) {
    if (String(e.message) !== 'unauthorized') { setStatus('Error: ' + e.message, 'err'); showError('Could not load the console: ' + e.message); }
  }
}

document.addEventListener('DOMContentLoaded', boot);
