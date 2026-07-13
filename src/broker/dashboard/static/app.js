/* XBus dashboard UI — a pure CLIENT of the tested read-only API (ADR 0015/0018/0020).
 * Contains NO secrets and NO session data (inert asset). It:
 *   1. reads the one-time nonce from location.hash, immediately strips the fragment
 *      (history.replaceState) so a reload/bookmark/back cannot replay it,
 *   2. exchanges it at POST /auth/exchange for a short-lived tab token,
 *   3. holds the token in sessionStorage ONLY (never in persistent storage, a cookie, or the URL),
 *   4. sends the token as Authorization: Bearer on every /api/* request + the stream.
 * No inline handlers (strict CSP: script-src 'self'); everything wires up here. */
'use strict';

const TOKEN_KEY = 'xbus.tabToken';

function setStatus(msg, cls) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

/** Consume the nonce fragment (if present) and strip it from the URL. */
function takeNonceFromFragment() {
  const hash = location.hash || '';
  const m = /[#&]n=([^&]+)/.exec(hash);
  const nonce = m ? decodeURIComponent(m[1]) : null;
  // Strip the fragment regardless, so it never lingers in the address bar / history.
  if (hash) history.replaceState(null, '', location.pathname + location.search);
  return nonce;
}

async function exchangeNonce(nonce) {
  const res = await fetch('/auth/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce }),
  });
  if (!res.ok) return null;
  const { token } = await res.json();
  return token || null;
}

function authHeaders() {
  const token = sessionStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: 'Bearer ' + token } : {};
}

async function api(path) {
  const res = await fetch(path, { headers: authHeaders() });
  if (res.status === 401) { onExpired(); throw new Error('unauthorized'); }
  if (!res.ok) throw new Error('request failed: ' + res.status);
  return res.json();
}

function onExpired() {
  sessionStorage.removeItem(TOKEN_KEY);
  setStatus('Session expired — reopen from XBus (run `xbus dashboard`).', 'err');
}

function text(s) { return document.createTextNode(s == null ? '' : String(s)); }
function cell(row, value) { const td = document.createElement('td'); td.appendChild(text(value)); row.appendChild(td); return td; }

function msgCell(m, who) {
  if (!m) return '—';
  return `${m[who]} · ${m.state} · ${m.at.slice(11, 19)}`;
}
function renderSessions(sessions) {
  const body = document.getElementById('sessions-body');
  body.replaceChildren();
  if (!sessions.length) { const r = body.insertRow(); const c = cell(r, 'No sessions yet.'); c.colSpan = 7; return; }
  for (const s of sessions) {
    const r = document.createElement('tr');
    const label = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'badge badge-' + s.label;
    badge.appendChild(text(s.name || s.sessionId.slice(0, 8)));
    label.appendChild(badge);
    r.appendChild(label);
    cell(r, s.label);
    cell(r, `${s.connection}/${s.readiness}`);
    cell(r, msgCell(s.lastSent, 'to'));
    cell(r, msgCell(s.lastReceived, 'from'));
    const d = s.delivery || { queued: 0, delivered: 0, acknowledged: 0, replied: 0, failed: 0 };
    cell(r, `${d.queued}/${d.delivered}/${d.acknowledged}/${d.replied}/${d.failed}`);
    cell(r, s.project);
    body.appendChild(r);
  }
}

function renderAudit(a) {
  const el = document.getElementById('audit');
  if (!a) { el.textContent = ''; el.className = 'audit'; return; }
  if (a.ok) {
    el.className = 'audit audit-ok';
    el.textContent = `Audit ledger: chain OK (${a.checked} events verified${a.lastVerifiedAt ? ', last broker verify ' + a.lastVerifiedAt.slice(0, 19) : ''}).`;
  } else {
    el.className = 'audit audit-broken';
    el.textContent = `Audit ledger: CHAIN BROKEN at seq ${a.firstBreakSeq}. Historical audit integrity is compromised — routing/delivery are unaffected, but investigate the ledger.`;
  }
}

function renderLedger(events) {
  const body = document.getElementById('ledger-body');
  body.replaceChildren();
  if (!events.length) { const r = body.insertRow(); const c = cell(r, 'No events yet.'); c.colSpan = 5; return; }
  for (const e of events) {
    const r = document.createElement('tr');
    cell(r, e.seq);
    cell(r, e.eventType);
    cell(r, e.actor);
    cell(r, e.subject && e.subject.sessionId ? e.subject.sessionId.slice(0, 8) : '—');
    cell(r, e.createdAt);
    body.appendChild(r);
  }
}

function renderBanner(banner) {
  const el = document.getElementById('banner');
  if (banner && banner.possibleUnmanaged > 0) {
    el.hidden = false;
    el.textContent = banner.possibleUnmanaged + ' Claude session(s) may be running that started before XBus and aren’t managed yet — resume or restart them so XBus registers them at SessionStart.';
  } else {
    el.hidden = true;
  }
}

async function refresh() {
  const [{ sessions }, ledger, banner, audit] = await Promise.all([
    api('/api/sessions'),
    api('/api/ledger?limit=100'),
    api('/api/unmanaged').catch(() => null),
    api('/api/audit').catch(() => null),
  ]);
  renderSessions(sessions);
  renderLedger(ledger.events || []);
  if (banner) renderBanner(banner);
  renderAudit(audit);
  setStatus('Connected · ' + sessions.length + ' session(s)', 'ok');
}

/** Live updates via fetch-streaming (NDJSON) with the Authorization header — the SSE
 *  browser API cannot send auth headers, so we use fetch() streaming instead. Best-effort;
 *  falls back to the periodic refresh below. */
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
        try { const evt = JSON.parse(line); if (evt.type === 'sessions') renderSessions(evt.sessions); } catch { /* ignore a partial line */ }
      }
    }
  } catch { /* stream dropped; the poll below keeps the UI fresh */ }
}

async function boot() {
  // Reuse an existing tab token (survives reload within the tab); else exchange a nonce.
  let token = sessionStorage.getItem(TOKEN_KEY);
  const nonce = takeNonceFromFragment();
  if (!token && nonce) {
    token = await exchangeNonce(nonce);
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
  }
  if (!token) { setStatus('No session token — open the dashboard via `xbus dashboard`.', 'err'); return; }
  try {
    await refresh();
    void stream();
    // A gentle poll as a backstop in case the stream drops (bounded, read-only).
    setInterval(() => { refresh().catch(() => {}); }, 5000);
  } catch (e) {
    if (String(e.message) !== 'unauthorized') setStatus('Error: ' + e.message, 'err');
  }
}

document.addEventListener('DOMContentLoaded', boot);
