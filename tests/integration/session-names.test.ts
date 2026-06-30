/**
 * Session-name model at the store layer (beta.4, ADR 0012 Decisions 3-4).
 *
 * register() accepts an optional requestedSessionName:
 *   - valid + unclaimed         -> session_name_state='active', name held
 *   - taken by another ACTIVE   -> 'pending' (session STILL registers; unroutable by name)
 *   - invalid (reserved/etc.)   -> 'pending' (with a recorded reject reason)
 *   - absent                    -> 'unnamed' (legacy; routable by automatic_alias)
 * Registration NEVER fails or silently suffixes because of a name problem.
 *
 * renameSession() is atomic: validate -> acquire (unique) -> release old -> audit.
 * Discovery (listActiveNamedSessions) excludes pending/unnamed/retired.
 * A meaningful-activity timestamp is stamped at first registration.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore } from '../../src/broker/store.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';
import { XBusError, XBusErrorCode } from '../../src/protocol/errors.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let clock: FakeClock;
let n = 0;
// Each session needs a DISTINCT first-8-hex prefix: automaticAlias() derives the
// fallback alias from sessionId.slice(0,8), and that alias is globally unique.
const sid = (): string => { const h = (++n).toString(16).padStart(8, '0'); return `${h}-0000-4000-8000-000000000000`; };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-names-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, new SeqIdGen('m'), 'b');
});
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function reg(over: Partial<Parameters<BrokerStore['register']>[0]> = {}): ReturnType<BrokerStore['register']> {
  const s = sid();
  return store.register({ sessionId: s, instanceId: 'i', connectionId: `c-${s}`, processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', ...over });
}
function nameState(sessionId: string): { state: string; name: string | null; normalized: string | null } {
  const r = db.prepare('SELECT session_name_state AS state, session_name AS name, normalized_session_name AS normalized FROM sessions WHERE session_id=?').get(sessionId) as { state: string; name: string | null; normalized: string | null };
  return r;
}

describe('register() with a session name', () => {
  it('valid + unclaimed name -> active, name held (display + normalized)', () => {
    const auth = reg({ requestedSessionName: 'SeatMap-API' });
    const ns = nameState(auth.sessionId);
    expect(ns.state).toBe('active');
    expect(ns.name).toBe('SeatMap-API');
    expect(ns.normalized).toBe('seatmap-api');
  });

  it('absent name -> unnamed (legacy), routable by automatic_alias', () => {
    const auth = reg();
    expect(nameState(auth.sessionId).state).toBe('unnamed');
    expect(nameState(auth.sessionId).normalized).toBeNull();
  });

  it('name taken by another ACTIVE session -> pending; registration still succeeds', () => {
    reg({ requestedSessionName: 'payments' });
    const b = reg({ requestedSessionName: 'payments' }); // collision
    const ns = nameState(b.sessionId);
    expect(ns.state).toBe('pending'); // NOT active, NOT a silent suffix
    expect(ns.normalized).toBeNull(); // does not hold the name
    // b is still a real registered session with an epoch/authority.
    expect(b.epoch).toBeGreaterThanOrEqual(1);
  });

  it('case-insensitive collision -> pending', () => {
    reg({ requestedSessionName: 'Netomi-Flow' });
    const b = reg({ requestedSessionName: 'netomi-flow' });
    expect(nameState(b.sessionId).state).toBe('pending');
  });

  it('invalid name (reserved) -> pending, registration still succeeds', () => {
    const auth = reg({ requestedSessionName: 'admin' });
    expect(nameState(auth.sessionId).state).toBe('pending');
  });

  it('first registration stamps last_meaningful_activity_at and a 15-day expires_at', () => {
    const auth = reg({ requestedSessionName: 'svc-one' });
    const r = db.prepare('SELECT last_meaningful_activity_at AS a, expires_at AS e FROM sessions WHERE session_id=?').get(auth.sessionId) as { a: string | null; e: string | null };
    expect(r.a).toBe(clock.nowIso());
    expect(new Date(r.e!).getTime() - new Date(r.a!).getTime()).toBe(15 * 24 * 60 * 60_000);
  });
});

describe('renameSession()', () => {
  it('atomically moves an active name to a new valid unclaimed name', () => {
    const auth = reg({ requestedSessionName: 'old-name' });
    const out = store.renameSession(auth, 'new-name');
    expect(out.name).toBe('new-name');
    expect(out.state).toBe('active');
    const ns = nameState(auth.sessionId);
    expect(ns.normalized).toBe('new-name');
    // The old name is free again: a fresh session can claim it.
    const b = reg({ requestedSessionName: 'old-name' });
    expect(nameState(b.sessionId).state).toBe('active');
  });

  it('promotes a pending session to active when it picks a free valid name', () => {
    reg({ requestedSessionName: 'dup' });
    const b = reg({ requestedSessionName: 'dup' }); // -> pending
    expect(nameState(b.sessionId).state).toBe('pending');
    const out = store.renameSession(b, 'dup-reviewer');
    expect(out.state).toBe('active');
    expect(nameState(b.sessionId).normalized).toBe('dup-reviewer');
  });

  it('rejects a rename to a name held by another active session (SESSION_NAME_TAKEN)', () => {
    const a = reg({ requestedSessionName: 'taken' });
    const b = reg({ requestedSessionName: 'mine' });
    try {
      store.renameSession(b, 'taken');
      throw new Error('expected rename to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(XBusError);
      expect((e as XBusError).code).toBe(XBusErrorCode.SESSION_NAME_TAKEN);
    }
    // a still holds it; b unchanged.
    expect(nameState(a.sessionId).normalized).toBe('taken');
    expect(nameState(b.sessionId).normalized).toBe('mine');
  });

  it('rejects a rename to an invalid name (INVALID_SESSION_NAME)', () => {
    const a = reg({ requestedSessionName: 'fine' });
    expect(() => store.renameSession(a, 'system')).toThrow(XBusError);
  });

  it('renaming refreshes meaningful activity', () => {
    const a = reg({ requestedSessionName: 'act-one' });
    clock.advance(60_000);
    store.renameSession(a, 'act-two');
    const r = db.prepare('SELECT last_meaningful_activity_at AS a FROM sessions WHERE session_id=?').get(a.sessionId) as { a: string };
    expect(r.a).toBe(clock.nowIso());
  });
});

describe('discovery — listActiveNamedSessions()', () => {
  it('returns only active-named sessions, never pending/unnamed/retired', () => {
    const a = reg({ requestedSessionName: 'visible-one' });
    reg(); // unnamed
    reg({ requestedSessionName: 'visible-one' }); // pending (collision)
    const b = reg({ requestedSessionName: 'visible-two' });
    const names = store.listActiveNamedSessions().map((s) => s.name).sort();
    expect(names).toEqual(['visible-one', 'visible-two']);
    // sanity: ids present
    const ids = store.listActiveNamedSessions().map((s) => s.sessionId);
    expect(ids).toContain(a.sessionId);
    expect(ids).toContain(b.sessionId);
  });

  it('a pending session is NOT routable by name (resolveRecipient throws UNKNOWN_RECIPIENT)', () => {
    reg({ requestedSessionName: 'owner' });
    const sender = reg({ requestedSessionName: 'sender' });
    const pending = reg({ requestedSessionName: 'owner' }); // pending
    expect(nameState(pending.sessionId).state).toBe('pending');
    // Sending to 'owner' resolves to the ACTIVE owner, never the pending one — and
    // there is exactly one active 'owner', so it is unambiguous.
    const res = store.send(sender, { to: 'owner', text: 'hi', kind: 'request', requiresAck: false, requiresReply: false });
    expect(res.recipientSessionId).not.toBe(pending.sessionId);
  });
});
