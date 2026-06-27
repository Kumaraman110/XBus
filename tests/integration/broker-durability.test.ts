/**
 * Integration: disconnect/reconnect (fencing) + broker restart (durability).
 * Real IPC + real node:sqlite. The broker is stopped/restarted against the same
 * on-disk database to prove queued messages survive and sequences don't reset.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerDaemon } from '../../src/broker/daemon.js';
import { IpcClient } from '../../src/ipc/client.js';
import { defaultEndpoint, ensureDataDir } from '../../src/ipc/transport.js';
import { systemClock, uuidIdGen } from '../../src/shared/clock.js';

let dataDir: string;
let dbPath: string;
let endpoint: string;

function openDb() {
  return openDatabase(dbPath, { applyPragmas: true });
}

async function startBroker(db: ReturnType<typeof openDatabase>, brokerId: string): Promise<BrokerDaemon> {
  const d = new BrokerDaemon(db, endpoint, systemClock, uuidIdGen, brokerId, {});
  await d.start();
  return d;
}

async function client(): Promise<IpcClient> {
  const c = new IpcClient(endpoint, { idGen: () => `req-${Math.random().toString(36).slice(2)}` });
  await c.connect();
  return c;
}

async function register(c: IpcClient, sessionId: string, instanceId: string, cwd: string, opts: { supersede?: boolean } = {}): Promise<void> {
  await c.request('hello', { protocolVersion: 1 });
  await c.request('register_session', {
    sessionId, instanceId, processId: process.pid, projectId: `proj-${path.basename(cwd)}`,
    cwd, receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp',
    ...(opts.supersede ? { supersede: true } : {}),
  });
  // §2: register lands in `initializing`; signal readiness so the session can take
  // delivery. A supersede resets readiness too, so this re-arms the new epoch.
  await c.request('signal_readiness', { ackAvailable: true, versionOk: true });
}

/** Read one inbox message + its receipt (in-context delivery path). */
async function inboxOne(c: IpcClient): Promise<{ messageId: string; receipt: string } | null> {
  const r = await c.request('inbox', { limit: 10 });
  const msgs = (r.payload as { messages: Array<{ messageId: string; metadata: Record<string, string> | null }> }).messages;
  if (msgs.length === 0) return null;
  return { messageId: msgs[0]!.messageId, receipt: msgs[0]!.injectionId as string };
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-dur-'));
  ensureDataDir(dataDir);
  dbPath = path.join(dataDir, 'xbus.sqlite');
  endpoint = defaultEndpoint(dataDir);
});

afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('durability + fencing', () => {
  it('Test3: disconnected receiver, reconnect as new generation, old instance fenced', async () => {
    const db = openDb();
    runMigrations(db, systemClock.nowIso());
    let daemon = await startBroker(db, 'broker-1');

    const A = await client();
    const B1 = await client();
    const sidA = 'aaaaaaaa-0000-0000-0000-000000000001';
    const sidB = 'bbbbbbbb-0000-0000-0000-000000000002';
    await register(A, sidA, 'instA-1', '/tmp/a');
    await register(B1, sidB, 'instB-1', '/tmp/b');
    await A.request('register_alias', { alias: 'architect' });
    await B1.request('register_alias', { alias: 'implementer' });

    // Capture B1's authority by registering; then disconnect B1.
    B1.close();
    await new Promise((r) => setTimeout(r, 100));

    // A sends while B disconnected -> durable queued.
    const s = await A.request('send_message', { to: 'implementer', text: 'while-disconnected', requiresAck: true });
    const messageId = (s.payload as { messageId: string; state: string }).messageId;
    expect((s.payload as { state: string }).state).toBe('queued_until_checkpoint');
    const d1 = db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(messageId) as { state: string };
    expect(d1.state).toBe('queued');

    // B reopens as a genuine session replacement (the old process is gone) ->
    // supersede advances the epoch (ADR 0003: a TRUE replacement, not a mere
    // component reconnect).
    const B2 = await client();
    await register(B2, sidB, 'instB-2', '/tmp/b', { supersede: true });
    const epochRow = db.prepare('SELECT active_epoch FROM sessions WHERE session_id=?').get(sidB) as { active_epoch: number };
    expect(epochRow.active_epoch).toBe(2); // epoch advanced on supersede

    // New epoch receives the queued message at its checkpoint (in-context read).
    const pulled = await inboxOne(B2);
    expect(pulled?.messageId).toBe(messageId);

    // New epoch can ack it (with the freshly-issued receipt).
    const ack = await B2.request('ack_message', { messageId, status: 'accepted', injectionId: pulled!.receipt });
    expect((ack.payload as { state: string }).state).toBe('accepted');

    A.close(); B2.close();
    await daemon.stop();
    db.close();
  });

  it('Test4: broker restart preserves queued messages + does not reset sequence', async () => {
    // ---- broker instance 1 ----
    let db = openDb();
    runMigrations(db, systemClock.nowIso());
    let daemon = await startBroker(db, 'broker-1');

    const A1 = await client();
    const B1 = await client();
    const sidA = 'aaaaaaaa-0000-0000-0000-0000000000a1';
    const sidB = 'bbbbbbbb-0000-0000-0000-0000000000b1';
    await register(A1, sidA, 'instA-1', '/tmp/a');
    await register(B1, sidB, 'instB-1', '/tmp/b');
    await A1.request('register_alias', { alias: 'architect' });
    await B1.request('register_alias', { alias: 'implementer' });

    // Send two messages so we can prove the sequence counter persists.
    const s1 = await A1.request('send_message', { to: 'implementer', text: 'msg-1', requiresAck: true });
    const s2 = await A1.request('send_message', { to: 'implementer', text: 'msg-2', requiresAck: true });
    expect((s1.payload as { sequence: number }).sequence).toBe(1);
    expect((s2.payload as { sequence: number }).sequence).toBe(2);
    const mid1 = (s1.payload as { messageId: string }).messageId;

    // ---- stop broker (after commit), close db, restart against same file ----
    A1.close(); B1.close();
    await daemon.stop();
    db.close();

    db = openDb();
    const mig = runMigrations(db, systemClock.nowIso()); // idempotent; no new migrations
    expect(mig.appliedNow).toHaveLength(0);
    daemon = await startBroker(db, 'broker-2');

    // Reconnect sessions.
    const A2 = await client();
    const B2 = await client();
    await register(A2, sidA, 'instA-2', '/tmp/a');
    await register(B2, sidB, 'instB-2', '/tmp/b');

    // Queued messages survived.
    const pull = await B2.request('checkpoint_pull', { limit: 10 });
    const texts = (pull.payload as { messages: Array<{ text: string }> }).messages.map((m) => m.text);
    expect(texts).toContain('msg-1');
    expect(texts).toContain('msg-2');

    // Sequence did NOT reset: a new send gets sequence 3.
    const s3 = await A2.request('send_message', { to: 'implementer', text: 'msg-3', requiresAck: true });
    expect((s3.payload as { sequence: number }).sequence).toBe(3);

    // No message loss.
    const count = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE recipient_session_id=?').get(sidB) as { n: number };
    expect(count.n).toBe(3);
    expect(mid1).toBeTruthy();

    A2.close(); B2.close();
    await daemon.stop();
    db.close();
  });
});
