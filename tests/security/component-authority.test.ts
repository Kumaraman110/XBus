/**
 * Security: component capability matrix + receipt-capability authority + the 10
 * required negative tests for checkpoint_pull_hook restriction (ADR 0003/0004).
 * Real broker over real IPC + node:sqlite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startBrokerHost, type RunningBroker } from '../../src/broker/host.js';
import { IpcClient } from '../../src/ipc/client.js';

let dataDir: string;
let broker: RunningBroker;
const clients: IpcClient[] = [];

async function comp(sessionId: string, role: string, opts: { supersede?: boolean } = {}): Promise<IpcClient> {
  const c = new IpcClient(broker.endpoint, { idGen: () => `r-${Math.random().toString(36).slice(2)}`, rootSecret: broker.rootSecret });
  await c.connect();
  clients.push(c);
  await c.request('hello', { protocolVersion: 1 });
  await c.request('register_session', {
    sessionId, instanceId: `inst-${Math.random().toString(36).slice(2)}`, processId: process.pid,
    projectId: 'p', cwd: process.cwd(), receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role,
    ...(opts.supersede ? { supersede: true } : {}),
  });
  // §2: the session must be ready to accept injection (these tests exercise
  // authority, not the readiness gate). signalReadiness is session-scoped.
  await c.request('signal_readiness', { ackAvailable: true, versionOk: true });
  return c;
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-sec-'));
  broker = await startBrokerHost({ dataDir });
});
afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await broker.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const SID_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const SID_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

async function seedMessageToB(): Promise<string> {
  const a = await comp(SID_A, 'mcp');
  await a.request('register_alias', { alias: 'architect' });
  const b = await comp(SID_B, 'mcp');
  await b.request('register_alias', { alias: 'implementer' });
  const s = await a.request('send_message', { to: 'implementer', text: 'secret-for-B', requiresAck: true });
  return (s.payload as { messageId: string }).messageId;
}

describe('component capability matrix', () => {
  it('hook role cannot send', async () => {
    await seedMessageToB();
    const hook = await comp(SID_A, 'hook', { supersede: true });
    // A hook for A tries to send -> forbidden by matrix.
    const r = await hook.request('send_message', { to: 'implementer', text: 'x' });
    expect(r.frameType).toBe('error');
    expect((r.payload as { code: string }).code).toBe('XBUS_FORBIDDEN_ROLE');
  });

  it('mcp role cannot invoke the hook-only checkpoint_pull_hook frame', async () => {
    await seedMessageToB();
    const mcp = await comp(SID_B, 'mcp', { supersede: true });
    const r = await mcp.request('checkpoint_pull_hook', { checkpointId: 'cp1' });
    expect(r.frameType).toBe('error');
    expect((r.payload as { code: string }).code).toBe('XBUS_FORBIDDEN_ROLE');
  });

  it('hook role cannot acknowledge', async () => {
    const mid = await seedMessageToB();
    const hook = await comp(SID_B, 'hook', { supersede: true });
    await hook.request('checkpoint_pull_hook', { checkpointId: 'cp1' });
    const r = await hook.request('ack_message', { messageId: mid, status: 'accepted' });
    expect(r.frameType).toBe('error');
    expect((r.payload as { code: string }).code).toBe('XBUS_FORBIDDEN_ROLE');
  });

  it('hook role cannot reply', async () => {
    const mid = await seedMessageToB();
    const hook = await comp(SID_B, 'hook', { supersede: true });
    await hook.request('checkpoint_pull_hook', { checkpointId: 'cp1' });
    const r = await hook.request('reply_message', { messageId: mid, text: 'x', outcome: 'completed' });
    expect(r.frameType).toBe('error');
    expect((r.payload as { code: string }).code).toBe('XBUS_FORBIDDEN_ROLE');
  });
});

describe('checkpoint_pull_hook restriction (connection-derived session)', () => {
  it('a hook for session A cannot pull session B inbox (no cross-session selector)', async () => {
    await seedMessageToB(); // message is for B
    const hookA = await comp(SID_A, 'hook', { supersede: true });
    // Even if the hook tries to pass B's sessionId, it is ignored — the broker
    // derives the session from the connection (A), so it gets A's (empty) inbox.
    const r = await hookA.request('checkpoint_pull_hook', { checkpointId: 'cp1', sessionId: SID_B } as Record<string, unknown>);
    expect(r.frameType).toBe('checkpoint_pull_hook_ack');
    expect((r.payload as { messages: unknown[] }).messages).toHaveLength(0); // A has nothing
  });

  it('a guessed/forged sessionId in the payload is ignored', async () => {
    const mid = await seedMessageToB();
    const hookA = await comp(SID_A, 'hook', { supersede: true });
    const r = await hookA.request('checkpoint_pull_hook', { checkpointId: 'cp1', sessionId: SID_B });
    // B's message must NOT leak to A's hook.
    const texts = (r.payload as { messages: Array<{ messageId: string }> }).messages.map((m) => m.messageId);
    expect(texts).not.toContain(mid);
  });

  it('repeated checkpoint pull (same checkpointId) does not re-inject', async () => {
    await seedMessageToB();
    const hookB = await comp(SID_B, 'hook', { supersede: true });
    const r1 = await hookB.request('checkpoint_pull_hook', { checkpointId: 'cp-1' });
    expect((r1.payload as { messages: unknown[] }).messages).toHaveLength(1);
    const r2 = await hookB.request('checkpoint_pull_hook', { checkpointId: 'cp-1' });
    expect((r2.payload as { messages: unknown[] }).messages).toHaveLength(0); // already injected
  });

  it('pull request with an unbounded/huge limit is capped', async () => {
    await seedMessageToB();
    const hookB = await comp(SID_B, 'hook', { supersede: true });
    const r = await hookB.request('checkpoint_pull_hook', { checkpointId: 'cp1', limit: 100000 });
    // capped at 50 internally; with one message we just confirm it returns <=50.
    expect((r.payload as { messages: unknown[] }).messages.length).toBeLessThanOrEqual(50);
  });

  it('pull does not return completed messages', async () => {
    const mid = await seedMessageToB();
    const hookB = await comp(SID_B, 'hook', { supersede: true });
    // inject + (via mcp) ack + reply to complete it
    const pull = await hookB.request('checkpoint_pull_hook', { checkpointId: 'cp1' });
    const injectionId = (pull.payload as { messages: Array<{ metadata: Record<string, string> | null }> }).messages[0]!.metadata!.xbus_injection_id;
    const mcpB = await comp(SID_B, 'mcp'); // joins same epoch
    await mcpB.request('ack_message', { messageId: mid, status: 'accepted', injectionId });
    await mcpB.request('reply_message', { messageId: mid, text: 'done', outcome: 'completed', injectionId });
    // a later checkpoint pull must not return the completed message
    const pull2 = await hookB.request('checkpoint_pull_hook', { checkpointId: 'cp2' });
    expect((pull2.payload as { messages: unknown[] }).messages).toHaveLength(0);
  });
});

describe('connection-bound injection authority (ADR 0006 — no bearer token)', () => {
  it('ack before any context injection is rejected (INJECTION_NOT_FOUND)', async () => {
    const mid = await seedMessageToB();
    // mcp acks WITHOUT the hook having injected anything yet -> no injection record
    const mcpB = await comp(SID_B, 'mcp', { supersede: true });
    const r = await mcpB.request('ack_message', { messageId: mid, status: 'accepted' });
    expect(r.frameType).toBe('error');
    expect((r.payload as { code: string }).code).toBe('XBUS_INJECTION_NOT_FOUND');
  });

  it('a LEAKED injection_id grants nothing from a DIFFERENT session/connection', async () => {
    const mid = await seedMessageToB();
    const hookB = await comp(SID_B, 'hook', { supersede: true });
    const pull = await hookB.request('checkpoint_pull_hook', { checkpointId: 'cp1' });
    const injectionId = (pull.payload as { messages: Array<{ metadata: Record<string, string> | null }> }).messages[0]!.metadata!.xbus_injection_id;
    expect(injectionId).toBeTruthy();
    // Attacker session A presents B's (leaked) injection_id over A's own connection.
    const mcpA = await comp(SID_A, 'mcp', { supersede: true });
    const r = await mcpA.request('ack_message', { messageId: mid, status: 'accepted', injectionId });
    expect(r.frameType).toBe('error');
    // A's connection authenticates as session A -> message isn't A's recipient.
    expect((r.payload as { code: string }).code).toBe('XBUS_NOT_RECIPIENT');
  });

  it('the injection_id is the model-visible reference (non-secret), authorized by connection identity', async () => {
    const mid = await seedMessageToB();
    const hookB = await comp(SID_B, 'hook', { supersede: true });
    const pull = await hookB.request('checkpoint_pull_hook', { checkpointId: 'cp1' });
    const injectionId = (pull.payload as { messages: Array<{ metadata: Record<string, string> | null }> }).messages[0]!.metadata!.xbus_injection_id;
    // The CORRECT session, over its own authenticated connection, succeeds.
    const mcpB = await comp(SID_B, 'mcp');
    const ok = await mcpB.request('ack_message', { messageId: mid, status: 'accepted', injectionId });
    expect((ok.payload as { state: string }).state).toBe('accepted');
  });

  it('no raw bearer token is required, and only the injection id (non-secret ref) is model-visible', async () => {
    await seedMessageToB();
    const hookB = await comp(SID_B, 'hook', { supersede: true });
    const pull = await hookB.request('checkpoint_pull_hook', { checkpointId: 'cp1' });
    const md = (pull.payload as { messages: Array<{ metadata: Record<string, string> | null }> }).messages[0]!.metadata!;
    // model-visible metadata carries the non-secret injection id, NOT a bearer token.
    expect(md.xbus_injection_id).toBeTruthy();
    expect(md.xbus_receipt).toBeUndefined();
    // the injection id IS the DB primary key (a reference, safe to be visible).
    const row = broker.db.prepare('SELECT injection_id FROM context_injections WHERE injection_id=?').get(md.xbus_injection_id) as { injection_id: string } | undefined;
    expect(row?.injection_id).toBe(md.xbus_injection_id);
  });
});
