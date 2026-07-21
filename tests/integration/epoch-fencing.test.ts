/**
 * BETA.10 WS1 R4 — epoch fencing on ALL identity/routing-mutating paths.
 *
 * Invariant: an old (superseded) epoch cannot mutate identity/routing state. rename + signalReadiness
 * already fence (active_epoch !== auth.epoch → EPOCH_MISMATCH). registerAlias did NOT — a stale-epoch
 * connection could register a routable alias (routing hijack). This proves fencing on registerAlias
 * (and re-confirms rename), so a superseded principal cannot change routing.
 *
 * RED-first: the registerAlias case fails at 6237d87 (no fence there yet). Store-layer harness.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority } from '../../src/broker/store.js';
import { XBusErrorCode } from '../../src/protocol/errors.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let clock: FakeClock;
let n = 0;
const sid = (): string => { const h = (++n).toString(16).padStart(8, '0'); return `${h}-0000-4000-8000-000000000000`; };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-fence-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, new SeqIdGen('m'), 'b');
});
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function reg(over: Partial<Parameters<BrokerStore['register']>[0]> = {}): SessionAuthority {
  const s = over.sessionId ?? sid();
  return store.register({ sessionId: s, instanceId: 'i', connectionId: `c-${s}-${n}`, processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', ...over });
}

describe('WS1 R4 — old epochs cannot mutate identity/routing (RED-first)', () => {
  it('registerAlias from a STALE epoch is rejected (routing-hijack fence)', () => {
    const s = sid();
    const e1 = reg({ sessionId: s });                        // epoch 1 (keep this authority)
    // a supersede takeover bumps the session to epoch 2 (e1 is now stale).
    const e2 = store.register({ sessionId: s, instanceId: 'i2', connectionId: `c2-${s}`, processId: 2, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', supersede: true } as never);
    expect(e2.epoch).toBeGreaterThan(e1.epoch);
    // the STALE epoch-1 authority must NOT be able to register a routable alias.
    expect(() => store.registerAlias(e1, 'hijacked-alias')).toThrowError(
      expect.objectContaining({ code: XBusErrorCode.EPOCH_MISMATCH }),
    );
    // and the alias was NOT created.
    const got = (db.prepare(`SELECT COUNT(*) AS n FROM aliases WHERE alias_ci='hijacked-alias' AND active=1`).get() as { n: number }).n;
    expect(got).toBe(0);
    // the CURRENT epoch CAN register it (fencing rejects only the stale epoch).
    expect(() => store.registerAlias(e2, 'ok-alias')).not.toThrow();
  });

  it('renameSession from a STALE epoch is rejected (re-confirm existing fence)', () => {
    const s = sid();
    const e1 = reg({ sessionId: s });
    store.register({ sessionId: s, instanceId: 'i2', connectionId: `c2-${s}`, processId: 2, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', supersede: true } as never);
    expect(() => store.renameSession(e1, 'stale-rename')).toThrowError(
      expect.objectContaining({ code: XBusErrorCode.EPOCH_MISMATCH }),
    );
  });
});
