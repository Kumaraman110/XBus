#!/usr/bin/env node
/**
 * Two-session MCP exchange for the clean-machine acceptance (§10). Starts a broker
 * from the INSTALLED dist, spawns two real MCP server processes over stdio (exactly
 * how Claude Code talks to them), and proves:
 *   register aliases → send → inbox(body once) → ack → reply → A sees correlated reply.
 *
 * Args:  <installed-server.js> <dataDir>
 * Uses the INSTALLED server entrypoint + an isolated dataDir. Exits 0 on success.
 *
 * The broker is started by importing the installed broker host from the same dist as
 * the server (so this exercises installed code, not the repo).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [serverJs, dataDir] = process.argv.slice(2);
if (!serverJs || !dataDir) { console.error('usage: accept-exchange.mjs <server.js> <dataDir>'); process.exit(2); }
const distRoot = path.dirname(path.dirname(serverJs)); // <plugin>/dist
const hostMod = pathToFileURL(path.join(distRoot, 'broker', 'host.js')).href;

const procs = [];
function startMcp(sessionId, label) {
  const cwd = fs.mkdtempSync(path.join(dataDir, `cwd-${label}-`));
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
  return { child, rpc, callTool };
}

let broker;
async function cleanup() {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* */ } }
  try { await broker?.stop(); } catch { /* */ }
}

try {
  const { startBrokerHost } = await import(hostMod);
  broker = await startBrokerHost({ dataDir });

  const A = startMcp('aaaa1111-aaaa-1111-aaaa-111111111111', 'A');
  const B = startMcp('bbbb2222-bbbb-2222-bbbb-222222222222', 'B');

  const initA = await A.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  if (initA.result?.serverInfo?.name !== 'xbus') throw new Error('MCP initialize: serverInfo.name != xbus');
  if (!/UNTRUSTED/.test(initA.result?.instructions ?? '')) throw new Error('MCP instructions missing untrusted-peer fence');
  console.log('  MCP initialize ok (both sessions)');
  await B.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });

  await A.callTool('xbus_register', { alias: 'architect' });
  await B.callTool('xbus_register', { alias: 'implementer' });
  console.log('  aliases registered: architect, implementer');

  const nonce = 'ACCEPT-NONCE-7Q2';
  const send = await A.callTool('xbus_send', { to: 'implementer', text: `please ack+reply ${nonce}`, requiresAck: true, requiresReply: true });
  if (send.state !== 'queued_until_checkpoint') throw new Error(`send state ${send.state}`);
  console.log('  A → B send: ' + send.state);

  const inbox = await B.callTool('xbus_inbox', { limit: 10 });
  if (inbox.messages?.length !== 1 || !inbox.messages[0].text.includes(nonce)) throw new Error('B inbox missing the message/nonce');
  const receipt = inbox.messages[0].injectionId;
  console.log('  B inbox: body shown once, receipt present');

  const ack = await B.callTool('xbus_ack', { messageId: send.messageId, status: 'accepted', injectionId: receipt });
  if (ack.state !== 'accepted') throw new Error(`ack state ${ack.state}`);
  const reply = await B.callTool('xbus_reply', { messageId: send.messageId, text: 'done — looks good', outcome: 'completed', injectionId: receipt });
  if (!reply.replyMessageId) throw new Error('reply missing replyMessageId');
  console.log('  B ack + reply ok');

  const aInbox = await A.callTool('xbus_inbox', { limit: 10 });
  const got = (aInbox.messages ?? []).find((m) => m.kind === 'reply' && m.correlationId === send.correlationId);
  if (!got) throw new Error('A did not receive the correlated reply');
  console.log('  A received correlated reply ✓');

  console.log('  TWO_SESSION_EXCHANGE_PASS');
  await cleanup();
  process.exit(0);
} catch (e) {
  console.error('  exchange error: ' + (e?.stack ?? String(e)));
  await cleanup();
  process.exit(1);
}
