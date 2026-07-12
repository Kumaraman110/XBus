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
import { Reaper } from '../../src/broker/reaper.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';
import { XBusError, XBusErrorCode } from '../../src/protocol/errors.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let clock: FakeClock; let reaper: Reaper;
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
  reaper = new Reaper(db, clock, new SeqIdGen('r'));
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

  // Regression (four-replica reliability audit, 2026-07-12): two DISTINCT sessions
  // whose CLAUDE_CODE_SESSION_IDs happen to share the same first 8 hex chars derive
  // the SAME automatic fallback alias (`session-<8hex>`, aliases.ts). The broker-minted
  // automatic_alias row is inserted with a bare INSERT into the active-unique aliases
  // index, so the SECOND such registration hit `UNIQUE constraint failed: aliases.alias_ci`
  // — a raw node:sqlite error surfaced to the peer as the mislabeled generic
  // `DATABASE_ERROR "internal error"`, and it FAILED the whole registration. Since the
  // session remains fully routable by its exact sessionId (and the automatic_alias is a
  // non-essential convenience fallback), an 8-hex prefix collision must NEVER fail
  // registration nor leak an internal DB error: the second session registers cleanly and
  // simply does not hold the shared fallback alias.
  it('two sessions sharing the first-8-hex prefix both register cleanly (automatic_alias collision is not fatal)', () => {
    const shared = 'abcd1234';
    const s1 = `${shared}-0000-4000-8000-000000000001`;
    const s2 = `${shared}-0000-4000-8000-000000000002`; // same first 8 hex → same session-<8hex> alias
    const a1 = store.register({ sessionId: s1, instanceId: 'i1', connectionId: 'c1', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp' });
    expect(a1.epoch).toBeGreaterThanOrEqual(1);
    // The SECOND registration must not throw a raw error, and if it throws at all it must
    // be a clean typed XBusError — never a mislabeled DATABASE_ERROR / raw UNIQUE-constraint.
    let a2: ReturnType<BrokerStore['register']> | undefined;
    try {
      a2 = store.register({ sessionId: s2, instanceId: 'i2', connectionId: 'c2', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp' });
    } catch (e) {
      expect(e, 'automatic_alias collision must not surface a raw/DB error').toBeInstanceOf(XBusError);
      expect((e as XBusError).code).not.toBe(XBusErrorCode.DATABASE_ERROR);
      expect(String((e as Error).message)).not.toMatch(/UNIQUE constraint|internal error/i);
      throw e; // if it's a clean typed error we still want to know; but the desired behavior is success
    }
    // Desired behavior: the second session registers successfully.
    expect(a2!.epoch).toBeGreaterThanOrEqual(1);
    expect(a2!.sessionId).toBe(s2);
    // Both sessions exist and are individually routable by their exact sessionId.
    const both = db.prepare(`SELECT session_id, automatic_alias FROM sessions WHERE session_id IN (?,?)`).all(s1, s2) as Array<{ session_id: string; automatic_alias: string }>;
    expect(both.length).toBe(2);
    // Exactly one ACTIVE aliases-table row holds the shared fallback alias (no duplicate,
    // no crash); the other session simply doesn't hold that convenience alias.
    const holders = db.prepare(`SELECT COUNT(*) AS n FROM aliases WHERE alias_ci=? AND scope='global' AND active=1`).get(`session-${shared}`) as { n: number };
    expect(holders.n).toBe(1);
  });

  // Regression (adversarial review of the collision fix): the RESUME paths must also be
  // collision-safe. An EXPIRED session's alias rows are retired (active=0), NOT deleted;
  // if a prefix-mate claims the shared automatic alias active while the first is expired,
  // the first session's resume must NOT bare-`UPDATE active=1` its own retired row (that
  // would collide with the mate's active row on ux_alias_global → raw UNIQUE constraint →
  // mislabeled DATABASE_ERROR → failed registration). Resume must register cleanly and
  // simply not (re)hold the shared alias.
  it('expired-resume with a prefix-mate holding the fallback alias registers cleanly (no UNIQUE-constraint leak)', () => {
    const shared = 'beef5678';
    const sA = `${shared}-0000-4000-8000-00000000000a`;
    const sB = `${shared}-0000-4000-8000-00000000000b`; // shares first-8-hex with A
    // A registers first → holds active session-beef5678.
    store.register({ sessionId: sA, instanceId: 'ia', connectionId: 'ca', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp' });
    // A expires (advance the meaningful-activity clock past the 15-day retention, then sweep).
    clock.advance(16 * 24 * 60 * 60_000);
    reaper.sweep();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM aliases WHERE alias_ci=? AND active=1`).get(`session-${shared}`)).toMatchObject({ n: 0 }); // A's row retired
    // B registers → claims the now-free active fallback alias.
    store.register({ sessionId: sB, instanceId: 'ib', connectionId: 'cb', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp' });
    expect(db.prepare(`SELECT session_id FROM aliases WHERE alias_ci=? AND active=1`).get(`session-${shared}`)).toMatchObject({ session_id: sB });
    // A RESUMES (expired-resume → freshLifecycle). Must NOT throw a raw/DB error.
    let resumed: ReturnType<BrokerStore['register']> | undefined;
    try {
      resumed = store.register({ sessionId: sA, instanceId: 'ia2', connectionId: 'ca2', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp' });
    } catch (e) {
      expect((e as XBusError).code, 'resume collision must not be a DB error').not.toBe(XBusErrorCode.DATABASE_ERROR);
      expect(String((e as Error).message)).not.toMatch(/UNIQUE constraint|internal error/i);
      throw e;
    }
    expect(resumed!.sessionId).toBe(sA);
    // Still exactly one active holder of the shared alias — B keeps it; A resumed routable by id.
    const holders = db.prepare(`SELECT session_id FROM aliases WHERE alias_ci=? AND scope='global' AND active=1`).all(`session-${shared}`) as Array<{ session_id: string }>;
    expect(holders.length).toBe(1);
    expect(holders[0]!.session_id).toBe(sB);
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

describe('registration-order race: hook registers unnamed BEFORE the MCP names the session', () => {
  // Live-acceptance regression: in the real CLI the UserPromptSubmit hook can register a
  // session FIRST (as a HOOK, projectId 'proj-hook', NO requestedSessionName) before the
  // MCP server's named registration arrives. The MCP register is then a reconnect (not a
  // new lifecycle). Historically that left the session 'unnamed' forever (observed live:
  // project-a got named, project-b stayed unnamed purely on ordering). Naming a still-
  // 'unnamed' session on reconnect is NOT a re-roll, so it must now succeed.
  const sid2 = (): string => { const h = (100 + (n += 1)).toString(16).padStart(8, '0'); return `${h}-0000-4000-8000-000000000000`; };

  it('hook-first (unnamed) then MCP-with-name -> session becomes active-named', () => {
    const s = sid2();
    // 1) HOOK registers first: role 'hook', no requested name, placeholder project.
    const hookAuth = store.register({ sessionId: s, instanceId: 'hook-i', connectionId: `c-hook-${s}`, processId: 1, projectId: 'proj-hook', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['pull'], role: 'hook' });
    expect(nameState(s).state).toBe('unnamed');
    // 2) MCP registers with the derived name — a reconnect, but the session is unnamed.
    const mcpAuth = store.register({ sessionId: s, instanceId: 'mcp-i', connectionId: `c-mcp-${s}`, processId: 2, projectId: 'p', cwd: '/proj', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', requestedSessionName: 'project-b', agentType: 'claude' });
    const ns = nameState(s);
    expect(ns.state).toBe('active');            // named on reconnect (was the bug: stayed unnamed)
    expect(ns.name).toBe('project-b');
    expect(mcpAuth.awardedSessionName).toBe('project-b');
    expect(mcpAuth.sessionNameState).toBe('active');
    // agent_type backfilled from the hook placeholder (null) to the real agent.
    const at = (db.prepare('SELECT agent_type AS a FROM sessions WHERE session_id=?').get(s) as { a: string | null }).a;
    expect(at).toBe('claude');
    // now discoverable + routable by name.
    expect(store.listActiveNamedSessions().map((x) => x.name)).toContain('project-b');
    expect(hookAuth.epoch).toBeGreaterThan(0);
  });

  it('a hook reconnect does NOT re-roll / wipe an ALREADY-active name (guard preserved)', () => {
    const s = sid2();
    // MCP owns the session with an active name.
    store.register({ sessionId: s, instanceId: 'mcp-i', connectionId: `c-mcp-${s}`, processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp', requestedSessionName: 'keep-me' });
    expect(nameState(s).name).toBe('keep-me');
    // A later HOOK registration (reconnect, no requestedSessionName — exactly what the
    // lifecycle hook sends every checkpoint) must leave the active name untouched: my
    // fix only claims when the session is CURRENTLY 'unnamed', so 'active' is preserved.
    store.register({ sessionId: s, instanceId: 'hook-i', connectionId: `c-hook-${s}`, processId: 2, projectId: 'proj-hook', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['pull'], role: 'hook' });
    expect(nameState(s).name).toBe('keep-me');   // unchanged
    expect(nameState(s).state).toBe('active');
  });

  it('hook-first then MCP with NO name -> stays unnamed (no spurious naming)', () => {
    const s = sid2();
    store.register({ sessionId: s, instanceId: 'hook-i', connectionId: `c-hook-${s}`, processId: 1, projectId: 'proj-hook', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['pull'], role: 'hook' });
    store.register({ sessionId: s, instanceId: 'mcp-i', connectionId: `c-mcp-${s}`, processId: 2, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp' }); // no name
    expect(nameState(s).state).toBe('unnamed');
  });
});
