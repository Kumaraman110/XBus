/**
 * `get_status` reports the CALLER's own broker-owned session identity (beta.4 usability
 * fix). Exercised through the REAL broker (startBrokerHost + IpcClient), because the
 * enrichment lives in the daemon's onStatus handler.
 *
 * Invariants proven:
 *   - active named session   -> sessionName = normalized active name, state 'active'
 *   - pending-name session   -> sessionName null, state 'pending'
 *   - unnamed session        -> sessionName null, state 'unnamed'
 *   - rename is reflected immediately
 *   - a status read does NOT refresh last_meaningful_activity_at
 *   - a status read does NOT revive an expired session (reports expired, name null)
 *   - the session is keyed by the AUTHENTICATED connection — a caller cannot spoof
 *     another session's id via the request payload
 *   - re-registration (new epoch) is reflected: new epoch + current name
 *   - the payload carries the compatibilityId and never leaks bodies/secrets
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startBrokerHost, type RunningBroker } from '../../src/broker/host.js';
import { IpcClient } from '../../src/ipc/client.js';
import { clientHello } from '../../src/ipc/hello.js';
import { ComponentRole } from '../../src/identity/components.js';
import { BUILD_ID } from '../../src/protocol/handshake.js';

let dataDir: string;
let broker: RunningBroker;
const clients: IpcClient[] = [];

async function conn(role = 'mcp', sessionId?: string): Promise<IpcClient> {
  const c = new IpcClient(broker.endpoint, {
    requestTimeoutMs: 4000, rootSecret: broker.rootSecret,
    ...(sessionId ? { helloIdentity: { claimedRole: role as 'mcp', claimedSessionId: sessionId } } : {}),
  });
  await c.connect();
  clients.push(c);
  await c.request('hello', clientHello(role as 'mcp'));
  return c;
}
let seq = 0;
const sid = (): string => { const h = (++seq).toString(16).padStart(8, '0'); return `${h}-0000-4000-8000-000000000000`; };
function baseReg(sessionId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { sessionId, instanceId: 'i-' + sessionId.slice(0, 4), processId: 1, projectId: 'p', cwd: '/proj', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', ...over };
}
async function status(c: IpcClient, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const f = await c.request('get_status', extra);
  return (f.payload ?? f) as Record<string, unknown>;
}
function sess(p: Record<string, unknown>): Record<string, unknown> { return (p.session ?? {}) as Record<string, unknown>; }

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-status-'));
  broker = await startBrokerHost({ dataDir });
});
afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await broker.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('get_status — current-session identity', () => {
  it('active named session: reports the active name + state active + compatibilityId', async () => {
    const s = sid();
    const c = await conn('mcp', s);
    await c.request('register_session', baseReg(s, { requestedSessionName: 'status-active' }));
    const p = await status(c);
    expect(p.broker).toBe('connected');
    expect(p.compatibilityId).toBe(BUILD_ID); // xbus-p1-stp1-s6
    const se = sess(p);
    expect(se.sessionId).toBe(s);
    expect(se.sessionName).toBe('status-active');
    expect(se.sessionNameState).toBe('active');
    expect(se.cwd).toBe('/proj');
    expect(se.expired).toBe(false);
  });

  it('pending-name session: sessionName null, state pending', async () => {
    const owner = sid(); const collider = sid();
    const co = await conn('mcp', owner);
    await co.request('register_session', baseReg(owner, { requestedSessionName: 'contested' }));
    const cc = await conn('mcp', collider);
    await cc.request('register_session', baseReg(collider, { requestedSessionName: 'contested' })); // collision → pending
    const se = sess(await status(cc));
    expect(se.sessionNameState).toBe('pending');
    expect(se.sessionName).toBeNull();
  });

  it('unnamed session: sessionName null, state unnamed', async () => {
    const s = sid();
    const c = await conn('mcp', s);
    await c.request('register_session', baseReg(s)); // no requestedSessionName
    const se = sess(await status(c));
    expect(se.sessionNameState).toBe('unnamed');
    expect(se.sessionName).toBeNull();
  });

  it('rename is reflected immediately in status', async () => {
    const s = sid();
    const c = await conn('mcp', s);
    await c.request('register_session', baseReg(s, { requestedSessionName: 'before' }));
    expect(sess(await status(c)).sessionName).toBe('before');
    await c.request('rename_session', { name: 'after-rename' });
    const se = sess(await status(c));
    expect(se.sessionName).toBe('after-rename');
    expect(se.sessionNameState).toBe('active');
  });

  it('a status read does NOT refresh last_meaningful_activity_at', async () => {
    const s = sid();
    const c = await conn('mcp', s);
    await c.request('register_session', baseReg(s, { requestedSessionName: 'no-bump' }));
    const before = sess(await status(c)).lastMeaningfulActivityAt as string;
    expect(before).toBeTruthy();
    // several status reads must not move the activity clock (status is a pure read)
    await status(c); await status(c); await status(c);
    const after = sess(await status(c)).lastMeaningfulActivityAt as string;
    expect(after).toBe(before);
  });

  it('does NOT revive an expired session: reports expired + name null after the reaper', async () => {
    const s = sid();
    const c = await conn('mcp', s);
    await c.request('register_session', baseReg(s, { requestedSessionName: 'will-expire' }));
    // Force-expire the row directly (simulate the reaper's tombstone) — status must NOT undo it.
    const dbPath = path.join(dataDir, 'xbus.sqlite');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { openDatabase } = await import('../../src/database/connection.js');
    const db = openDatabase(dbPath, { applyPragmas: true });
    db.prepare(`UPDATE sessions SET expired_at='2026-01-01T00:00:00.000Z', expiration_reason='recipient_inactive_15_days', session_name_state='retired', normalized_session_name=NULL WHERE session_id=?`).run(s);
    db.close();
    const se = sess(await status(c));
    expect(se.expired).toBe(true);
    expect(se.sessionName).toBeNull();          // retired ⇒ no active name
    expect(se.sessionNameState).toBe('retired');
    // and the row is STILL expired (status did not revive it)
    const db2 = openDatabase(dbPath, { applyPragmas: true });
    const row = db2.prepare('SELECT expired_at AS e FROM sessions WHERE session_id=?').get(s) as { e: string | null };
    db2.close();
    expect(row.e).not.toBeNull();
  });

  it('caller cannot read ANOTHER session by spoofing an id in the request payload', async () => {
    const mine = sid(); const other = sid();
    const cOther = await conn('mcp', other);
    await cOther.request('register_session', baseReg(other, { requestedSessionName: 'someone-else' }));
    const cMine = await conn('mcp', mine);
    await cMine.request('register_session', baseReg(mine, { requestedSessionName: 'me' }));
    // Try to spoof: ask for the other session's id — status must ignore it and report MINE.
    const se = sess(await status(cMine, { sessionId: other }));
    expect(se.sessionId).toBe(mine);            // keyed by the authenticated connection, not the payload
    expect(se.sessionName).toBe('me');
    expect(se.sessionName).not.toBe('someone-else');
  });

  it('re-registration reflects the new epoch and current name', async () => {
    const s = sid();
    const c1 = await conn('mcp', s);
    const reg1 = await c1.request('register_session', baseReg(s, { requestedSessionName: 'epoch-a' }));
    const e1 = (reg1.payload as { epoch: number }).epoch;
    expect((sess(await status(c1)).epoch as number)).toBe(e1);
    // supersede from a new connection → new epoch, new name applied on the fresh lifecycle
    const c2 = await conn('mcp', s);
    const reg2 = await c2.request('register_session', baseReg(s, { requestedSessionName: 'epoch-b', supersede: true }));
    const e2 = (reg2.payload as { epoch: number }).epoch;
    expect(e2).toBeGreaterThan(e1);
    const se = sess(await status(c2));
    expect(se.epoch).toBe(e2);
    expect(se.sessionName).toBe('epoch-b');
  });

  it('status payload carries no message bodies, secrets, or evidence', async () => {
    const s = sid();
    const c = await conn('mcp', s);
    await c.request('register_session', baseReg(s, { requestedSessionName: 'clean-payload' }));
    const p = await status(c);
    const json = JSON.stringify(p);
    expect(json).not.toMatch(/secret|rootSecret|body_text|trustedEvidence|awardedSupport/i);
    // only the expected top-level keys
    expect(Object.keys(p).sort()).toEqual(['broker', 'brokerInstanceId', 'compatibilityId', 'session'].sort());
  });
});
