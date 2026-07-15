#!/usr/bin/env node
/**
 * Durable-identity RECLAIM acceptance (beta.8, ADR 0027) — through the REAL installed MCP
 * server + broker over stdio (exactly how Claude Code talks to them). Proves the
 * session-continuity fix end-to-end, not just at the store layer:
 *
 *   1. Session A (session id sidA) starts in a project dir → auto-registers + is awarded a
 *      name; the MCP server persists its ownership secret (owner-secret-store, keyed by
 *      project_id + name) transparently.
 *   2. A peer queues a message to A's NAME (requires ack+reply) → durably persisted.
 *   3. A is KILLED (its runtime is gone), simulating a resume/fork/clear/compact/crash that
 *      mints a NEW Claude Code session id.
 *   4. Session B (session id sidB — DIFFERENT) starts in the SAME project dir. Its MCP server
 *      auto-loads the persisted secret and presents it at registration.
 *   5. ASSERT: B reclaims the name AND inherits A's queued inbox — the message is delivered to
 *      B, which can ack + reply it exactly once. No manual sender resend.
 *
 * Args:  <installed-server.js> <dataDir>
 * Exits 0 on success (prints IDENTITY_RECLAIM_ACCEPT_PASS), non-zero on any failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [serverJs, dataDir] = process.argv.slice(2);
if (!serverJs || !dataDir) { console.error('usage: accept-identity-reclaim.mjs <server.js> <dataDir>'); process.exit(2); }
const distRoot = path.dirname(path.dirname(serverJs));
const hostMod = pathToFileURL(path.join(distRoot, 'broker', 'host.js')).href;

const procs = [];
function startMcp(sessionId, cwd, label) {
  const child = spawn(process.execPath, [serverJs], {
    cwd, env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId, XBUS_DATA_DIR: dataDir, XBUS_ALLOW_UNSUPPORTED_NODE: process.env.XBUS_ALLOW_UNSUPPORTED_NODE ?? '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  procs.push(child);
  let buf = ''; const waiters = new Map(); let idc = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { const msg = JSON.parse(line); if (msg.id != null && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); } } catch { /* */ }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++idc; waiters.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n');
    setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); reject(new Error(`rpc ${method} timed out`)); } }, 20000);
  });
  const callTool = async (name, args) => {
    const res = await rpc('tools/call', { name, arguments: args });
    const text = res.result?.content?.[0]?.text; const parsed = text ? JSON.parse(text) : undefined;
    if (res.result?.isError) throw new Error(`tool ${name} error: ${JSON.stringify(parsed)}`);
    return parsed;
  };
  return { child, rpc, callTool, label };
}
function kill(m) { try { m.child.kill('SIGKILL'); } catch { /* */ } const i = procs.indexOf(m.child); if (i >= 0) procs.splice(i, 1); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let broker;
async function cleanup() {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* */ } }
  try { await broker?.stop(); } catch { /* */ }
}

try {
  const { startBrokerHost } = await import(hostMod);
  broker = await startBrokerHost({ dataDir });

  // A shared PROJECT dir → both A and B derive the same project_id + suggested name, so B's MCP
  // server auto-loads the secret A persisted. A separate dir for the peer sender.
  const projectDir = fs.mkdtempSync(path.join(dataDir, 'proj-worker-'));
  const peerDir = fs.mkdtempSync(path.join(dataDir, 'proj-peer-'));

  // 1) Session A registers (auto-named from the workspace) + a peer sender.
  const A = startMcp('aaaa1111-0000-4000-8000-00000000aaaa', projectDir, 'A');
  const P = startMcp('pppp2222-0000-4000-8000-00000000pppp', peerDir, 'P');
  await A.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  await P.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  // Discover A's awarded durable name via status (the workspace-derived session name).
  const aStatus = await A.callTool('xbus_status', {});
  const aName = aStatus?.session?.sessionName;
  if (!aName) throw new Error(`could not determine A's awarded name from status (state=${aStatus?.session?.sessionNameState}): ${JSON.stringify(aStatus)}`);
  console.log(`  A registered + awarded durable name: ${aName}`);

  // 2) Peer queues a message to A's NAME (ack + reply required) → durably persisted.
  const nonce = 'RECLAIM-NONCE-42';
  const send = await P.callTool('xbus_send', { to: aName, text: `work item ${nonce}`, requiresAck: true, requiresReply: true });
  if (!send.messageId) throw new Error(`peer send did not return a messageId: ${JSON.stringify(send)}`);
  console.log(`  peer → ${aName} send: ${send.state}`);

  // 3) A's runtime dies (fork/clear/compact/crash → a NEW Claude session id next time).
  kill(A);
  await wait(400); // let the broker observe the connection close (onConnClose → disconnected)
  console.log('  session A killed (its runtime is gone; a new session id will follow)');

  // 4) Session B starts in the SAME project dir under a DIFFERENT session id. Its MCP server
  //    auto-loads the persisted ownership secret and presents it → reclaim.
  const B = startMcp('bbbb3333-0000-4000-8000-00000000bbbb', projectDir, 'B');
  await B.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  const bStatus = await B.callTool('xbus_status', {});
  const bName = bStatus?.session?.sessionName;
  if (bName !== aName) throw new Error(`RECLAIM FAILED: B was awarded '${bName}' (state=${bStatus?.session?.sessionNameState}), expected to reclaim '${aName}'`);
  console.log(`  session B (new id) reclaimed the durable name: ${bName}`);

  // 5) B inherits A's queued inbox — the message is delivered to B, ack + reply exactly once.
  const inbox = await B.callTool('xbus_inbox', { limit: 10 });
  const msg = (inbox.messages ?? []).find((m) => m.text?.includes(nonce));
  if (!msg) throw new Error(`RECLAIM FAILED: B did not inherit the queued message (inbox: ${JSON.stringify(inbox.messages)})`);
  console.log('  B inherited the stranded inbox: the queued message was delivered to the successor');
  const ack = await B.callTool('xbus_ack', { messageId: send.messageId, status: 'accepted', injectionId: msg.injectionId });
  if (ack.state !== 'accepted') throw new Error(`B ack state ${ack.state}`);
  const reply = await B.callTool('xbus_reply', { messageId: send.messageId, text: `done by successor ${nonce}`, outcome: 'completed', injectionId: msg.injectionId });
  if (!reply.replyMessageId) throw new Error('B reply missing replyMessageId');
  console.log('  B acknowledged + replied the inherited message (exactly once)');

  // 6) The peer receives the correlated reply from the SUCCESSOR — no manual resend anywhere.
  const pInbox = await P.callTool('xbus_inbox', { limit: 10 });
  const got = (pInbox.messages ?? []).find((m) => m.kind === 'reply' && m.correlationId === send.correlationId);
  if (!got) throw new Error('RECLAIM FAILED: peer did not receive the correlated reply from the successor');
  console.log('  peer received the correlated reply from the successor ✓');

  console.log('  IDENTITY_RECLAIM_ACCEPT_PASS');
  await cleanup();
  process.exit(0);
} catch (e) {
  console.error('  identity-reclaim acceptance error: ' + (e?.stack ?? String(e)));
  await cleanup();
  process.exit(1);
}
