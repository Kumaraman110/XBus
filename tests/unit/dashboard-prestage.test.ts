/**
 * Beta.10 (Train B) — pre-staged WS1-batch consumption helpers (PURE parts).
 *
 * These pin the pure formatting/eligibility logic for the not-yet-wired features so they're
 * ready the instant WS1 ships the endpoints. All are DEFENSIVE: absent/garbage data yields an
 * empty/hidden result (never a dead control before the endpoint exists).
 *   - instanceHistoryRows (#2 GET /api/session/:id instances[])
 *   - healthPanelModel     (#5 GET /api/health)
 *   - canRedeliverTurn     (#1 POST /api/message/:id/redeliver eligibility)
 */
import { describe, it, expect } from 'vitest';
import {
  instanceHistoryRows, healthPanelModel, canRedeliverTurn,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — plain JS static asset, intentionally untyped
} from '../../src/broker/dashboard/static/prestage.js';

describe('instanceHistoryRows (#2 instances[]) — defensive, current-first', () => {
  const instances = [
    { instanceId: 'i2', role: 'mcp', state: 'connected', processId: 22, connectedAt: '2026-07-20T10:00:00Z', disconnectedAt: null, lastSeenAt: '2026-07-20T10:05:00Z', current: true },
    { instanceId: 'i1', role: 'hook', state: 'disconnected', processId: 11, connectedAt: '2026-07-20T09:00:00Z', disconnectedAt: '2026-07-20T09:30:00Z', lastSeenAt: '2026-07-20T09:30:00Z', current: false },
  ];
  it('maps each instance to a compact row + flags the current one', () => {
    const rows = instanceHistoryRows({ instances });
    expect(rows).toHaveLength(2);
    expect(rows[0].current).toBe(true);
    expect(rows[0].role).toBe('mcp');
    expect(rows[0].pid).toBe(22);
    expect(rows[0].state).toBe('connected');
    expect(rows[1].current).toBe(false);
    expect(rows[1].state).toBe('disconnected');
  });
  it('a session detail WITHOUT instances[] (pre-WS1) yields an empty list — nothing renders', () => {
    expect(instanceHistoryRows({})).toEqual([]);
    expect(instanceHistoryRows(null)).toEqual([]);
    expect(instanceHistoryRows({ instances: 'nope' })).toEqual([]);
  });
});

describe('healthPanelModel (#5 /api/health) — defensive projection to display rows', () => {
  it('formats build/runtime/ledger/readWorker into labeled rows', () => {
    const m = healthPanelModel({
      build: { version: '0.1.0-beta.10', buildId: 'abc', schemaVersion: 10 },
      runtime: { uptimeMs: 3_600_000, pid: 999, nodeVersion: 'v22.13.0' },
      ledger: { ok: true, checked: 42, firstBreakSeq: null },
      readWorker: { inFlight: 1, overloaded: false },
    });
    expect(m.ok).toBe(true);
    const byLabel = Object.fromEntries(m.rows.map((r: { label: string; value: string }) => [r.label, r.value]));
    expect(byLabel['Version']).toContain('beta.10');
    expect(byLabel['Schema']).toContain('10');
    expect(byLabel['Ledger']).toMatch(/OK/i);
    expect(byLabel['Ledger']).toContain('42');
    expect(m.alert).toBe(false);
  });
  it('a broken ledger flips alert true and reports the break', () => {
    const m = healthPanelModel({ build: {}, ledger: { ok: false, checked: 10, firstBreakSeq: 7 } });
    expect(m.alert).toBe(true);
    const led = m.rows.find((r: { label: string }) => r.label === 'Ledger');
    expect(led.value).toMatch(/broken/i);
    expect(led.value).toContain('7');
  });
  it('a null/garbage body → not-ok model, empty rows (panel stays hidden)', () => {
    expect(healthPanelModel(null).ok).toBe(false);
    expect(healthPanelModel(null).rows).toEqual([]);
  });
});

describe('canRedeliverTurn (#1) — eligibility for the operator redelivery button', () => {
  // Redelivery re-presents a body to the RECIPIENT; only meaningful for an operator turn that
  // reached the recipient (injected/acknowledged/reply-pending) or failed/expired — never for a
  // queued turn (never delivered) or a claude turn (operator didn't send it).
  it('eligible for an operator turn that was injected / reply-pending / failed / expired', () => {
    for (const st of ['injected', 'reply-pending', 'acknowledged', 'failed', 'expired']) {
      expect(canRedeliverTurn({ authorType: 'operator' }, st), st).toBe(true);
    }
  });
  it('NOT eligible for a queued operator turn (never delivered) or a replied turn (done)', () => {
    expect(canRedeliverTurn({ authorType: 'operator' }, 'queued')).toBe(false);
    expect(canRedeliverTurn({ authorType: 'operator' }, 'replied')).toBe(false);
  });
  it('NOT eligible for a claude (recipient) turn — the operator did not send it', () => {
    expect(canRedeliverTurn({ authorType: 'claude' }, 'injected')).toBe(false);
  });
});
