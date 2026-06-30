/**
 * E2E (process-level): drive TWO real XBus MCP server processes over stdio —
 * exactly how Claude Code talks to them — against an in-process broker with
 * real IPC + real node:sqlite. Proves the actual MCP tool surface:
 * xbus_register / xbus_send / xbus_inbox / xbus_ack / xbus_reply.
 *
 * This is NOT a live-Claude test (no model). It proves the tool contract that a
 * Claude session invokes. The live-Claude leg is documented separately as a
 * manual checkpoint test (HookCheckpointTransport defers delivery to a turn).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { startBrokerHost, type RunningBroker } from '../../src/broker/host.js';

const SERVER_JS = path.resolve('dist/channel/server.js');

let dataDir: string;
let broker: RunningBroker;
const procs: ChildProcess[] = [];

interface McpProc {
  child: ChildProcess;
  rpc: (method: string, params?: unknown) => Promise<any>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<any>;
  kill: () => void;
}

function startMcp(sessionId: string, label: string, extraEnv: Record<string, string> = {}): McpProc {
  // Use a REAL temp working dir per session (a non-existent cwd makes spawn
  // throw ENOENT pointing at the command — a Windows quirk).
  const cwd = fs.mkdtempSync(path.join(dataDir, `cwd-${label}-`));
  const child = spawn(process.execPath, [SERVER_JS], {
    cwd,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId, XBUS_DATA_DIR: dataDir, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  procs.push(child);
  let buf = '';
  const waiters = new Map<number, (v: any) => void>();
  let idc = 0;
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && waiters.has(msg.id)) {
          waiters.get(msg.id)!(msg);
          waiters.delete(msg.id);
        }
      } catch { /* ignore non-json */ }
    }
  });
  const rpc = (method: string, params?: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++idc;
      waiters.set(id, resolve);
      const t = setTimeout(() => { waiters.delete(id); reject(new Error(`rpc ${method} timeout`)); }, 8000);
      const orig = resolve;
      waiters.set(id, (v) => { clearTimeout(t); orig(v); });
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const res = await rpc('tools/call', { name, arguments: args });
    const text = res.result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : undefined;
    if (res.result?.isError) throw new Error(`tool ${name} error: ${JSON.stringify(parsed)}`);
    return parsed;
  };
  return { child, rpc, callTool, kill: () => child.kill() };
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-e2e-'));
  broker = await startBrokerHost({ dataDir });
});

afterEach(async () => {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* ignore */ } }
  procs.length = 0;
  await broker.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('MCP tool surface (two real server processes)', () => {
  it('full slice: register, send, inbox, ack, reply, correlated reply received', async () => {
    const A = startMcp('aaaa1111-aaaa-1111-aaaa-111111111111', 'A');
    const B = startMcp('bbbb2222-bbbb-2222-bbbb-222222222222', 'B');

    // initialize both (MCP handshake)
    const initA = await A.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    expect(initA.result.serverInfo.name).toBe('xbus');
    expect(initA.result.instructions).toContain('UNTRUSTED');
    await B.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });

    // tools/list exposes the XBus tools and NO permission tool (capability-absence)
    const tools = (await A.rpc('tools/list')).result.tools.map((t: { name: string }) => t.name);
    expect(tools).toContain('xbus_send');
    expect(tools).toContain('xbus_ack');
    expect(tools).toContain('xbus_reply');
    expect(tools.some((n: string) => /permission|approve/i.test(n))).toBe(false);

    // register aliases
    await A.callTool('xbus_register', { alias: 'architect' });
    await B.callTool('xbus_register', { alias: 'implementer' });

    // A sends to B
    const nonce = 'E2E-NONCE-91BX';
    const send = await A.callTool('xbus_send', { to: 'implementer', text: `Acknowledge and reply with protocol version. ${nonce}`, requiresAck: true, requiresReply: true });
    expect(send.state).toBe('queued_until_checkpoint');
    expect(send.recipientReceiveMode).toBe('hook_checkpoint');
    const messageId = send.messageId;

    // B reads its inbox (the model's on-demand read) and sees the nonce + receipt
    const inbox = await B.callTool('xbus_inbox', { limit: 10 });
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].text).toContain(nonce);
    expect(inbox.messages[0].messageId).toBe(messageId);
    const receipt = inbox.messages[0].injectionId;
    expect(receipt).toBeTruthy();

    // B acks then replies, presenting the one-time receipt capability
    const ack = await B.callTool('xbus_ack', { messageId, status: 'accepted', injectionId: receipt });
    expect(ack.state).toBe('accepted');
    const reply = await B.callTool('xbus_reply', { messageId, text: 'XBus protocol version is 1', outcome: 'completed', injectionId: receipt });
    expect(reply.replyMessageId).toBeTruthy();

    // A sees the correlated reply in its inbox
    const aInbox = await A.callTool('xbus_inbox', { limit: 10 });
    expect(aInbox.messages).toHaveLength(1);
    expect(aInbox.messages[0].text).toContain('protocol version is 1');
    expect(aInbox.messages[0].kind).toBe('reply');
    expect(aInbox.messages[0].correlationId).toBe(send.correlationId);
    expect(aInbox.messages[0].causationId).toBe(messageId);

    A.kill(); B.kill();
  });

  it('xbus_send to unknown recipient returns a tool error and inserts nothing', async () => {
    const A = startMcp('cccc3333-cccc-3333-cccc-333333333333', 'A');
    await A.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    await A.callTool('xbus_register', { alias: 'architect' });
    const before = (broker.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    await expect(A.callTool('xbus_send', { to: 'ghost', text: 'hi' })).rejects.toThrow(/UNKNOWN_RECIPIENT/);
    const after = (broker.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    expect(after).toBe(before);
    A.kill();
  });

  it('beta.4: an auto-derived session name is awarded at registration and is routable by name', async () => {
    // XBUS_SESSION_NAME is the explicit/saved-preference override → deterministic.
    const A = startMcp('aaaa7777-aaaa-7777-aaaa-777777777777', 'A', { XBUS_SESSION_NAME: 'seatmap-api' });
    const B = startMcp('bbbb8888-bbbb-8888-bbbb-888888888888', 'B', { XBUS_SESSION_NAME: 'release-reviewer' });
    await A.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    await B.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    // Touch a tool so each server connects + registers (auto-name happens then).
    await A.callTool('xbus_status', {});
    await B.callTool('xbus_status', {});
    // The broker awarded the requested names → A can address B by its NAME (no
    // explicit xbus_register alias needed). This proves the zero-friction naming path.
    const sessA = broker.db.prepare("SELECT session_name FROM sessions WHERE session_id=?").get('aaaa7777-aaaa-7777-aaaa-777777777777') as { session_name: string | null };
    expect(sessA.session_name).toBe('seatmap-api');
    const send = await A.callTool('xbus_send', { to: 'release-reviewer', text: 'named-routing-ok', requiresAck: false, requiresReply: false });
    expect(send.recipientSessionId).toBe('bbbb8888-bbbb-8888-bbbb-888888888888');
    A.kill(); B.kill();
  });

  it('beta.4: a collided (pending) session resolves via xbus_rename and becomes routable by name', async () => {
    // Two sessions request the SAME name → first wins 'active', second falls to
    // pending_name. The second resolves it via xbus_rename (the pending escape hatch).
    const A = startMcp('aaaa9999-aaaa-9999-aaaa-999999999999', 'A', { XBUS_SESSION_NAME: 'dup-name' });
    const B = startMcp('bbbbaaaa-bbbb-aaaa-bbbb-aaaaaaaaaaaa', 'B', { XBUS_SESSION_NAME: 'dup-name' });
    await A.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    await B.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    await A.callTool('xbus_status', {}); // A registers -> 'dup-name' active
    await B.callTool('xbus_status', {}); // B registers -> collision -> pending_name
    // B is pending (unroutable by name): listing shows it pending, not active-named.
    const sessB = broker.db.prepare('SELECT session_name_state AS s FROM sessions WHERE session_id=?').get('bbbbaaaa-bbbb-aaaa-bbbb-aaaaaaaaaaaa') as { s: string };
    expect(sessB.s).toBe('pending');
    // B picks a different name via xbus_rename → becomes active + routable.
    const renamed = await B.callTool('xbus_rename', { name: 'dup-name-reviewer' });
    expect(renamed.sessionNameState).toBe('active');
    expect(renamed.name).toBe('dup-name-reviewer');
    // A can now address B by its chosen name.
    const send = await A.callTool('xbus_send', { to: 'dup-name-reviewer', text: 'resolved', requiresAck: false, requiresReply: false });
    expect(send.recipientSessionId).toBe('bbbbaaaa-bbbb-aaaa-bbbb-aaaaaaaaaaaa');
    // Renaming to a name another active session holds is rejected (model retries).
    await expect(B.callTool('xbus_rename', { name: 'dup-name' })).rejects.toThrow(/SESSION_NAME_TAKEN|in use/);
    A.kill(); B.kill();
  });

  it('a session cannot ack a message addressed to another session', async () => {
    const A = startMcp('dddd4444-dddd-4444-dddd-444444444444', 'A');
    const B = startMcp('eeee5555-eeee-5555-eeee-555555555555', 'B');
    await A.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    await B.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    await A.callTool('xbus_register', { alias: 'architect' });
    await B.callTool('xbus_register', { alias: 'implementer' });
    const send = await A.callTool('xbus_send', { to: 'implementer', text: 'for B only', requiresAck: true });
    // A (the sender) tries to ack B's message. Under ADR 0006 authority is bound
    // to the authenticated connection: A has no injection for this message, so it
    // is rejected (INJECTION_NOT_FOUND / NOT_RECIPIENT) — never authorized.
    await expect(A.callTool('xbus_ack', { messageId: send.messageId, status: 'accepted' })).rejects.toThrow(/NOT_RECIPIENT|INJECTION_NOT_FOUND/);
    A.kill(); B.kill();
  });
});
