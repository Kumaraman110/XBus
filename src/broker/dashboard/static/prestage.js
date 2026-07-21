/* XBus dashboard — pre-staged WS1-batch consumption helpers (beta.10, Train B). PURE + CSP-safe.
 *
 * These build the PURE logic for the not-yet-wired features so the dashboard is ready the instant
 * WS1 ships the endpoints (#1 redelivery, #2 instances[], #5 /api/health). Every helper is
 * DEFENSIVE: absent/garbage data (the pre-WS1 world) yields an empty/hidden result — respecting the
 * zero-dead-control gate. The render code that calls these is capability-gated (capabilities.js).
 *
 * ES module for unit-testability; published on window.XBusPrestage for agents.js/app.js.
 */
'use strict';

/**
 * #2 — map a session detail's instances[] (GET /api/session/:id, WS1 shape) to compact display
 * rows, current-first (the broker sends newest-first with `current` flagged). Absent/garbage → [].
 * Shape per row: { instanceId, role, state, pid, connectedAt, disconnectedAt, lastSeenAt, current }.
 */
export function instanceHistoryRows(sessionDetail) {
  const d = sessionDetail || {};
  if (!Array.isArray(d.instances)) return [];
  return d.instances
    .filter((i) => i && typeof i === 'object')
    .map((i) => ({
      instanceId: String(i.instanceId ?? ''),
      role: String(i.role ?? '?'),
      state: String(i.state ?? '?'),
      pid: (typeof i.processId === 'number') ? i.processId : null,
      connectedAt: i.connectedAt ?? null,
      disconnectedAt: i.disconnectedAt ?? null,
      lastSeenAt: i.lastSeenAt ?? null,
      current: i.current === true,
    }));
}

/**
 * #5 — project a /api/health body (WS1 shape) into { ok, alert, rows[] } for the health panel.
 * `alert` is true when the ledger chain is broken (the one thing that needs attention). A
 * null/garbage body → { ok:false, rows:[] } so the panel stays hidden. Never throws.
 */
export function healthPanelModel(body) {
  if (!body || typeof body !== 'object') return { ok: false, alert: false, rows: [] };
  const b = body.build || {};
  const rt = body.runtime || {};
  const led = body.ledger || {};
  const rw = body.readWorker || {};
  const rows = [];
  const push = (label, value) => { if (value != null && value !== '') rows.push({ label, value: String(value) }); };
  push('Version', b.version);
  if (b.buildId) push('Build', b.exactBuildId ? (b.buildId + ' · ' + b.exactBuildId) : b.buildId);
  push('Schema', b.schemaVersion);
  if (rt.uptimeMs != null) push('Uptime', formatUptime(rt.uptimeMs));
  if (rt.pid != null) push('Broker pid', rt.pid);
  push('Node', rt.nodeVersion);
  const ledgerBroken = led.ok === false;
  if ('ok' in led || 'checked' in led) {
    push('Ledger', ledgerBroken
      ? ('CHAIN BROKEN at seq ' + (led.firstBreakSeq != null ? led.firstBreakSeq : '?'))
      : ('OK · ' + (led.checked != null ? led.checked : 0) + ' verified'));
  }
  if (rw.overloaded != null || rw.inFlight != null) {
    push('Read worker', (rw.overloaded ? 'OVERLOADED' : 'ok') + (rw.inFlight != null ? ' · ' + rw.inFlight + ' in flight' : ''));
  }
  return { ok: rows.length > 0, alert: ledgerBroken, rows };
}

function formatUptime(ms) {
  const s = Math.max(0, Math.floor(Number(ms) / 1000));
  if (!Number.isFinite(s)) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return d + 'd ' + h + 'h';
  if (h) return h + 'h ' + m + 'm';
  if (m) return m + 'm';
  return s + 's';
}

/**
 * #1 — is the operator redelivery action eligible for this turn at the given derived timeline
 * state? Redelivery re-presents a body to the RECIPIENT, so it's meaningful ONLY for an OPERATOR
 * turn that actually reached (or attempted) the recipient — injected / acknowledged / reply-pending
 * / failed / expired — never a queued turn (never delivered) and never a claude (recipient) turn.
 */
export function canRedeliverTurn(turn, timelineState) {
  const t = turn || {};
  if (t.authorType !== 'operator') return false;
  return timelineState === 'injected' || timelineState === 'acknowledged'
    || timelineState === 'reply-pending' || timelineState === 'failed' || timelineState === 'expired';
}

if (typeof window !== 'undefined') {
  window.XBusPrestage = { instanceHistoryRows, healthPanelModel, canRedeliverTurn };
}
