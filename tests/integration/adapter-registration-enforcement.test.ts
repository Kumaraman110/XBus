/**
 * Integration: the broker-side adapter registration enforcement + trust boundary,
 * exercised through the REAL onRegister path (not the pure function in isolation).
 *
 * Proves: legacy beta.2 registration is unchanged; an adapter-aware registration
 * cannot self-award (no broker evidence ⇒ rejected / unvalidated); broker-OWNED
 * evidence (recorded by broker code, never the frame) yields an award; the award is
 * surfaced in the ack only for adapter-aware registrations; and a stale award never
 * survives a re-registration.
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

let dataDir: string;
let broker: RunningBroker;
const clients: IpcClient[] = [];

async function conn(role = 'mcp'): Promise<IpcClient> {
  const c = new IpcClient(broker.endpoint, { requestTimeoutMs: 3000, rootSecret: broker.rootSecret });
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
let sessionSeq = 0;
const baseReg = (over: Record<string, unknown> = {}) => ({
  sessionId: 's-' + (++sessionSeq), instanceId: 'i', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: [], role: 'mcp', ...over,
});

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-are-'));
  broker = await startBrokerHost({ dataDir });
});
afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await broker.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('adapter registration enforcement (real broker path)', () => {
  it('LEGACY: a beta.2-style registration (no adapter metadata) succeeds and the ack carries NO awardedSupport', async () => {
    const c = await conn('hook');
    const ack = await c.request('register_session', baseReg({ sessionId: 'legacy-1', role: 'hook' }));
    expect(ack.frameType).toBe('register_session_ack');
    expect((ack.payload as Record<string, unknown>).awardedSupport).toBeUndefined();
  });

  it('ADAPTER-AWARE without broker evidence is REJECTED (no self-award)', async () => {
    const c = await conn('hook');
    // declares everything verified, but the broker has recorded NO evidence
    const lying = emptyCapabilities();
    lying.receive.lifecycleCheckpoint = 'verified'; lying.messaging.acknowledgements = 'verified'; lying.messaging.correlatedReplies = 'verified';
    const ack = await c.request('register_session', baseReg({
      sessionId: 'aware-noevd', role: 'hook',
      adapterRegistration: { adapterId: 'x', adapterVersion: '1', role: 'hook', declaredCapabilities: lying },
    }));
    expect(ack.frameType).toBe('error');
    expect((ack.payload as { message?: string }).message).toMatch(/no broker-owned evidence|not verified/);
  });

  it('ADAPTER-AWARE WITH broker-owned evidence is awarded T3/conformance_tested in the ack', async () => {
    broker.daemon.recordTrustedEvidence(checkpointEvidence('good', ComponentRole.HOOK));
    const c = await conn('hook');
    const ack = await c.request('register_session', baseReg({
      sessionId: 'aware-ok', role: 'hook',
      adapterRegistration: { adapterId: 'good', adapterVersion: '1', role: 'hook', declaredCapabilities: declaredCheckpointCaps() },
    }));
    expect(ack.frameType).toBe('register_session_ack');
    const award = (ack.payload as { awardedSupport?: { maximumDeliveryTier: string; validationLevel: string } }).awardedSupport;
    expect(award?.maximumDeliveryTier).toBe('T3');
    expect(award?.validationLevel).toBe('conformance_tested');
  });

  it('ROLE MISMATCH: declared role != authenticated role is rejected', async () => {
    broker.daemon.recordTrustedEvidence(checkpointEvidence('rm', ComponentRole.MCP));
    const c = await conn('mcp'); // authenticated as mcp
    const ack = await c.request('register_session', baseReg({
      sessionId: 'rolemismatch', role: 'mcp',
      adapterRegistration: { adapterId: 'rm', adapterVersion: '1', role: 'hook', declaredCapabilities: declaredCheckpointCaps() }, // declares hook
    }));
    expect(ack.frameType).toBe('error');
    expect((ack.payload as { message?: string }).message).toMatch(/authenticated as role/);
  });

  it('STALE AWARD: adapter-aware (awarded) → legacy re-register on the SAME connection leaves no award', async () => {
    broker.daemon.recordTrustedEvidence(checkpointEvidence('stale', ComponentRole.HOOK));
    const c = await conn('hook');
    // 1) adapter-aware register ⇒ awarded
    const a1 = await c.request('register_session', baseReg({
      sessionId: 'stale-s', role: 'hook',
      adapterRegistration: { adapterId: 'stale', adapterVersion: '1', role: 'hook', declaredCapabilities: declaredCheckpointCaps() },
    }));
    expect((a1.payload as { awardedSupport?: unknown }).awardedSupport).toBeDefined();
    // 2) legacy re-register on the SAME connection ⇒ ack carries NO award (stale cleared)
    const a2 = await c.request('register_session', baseReg({ sessionId: 'stale-s', role: 'hook', supersede: true }));
    expect(a2.frameType).toBe('register_session_ack');
    expect((a2.payload as { awardedSupport?: unknown }).awardedSupport).toBeUndefined();
  });

  it('STALE AWARD: adapter-aware (awarded) → FAILED re-register leaves no award (cleared at attempt start)', async () => {
    broker.daemon.recordTrustedEvidence(checkpointEvidence('stale2', ComponentRole.HOOK));
    const c = await conn('hook');
    const a1 = await c.request('register_session', baseReg({
      sessionId: 'stale2-s', role: 'hook',
      adapterRegistration: { adapterId: 'stale2', adapterVersion: '1', role: 'hook', declaredCapabilities: declaredCheckpointCaps() },
    }));
    expect((a1.payload as { awardedSupport?: unknown }).awardedSupport).toBeDefined();
    // a second adapter-aware register that over-claims (no evidence for this id) ⇒ error;
    // the prior award must already have been cleared at the start of this attempt.
    const a2 = await c.request('register_session', baseReg({
      sessionId: 'stale2-s', role: 'hook', supersede: true,
      adapterRegistration: { adapterId: 'unknown-id', adapterVersion: '1', role: 'hook', declaredCapabilities: declaredCheckpointCaps() },
    }));
    expect(a2.frameType).toBe('error');
    // a subsequent legacy register confirms no stale award lingers
    const a3 = await c.request('register_session', baseReg({ sessionId: 'stale2-s', role: 'hook', supersede: true }));
    expect((a3.payload as { awardedSupport?: unknown }).awardedSupport).toBeUndefined();
  });
});
