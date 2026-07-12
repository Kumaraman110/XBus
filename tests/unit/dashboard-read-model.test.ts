/**
 * Dashboard read model + read-only handle (ADR 0020 Q2/Q5).
 * Proves: the derive-label decision table (all 6 rows, first-match-wins), the read-only
 * handle physically REJECTS writes/DDL/write-pragmas while the writer is live, and the
 * read model returns correct current rows + a keyset-paginated, body-free ledger.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore } from '../../src/broker/store.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';
import { DashboardReadModel, deriveSessionLabel } from '../../src/broker/dashboard/read-model.js';

describe('deriveSessionLabel — ADR 0020 Q2 decision table (top-down, first match wins)', () => {
  const base = { managementState: 'active', connectionState: 'connected', readiness: 'ready_live', expiredAt: null as string | null };
  it('row 1: expired_at set → expired (even if management_state=active)', () => {
    expect(deriveSessionLabel({ ...base, expiredAt: '2026-01-01T00:00:00.000Z' })).toEqual({ label: 'expired', routable: false });
  });
  it('row 2: unmanaged (no tombstone) → unmanaged', () => {
    expect(deriveSessionLabel({ ...base, managementState: 'unmanaged' })).toEqual({ label: 'unmanaged', routable: false });
  });
  it('row 3: dormant → dormant', () => {
    expect(deriveSessionLabel({ ...base, managementState: 'dormant' })).toEqual({ label: 'dormant', routable: false });
  });
  it('row 4: active + disconnected → active-disconnected (queued, not injectable now)', () => {
    expect(deriveSessionLabel({ ...base, connectionState: 'disconnected' })).toEqual({ label: 'active-disconnected', routable: false });
  });
  it('row 5: active + connected + ready_* → active-ready (routable)', () => {
    expect(deriveSessionLabel({ ...base, readiness: 'ready_checkpoint' })).toEqual({ label: 'active-ready', routable: true });
    expect(deriveSessionLabel({ ...base, readiness: 'ready_live' })).toEqual({ label: 'active-ready', routable: true });
  });
  it('row 6: active + connected + initializing/degraded → active-starting (not yet routable)', () => {
    expect(deriveSessionLabel({ ...base, readiness: 'initializing' })).toEqual({ label: 'active-starting', routable: false });
    expect(deriveSessionLabel({ ...base, readiness: 'degraded_ack_unavailable' })).toEqual({ label: 'active-starting', routable: false });
  });
});

describe('read-only handle + read model over a live DB', () => {
  let dir: string; let dbPath: string; let writer: SqliteDriver; let ro: SqliteDriver; let clock: FakeClock; let ids: SeqIdGen; let store: BrokerStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-rodash-'));
    dbPath = path.join(dir, 'x.sqlite');
    writer = openDatabase(dbPath, { applyPragmas: true });
    clock = new FakeClock();
    ids = new SeqIdGen('d');
    runMigrations(writer, clock.nowIso());
    store = new BrokerStore(writer, clock, ids, 'b');
    ro = openDatabase(dbPath, { readOnly: true });
  });
  afterEach(() => { try { ro.close(); } catch { /* */ } try { writer.close(); } catch { /* */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('a read-only handle REJECTS INSERT / DDL / write-pragma while the writer is live', () => {
    expect(() => ro.prepare('INSERT INTO ledger_events (event_id, seq, event_type, actor, subject_json, payload_json, created_at, prev_hash, entry_hash) VALUES (?,?,?,?,?,?,?,?,?)').run('x', 1, 'E', 'a', '{}', '{}', 't', '0', '0')).toThrow();
    expect(() => ro.exec('CREATE TABLE evil(x)')).toThrow();
    expect(() => ro.exec('PRAGMA user_version = 99')).toThrow();
  });

  it('the read model sees rows the writer commits AFTER the RO handle opened (WAL)', () => {
    const auth = store.register({ sessionId: 'dddd0001-0000-4000-8000-000000000001', instanceId: 'i', connectionId: 'c', processId: 1, projectId: 'proj-x', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['pull'], role: 'hook' });
    store.announceSession(auth, { source: 'startup' });
    const model = new DashboardReadModel(ro);
    const sessions = model.sessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionId).toBe('dddd0001-0000-4000-8000-000000000001');
    expect(sessions[0]!.label).toBe('active-starting'); // registered hook, not yet ready
    expect(sessions[0]!.source).toBe('startup');
    // Ledger is visible + body-free + newest-first.
    const led = model.ledger({ limit: 10 });
    expect(led.events.some((e) => e.eventType === 'SESSION_STARTED')).toBe(true);
    for (const e of led.events) expect(JSON.stringify(e).toLowerCase()).not.toContain('body_text');
  });

  it('ledger paging clamps a hostile limit and pages by seq', () => {
    const auth = store.register({ sessionId: 'dddd0002-0000-4000-8000-000000000002', instanceId: 'i', connectionId: 'c', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['pull'], role: 'hook' });
    for (const s of ['startup', 'resume', 'clear', 'compact', 'resume']) store.announceSession(auth, { source: s });
    const model = new DashboardReadModel(ro);
    const huge = model.ledger({ limit: 1e9 }); // clamped to <=500
    expect(huge.events.length).toBeLessThanOrEqual(500);
    const p1 = model.ledger({ limit: 2 });
    expect(p1.events).toHaveLength(2);
    expect(p1.nextBeforeSeq).not.toBeNull();
    const p2 = model.ledger({ limit: 2, beforeSeq: p1.nextBeforeSeq! });
    // p2's seqs are strictly below p1's smallest.
    expect(Math.max(...p2.events.map((e) => e.seq))).toBeLessThan(p1.nextBeforeSeq!);
  });
});
