/**
 * BETA.10 WS4 — adapter-boundary conformance. Proves the AgenTel CORE (identity, delivery, reclaim,
 * restart, reply) works through a HOST-NEUTRAL SessionIdentitySource — the FakeAdapter — with NO
 * Claude-specific identifier anywhere. Session ids come from the adapter (arbitrary non-Claude
 * strings); the broker never reads CLAUDE_CODE_SESSION_ID or ~/.claude here. Plus adapter
 * failure/disconnect/reconnect behavior. This is the seam that makes a future non-Claude host
 * (e.g. Codex) trivial + testable — NO Codex production support is claimed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority } from '../../src/broker/store.js';
import { DeliveryOps } from '../../src/broker/delivery.js';
import { FakeAdapter, ClaudeCodeAdapter, type SessionIdentitySource } from '../../src/adapter/session-identity.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let delivery: DeliveryOps; let clock: FakeClock;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-adapter-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  const ids = new SeqIdGen('m');
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, ids, 'b');
  delivery = new DeliveryOps(db, clock, ids, 5 * 60_000, undefined, { requireReceipt: true });
});
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

/** Register a session using an adapter-resolved id — NO Claude identifier involved. */
function regVia(adapter: SessionIdentitySource, name?: string, secret?: string): SessionAuthority {
  const sessionId = adapter.resolveSessionId();
  if (!sessionId) throw new Error('adapter returned no session id');
  const auth = store.register({ sessionId, instanceId: 'i', connectionId: `c-${sessionId}`, processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', ...(name ? { requestedSessionName: name } : {}), ...(secret ? { ownerSecret: secret } : {}) });
  store.signalReadiness(auth, { ackAvailable: true, versionOk: true });
  return auth;
}
function hookAuth(a: SessionAuthority): SessionAuthority { return { ...a, role: 'hook' as never }; }
function allocSeq(rsid: string): number {
  const row = db.prepare('SELECT next_sequence FROM recipient_sequences WHERE recipient_session_id=?').get(rsid) as { next_sequence: number } | undefined;
  const seq = row ? row.next_sequence : 1;
  db.prepare('INSERT OR REPLACE INTO recipient_sequences (recipient_session_id, next_sequence) VALUES (?, ?)').run(rsid, seq + 1);
  return seq;
}

describe('WS4 adapter conformance — core works host-neutrally (no Claude identifiers)', () => {
  it('IDENTITY: a session registers via a non-Claude adapter id + holds a name', () => {
    // A deliberately non-Claude-shaped id (not a CC uuid; a host-agnostic token).
    const adapter = new FakeAdapter('host-neutral-agent-alpha-0001');
    const a = regVia(adapter, 'worker');
    expect(a.sessionId).toBe('host-neutral-agent-alpha-0001');
    expect(a.awardedSessionName).toBe('worker');
    expect(a.logicalIdentityId).toBe(a.sessionId);
  });

  it('DELIVERY + REPLY: send → inject → ack → reply, all via adapter ids', () => {
    const sender = regVia(new FakeAdapter('neutral-sender-0002'), 'ops');
    const recipient = regVia(new FakeAdapter('neutral-recipient-0003'), 'worker');
    const messageId = store.send(sender, { to: 'worker', text: 'do it', kind: 'request', requiresAck: true, requiresReply: true }).messageId;
    delivery.checkpointPull(hookAuth(recipient), 'cp', 10);
    expect(delivery.ack(recipient, { messageId, status: 'accepted' }).state).toBe('accepted');
    const r = delivery.reply(recipient, { messageId, text: 'done', outcome: 'completed' }, allocSeq);
    expect(r.replyMessageId).toBeTruthy();
    expect((db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(messageId) as { state: string }).state).toBe('completed');
  });

  it('RECLAIM: a successor under a NEW adapter id reclaims the identity + inbox with the secret', () => {
    const a = regVia(new FakeAdapter('neutral-A-0004'), 'reclaimable');
    const secret = a.ownerSecret!;
    const sender = regVia(new FakeAdapter('neutral-snd-0005'), 'snd');
    store.send(sender, { to: 'reclaimable', text: 'queued', kind: 'request', requiresAck: true, requiresReply: true });
    db.prepare(`UPDATE sessions SET state='disconnected' WHERE session_id=?`).run(a.sessionId);
    db.prepare(`UPDATE component_instances SET state='closed' WHERE session_id=?`).run(a.sessionId);
    const b = regVia(new FakeAdapter('neutral-B-0006'), 'reclaimable', secret);
    expect(b.sessionId, 'successor redirected onto the canonical identity').toBe(a.sessionId);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE recipient_session_id=?`).get(a.sessionId) as { n: number }).n).toBe(1);
  });

  it('DISCONNECT/RECONNECT: adapter reports absent then a new id (reconnect starts fresh, not redirected)', () => {
    const adapter = new FakeAdapter('neutral-live-0007');
    regVia(adapter, 'svc');
    // host disconnects → adapter reports no id → resolveSessionId(fallback) uses the fallback.
    adapter.setSessionId(null);
    expect(adapter.resolveSessionId('fallback-id')).toBe('fallback-id');
    expect(adapter.resolveSessionId()).toBeNull(); // no fallback → null (never invents)
    // reconnect under a NEW id, no secret → its own fresh identity (not redirected onto the old).
    adapter.setSessionId('neutral-reconnect-0008');
    const fresh = regVia(adapter);
    expect(fresh.sessionId).toBe('neutral-reconnect-0008');
    expect(fresh.logicalIdentityId).toBe('neutral-reconnect-0008'); // own identity
  });

  it('ADAPTER FAILURE: a null/absent session id is surfaced (never invented) — caller decides fatality', () => {
    const broken = new FakeAdapter(null);
    expect(broken.resolveSessionId()).toBeNull();
    expect(() => regVia(broken)).toThrow(); // the caller (here) treats absent id as fatal
  });
});

describe('WS4 adapter — ClaudeCodeAdapter reads Claude env at the EDGE only (injectable)', () => {
  it('reads CLAUDE_CODE_SESSION_ID + falls back + never invents', () => {
    const cc = new ClaudeCodeAdapter({ CLAUDE_CODE_SESSION_ID: 'cc-uuid-xyz' } as NodeJS.ProcessEnv);
    expect(cc.resolveSessionId()).toBe('cc-uuid-xyz');
    expect(cc.hostKind).toBe('claude-code');
    expect(cc.canWake).toBe(true);
    const empty = new ClaudeCodeAdapter({} as NodeJS.ProcessEnv);
    expect(empty.resolveSessionId()).toBeNull();
    expect(empty.resolveSessionId('stdin-fallback')).toBe('stdin-fallback');
  });
  it('transcriptsRoot honors the override env (no hard-coded home dependency in tests)', () => {
    const cc = new ClaudeCodeAdapter({ XBUS_CLAUDE_PROJECTS_DIR: '/tmp/custom-projects' } as NodeJS.ProcessEnv);
    expect(cc.transcriptsRoot()).toBe('/tmp/custom-projects');
  });
});
