/**
 * §3 — prove NO privileged plaintext fallback remains, and §12 migration safety.
 * A secure broker must reject a plaintext client before any registration/inbox/
 * diagnostic disclosure; an unauthenticated client must learn nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { startBrokerHost, type RunningBroker } from '../../src/broker/host.js';
import { IpcClient } from '../../src/ipc/client.js';
import { encodeFrame, FrameDecoder } from '../../src/ipc/framing.js';
import { generateRootSecret } from '../../src/ipc/secure-channel.js';

let broker: RunningBroker;
const dirs: string[] = [];
function freshDir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-np-')); dirs.push(d); return d; }

afterEach(async () => {
  try { await broker?.stop(); } catch { /* ignore */ }
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  dirs.length = 0;
});

/** Raw socket helper: connect, send a frame, collect any reply, report close. */
function rawProbe(endpoint: string, frame: unknown, waitMs = 1500): Promise<{ gotReply: boolean; closed: boolean; replyHadSession: boolean }> {
  return new Promise((resolve) => {
    const sock = net.createConnection(endpoint);
    const dec = new FrameDecoder();
    let gotReply = false, closed = false, replyHadSession = false;
    const finish = () => { try { sock.destroy(); } catch { /* ignore */ } resolve({ gotReply, closed, replyHadSession }); };
    const t = setTimeout(finish, waitMs);
    sock.on('connect', () => sock.write(encodeFrame(frame)));
    sock.on('data', (c: Buffer) => {
      try { const r = dec.push(c); if (r.frames.length) { gotReply = true; if (JSON.stringify(r.frames).match(/session|alias|implementer|architect/i)) replyHadSession = true; } } catch { /* ignore */ }
    });
    sock.on('close', () => { closed = true; clearTimeout(t); finish(); });
    sock.on('error', () => { closed = true; clearTimeout(t); finish(); });
  });
}

describe('no privileged plaintext fallback (§3)', () => {
  it('a plaintext register_session against a secure broker is rejected (connection closed, no registration)', async () => {
    broker = await startBrokerHost({ dataDir: freshDir() }); // secure (default)
    // send an ordinary protocol frame with NO handshake
    const res = await rawProbe(broker.endpoint, { protocolVersion: 1, frameType: 'register_session', timestamp: 't', payload: { sessionId: 'x', instanceId: 'i', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: [], role: 'mcp' } });
    expect(res.closed).toBe(true); // broker drops the pre-handshake frame
    // and nothing was registered
    const n = (broker.db.prepare("SELECT COUNT(*) n FROM sessions WHERE session_id='x'").get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('a plaintext list_sessions cannot disclose session/alias existence pre-auth', async () => {
    broker = await startBrokerHost({ dataDir: freshDir() });
    const res = await rawProbe(broker.endpoint, { protocolVersion: 1, frameType: 'list_sessions', timestamp: 't', payload: {} });
    // either dropped, or no session/alias info leaked
    expect(res.replyHadSession).toBe(false);
  });

  it('a client with the WRONG root secret cannot complete the handshake (no registration)', async () => {
    broker = await startBrokerHost({ dataDir: freshDir() });
    const wrong = new IpcClient(broker.endpoint, { requestTimeoutMs: 2000, rootSecret: generateRootSecret() });
    await expect(wrong.connect()).rejects.toMatchObject({ code: 'XBUS_AUTH_FAILED' });
  });

  it('§12: a secure broker + correct secret works; a no-secret client is rejected', async () => {
    broker = await startBrokerHost({ dataDir: freshDir() });
    // correct secret -> connects
    const ok = new IpcClient(broker.endpoint, { requestTimeoutMs: 2000, rootSecret: broker.rootSecret });
    await ok.connect();
    ok.close();
    // no secret (plaintext client) -> the broker never establishes the channel;
    // any request times out / fails (no auto-downgrade to plaintext)
    const plain = new IpcClient(broker.endpoint, { requestTimeoutMs: 1500 });
    await plain.connect(); // TCP connects
    await expect(plain.request('get_status', {})).rejects.toBeTruthy(); // but no app frame succeeds
    plain.close();
  });
});
