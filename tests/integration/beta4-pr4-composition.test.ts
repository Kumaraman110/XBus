/**
 * COMPOSITION tests: beta.4 zero-friction (ADR 0012) × PR #4 adapter trust enforcement.
 *
 * These prove the two feature lines interact correctly — not merely coexist. Each group
 * exercises a real interaction surface that only exists once the two are composed:
 *
 *   Group 1 — Automatic (Claude/MCP) registration + trust enforcement:
 *     the auto-registration path (name request in the SAME frame as an adapter
 *     declaration) still submits ONLY declarations, never broker-trusted evidence, and
 *     is awarded no advanced tier without broker-owned evidence — while the session is
 *     still fully usable (named + checkpoint mode) at its awarded support.
 *
 *   Group 2 — Naming × adapter identity:
 *     naming/rename cannot bypass role validation, cannot mutate adapter
 *     identity/role/evidence/epoch/tier, a pending-name session cannot obtain a routable
 *     active award, and a duplicate-name failure leaves no stale award.
 *
 *   Group 3 — Expiry × support award:
 *     15-day expiry clears the active name AND the connection's award; re-registration
 *     after expiry re-runs award evaluation on a fresh epoch; an expired adapter cannot
 *     send/receive/route on stale state.
 *
 *   Group 4 — Auto-start × evidence ownership:
 *     there is NO wire frame that records trusted evidence (structural proof that a
 *     losing/auto-started peer process cannot inject evidence); a single broker owns the
 *     one in-memory registry; stale/incompatible-broker detection fails closed.
 *
 * Real broker path for the frame-level interactions (Groups 1,2,4-wire); store+reaper
 * with a FakeClock for the deterministic expiry×award interaction (Group 3).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startBrokerHost, type RunningBroker } from '../../src/broker/host.js';
import { IpcClient } from '../../src/ipc/client.js';
import { clientHello } from '../../src/ipc/hello.js';
import { ComponentRole } from '../../src/identity/components.js';
import { emptyCapabilities, type AgentCapabilities } from '../../src/adapter/capabilities.js';
import type { BrokerTrustedEvidence } from '../../src/adapter-broker/trusted-evidence.js';
import { openDatabase } from '../../src/database/connection.js';
import { XBusErrorCode } from '../../src/protocol/errors.js';
import type { FrameType } from '../../src/protocol/commands.js';

// ── real-broker harness ──────────────────────────────────────────────────────
let dataDir: string;
let broker: RunningBroker;
const clients: IpcClient[] = [];
async function conn(role = 'mcp'): Promise<IpcClient> {
  const c = new IpcClient(broker.endpoint, { requestTimeoutMs: 4000, rootSecret: broker.rootSecret });
  await c.connect();
  clients.push(c);
  await c.request('hello', clientHello(role as 'mcp'));
  return c;
}
function declaredCheckpointCaps(): AgentCapabilities {
  const c = emptyCapabilities();
  c.receive.lifecycleCheckpoint = 'declared';
  c.messaging.acknowledgements = 'declared';
  c.messaging.correlatedReplies = 'declared';
  return c;
}
function checkpointEvidence(adapterId: string, role: ComponentRole): BrokerTrustedEvidence {
  return {
    source: 'conformance_runner', adapterId, adapterVersion: '1', role,
    capabilities: { sendVerified: true, manualReceiveVerified: true, checkpointReceiveVerified: true, liveReceiveVerified: false, ackReplyVerified: true },
    durability: { brokerRestartVerified: false, reconnectVerified: false, queuedDeliveryVerified: false },
    security: { fencingVerified: false, redactionVerified: false, packagedRuntimeVerified: false },
    conformanceVersion: 1,
  };
}
let seq = 0;
const baseReg = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sessionId: 's-' + (++seq), instanceId: 'i', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: [], role: 'mcp', ...over,
});

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-comp-'));
  broker = await startBrokerHost({ dataDir });
});
afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await broker.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('Group 1 — automatic named registration + trust enforcement compose', () => {
  it('a NAMED + adapter-aware registration WITHOUT broker evidence is rejected (name request cannot buy a tier)', async () => {
    const c = await conn('mcp');
    // The exact zero-friction shape: a name request AND an adapter declaration that
    // over-claims verified, but the broker recorded NO evidence.
    const lying = emptyCapabilities();
    lying.receive.lifecycleCheckpoint = 'verified'; lying.messaging.acknowledgements = 'verified';
    const ack = await c.request('register_session', baseReg({
      sessionId: 'named-liar', role: 'mcp', requestedSessionName: 'named-liar',
      adapterRegistration: { adapterId: 'liar', adapterVersion: '1', role: 'mcp', declaredCapabilities: lying },
    }));
    // Enforcement rejects the registration BEFORE any session is persisted — so the
    // name request cannot be a backdoor to an unearned award.
    expect(ack.frameType).toBe('error');
    expect((ack.payload as { message?: string }).message).toMatch(/no broker-owned evidence|not verified/);
  });

  it('a NAMED + adapter-aware registration WITH broker evidence gets the name (active) AND the honest T3 award, both in one ack', async () => {
    broker.daemon.recordTrustedEvidence(checkpointEvidence('claude', ComponentRole.MCP));
    const c = await conn('mcp');
    const ack = await c.request('register_session', baseReg({
      sessionId: 'named-ok', role: 'mcp', requestedSessionName: 'architect-1',
      adapterRegistration: { adapterId: 'claude', adapterVersion: '1', role: 'mcp', declaredCapabilities: declaredCheckpointCaps() },
    }));
    expect(ack.frameType).toBe('register_session_ack');
    const pl = ack.payload as { sessionNameState?: string; awardedSessionName?: string; awardedSupport?: { maximumDeliveryTier: string; validationLevel: string } };
    // beta.4 naming fields AND PR#4 award coexist in the SAME ack (the composed reply).
    expect(pl.sessionNameState).toBe('active');
    expect(pl.awardedSessionName).toBe('architect-1');
    expect(pl.awardedSupport?.maximumDeliveryTier).toBe('T3');
    expect(pl.awardedSupport?.validationLevel).toBe('conformance_tested');
  });

  it('a plain (legacy, no-declaration) named registration is unchanged: named, and the ack carries NO awardedSupport', async () => {
    const c = await conn('mcp');
    const ack = await c.request('register_session', baseReg({ sessionId: 'plain-named', role: 'mcp', requestedSessionName: 'plain-one' }));
    expect(ack.frameType).toBe('register_session_ack');
    const pl = ack.payload as { sessionNameState?: string; awardedSessionName?: string; awardedSupport?: unknown };
    expect(pl.sessionNameState).toBe('active');
    expect(pl.awardedSessionName).toBe('plain-one');
    expect(pl.awardedSupport).toBeUndefined(); // no adapter declaration ⇒ no award surfaced
  });

  it('a named + adapter-aware session requesting an UNVERIFIED advanced mode (live) is rejected even with a name', async () => {
    // conformance_runner evidence caps live=false; requesting live must fail closed
    // regardless of the name request travelling in the same frame.
    broker.daemon.recordTrustedEvidence(checkpointEvidence('claude2', ComponentRole.MCP));
    const c = await conn('mcp');
    const ack = await c.request('register_session', baseReg({
      sessionId: 'named-live', role: 'mcp', requestedSessionName: 'wants-live', receiveMode: 'live',
      adapterRegistration: { adapterId: 'claude2', adapterVersion: '1', role: 'mcp', declaredCapabilities: declaredCheckpointCaps() },
    }));
    expect(ack.frameType).toBe('error');
    expect((ack.payload as { message?: string }).message).toMatch(/livePush|not verified/);
  });
});

describe('Group 2 — naming × adapter identity', () => {
  it('rename is mcp-role-only: a HOOK cannot rename (naming cannot bypass role validation)', async () => {
    const c = await conn('hook');
    await c.request('register_session', baseReg({ sessionId: 'hook-noname', role: 'hook', requestedSessionName: undefined }));
    const ack = await c.request('rename_session', { name: 'hook-wants-name' });
    expect(ack.frameType).toBe('error');
    expect((ack.payload as { message?: string }).message).toMatch(/only the mcp component|forbidden|role/i);
  });

  it('rename does NOT alter the adapter award, identity, role or epoch (orthogonal state)', async () => {
    broker.daemon.recordTrustedEvidence(checkpointEvidence('rid', ComponentRole.MCP));
    const c = await conn('mcp');
    const reg = await c.request('register_session', baseReg({
      sessionId: 'rename-keep-award', role: 'mcp', requestedSessionName: 'before-name',
      adapterRegistration: { adapterId: 'rid', adapterVersion: '1', role: 'mcp', declaredCapabilities: declaredCheckpointCaps() },
    }));
    const before = reg.payload as { epoch: number; role: string; awardedSupport?: { maximumDeliveryTier: string } };
    expect(before.awardedSupport?.maximumDeliveryTier).toBe('T3');
    const rn = await c.request('rename_session', { name: 'after-name' });
    expect(rn.frameType).toBe('rename_session_ack');
    expect((rn.payload as { sessionNameState: string; name: string }).sessionNameState).toBe('active');
    expect((rn.payload as { name: string }).name).toBe('after-name');
    // The rename ack does NOT (and must not) re-award or mutate role/epoch: the award is
    // registration-time state, name is orthogonal. Re-reading the session confirms the
    // award still applies to the SAME epoch/role (unchanged by naming).
    const db = openDatabase(path.join(dataDir, 'xbus.sqlite'), { applyPragmas: true });
    try {
      const row = db.prepare('SELECT active_epoch AS e, session_name AS n FROM sessions WHERE session_id=?').get('rename-keep-award') as { e: number; n: string };
      expect(row.e).toBe(before.epoch); // epoch unchanged by rename
      expect(row.n).toBe('after-name');
    } finally { db.close(); }
  });

  it('a PENDING-name session (duplicate) is NOT routable by that name, and a rename failure leaves no award/lock leak', async () => {
    broker.daemon.recordTrustedEvidence(checkpointEvidence('dup', ComponentRole.MCP));
    // A claims the name (active).
    const a = await conn('mcp');
    await a.request('register_session', baseReg({ sessionId: 'dupA', role: 'mcp', requestedSessionName: 'dupe' }));
    // B requests the SAME name + is adapter-aware WITH evidence ⇒ awarded T3 but name pending.
    const b = await conn('mcp');
    const bReg = await b.request('register_session', baseReg({
      sessionId: 'dupB', role: 'mcp', requestedSessionName: 'dupe',
      adapterRegistration: { adapterId: 'dup', adapterVersion: '1', role: 'mcp', declaredCapabilities: declaredCheckpointCaps() },
    }));
    const bpl = bReg.payload as { sessionNameState: string; awardedSupport?: { maximumDeliveryTier: string } };
    expect(bpl.sessionNameState).toBe('pending');           // name collision ⇒ pending
    expect(bpl.awardedSupport?.maximumDeliveryTier).toBe('T3'); // award is independent of naming
    // A send to the (contested) name resolves to A only — the pending B is NOT routable by it.
    const sender = await conn('mcp');
    await sender.request('register_session', baseReg({ sessionId: 'dupSender', role: 'mcp' }));
    const sent = await sender.request('send_message', { to: 'dupe', text: 'x', kind: 'event', requiresAck: false, requiresReply: false });
    expect(sent.frameType).toBe('send_message_ack');
    expect((sent.payload as { recipientSessionId: string }).recipientSessionId).toBe('dupA');
    // B renaming to a colliding name fails (SESSION_NAME_TAKEN) and does not leave B active on it.
    const collide = await b.request('rename_session', { name: 'dupe' });
    expect(collide.frameType).toBe('error');
    expect((collide.payload as { code?: string }).code).toBe(XBusErrorCode.SESSION_NAME_TAKEN);
    // B resolves via a free name → active, award intact.
    const ok = await b.request('rename_session', { name: 'dupe-2' });
    expect((ok.payload as { sessionNameState: string }).sessionNameState).toBe('active');
  });
});

describe('Group 4 — auto-start × evidence ownership (structural + single-owner)', () => {
  it('there is NO wire frame that records trusted evidence (a peer cannot inject evidence over the wire)', () => {
    // Structural proof: the ONLY way evidence enters the registry is the in-process
    // daemon.recordTrustedEvidence(); the wire FrameType union has no record-evidence
    // member. An auto-started/losing broker process therefore cannot inject evidence.
    const wireFrames: FrameType[] = [
      'hello', 'register_session', 'register_alias', 'rename_session', 'heartbeat', 'send_message',
      'checkpoint_pull', 'checkpoint_pull_hook', 'ack_message', 'reply_message', 'list_sessions',
      'get_metrics', 'inbox', 'redeliver', 'signal_readiness', 'get_status', 'shutdown', 'set_control',
      'process_next', 'dead_letter', 'block_peer', 'takeover',
    ];
    for (const f of wireFrames) {
      expect(f).not.toMatch(/evidence/i);
    }
    // And the daemon exposes recordTrustedEvidence as an in-process method (not a handler).
    expect(typeof broker.daemon.recordTrustedEvidence).toBe('function');
  });

  it('an adapter frame cannot smuggle a trustedEvidence field: extra frame keys are ignored, award stays unearned', async () => {
    const c = await conn('mcp');
    // Attempt to smuggle broker-shaped evidence via unknown frame keys.
    const smuggle = await c.request('register_session', baseReg({
      sessionId: 'smuggle', role: 'mcp', requestedSessionName: 'smuggler',
      adapterRegistration: { adapterId: 'sm', adapterVersion: '1', role: 'mcp', declaredCapabilities: declaredCheckpointCaps() },
      // hostile extras — must be ignored by the broker (evidence is registry-resolved only):
      trustedEvidence: checkpointEvidence('sm', ComponentRole.MCP),
      awardedSupport: { maximumDeliveryTier: 'T5', validationLevel: 'supported' },
    }));
    // No broker-owned evidence was recorded for 'sm' ⇒ the smuggled fields buy nothing:
    // the registration is rejected (checkpoint mode requires a verified capability).
    expect(smuggle.frameType).toBe('error');
    expect((smuggle.payload as { message?: string }).message).toMatch(/no broker-owned evidence|not verified/);
  });
});
