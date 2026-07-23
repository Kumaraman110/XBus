#!/usr/bin/env node
/**
 * BETA.11 delivery-honesty CONTRAPOSITIVE dogfood (ADR 0038) — real MCP server + broker over stdio,
 * in FULLY ISOLATED temp roots (never the golden install / live DB).
 *
 * We deliberately do NOT try to prove a cold-idle interactive autonomous wake — that capability is
 * UNPROVEN on this platform (see ADR 0038 / reference_cc_bedrock_capabilities), and a headless script
 * IS the "user turn", so it structurally cannot demonstrate it. Instead we prove the CONTRAPOSITIVE
 * the operator asked for: when no wake path is proven, AgenTel is HONEST — a checkpoint-only recipient
 * is not advertised as autonomously routable, the sender is told an honest delivery signal (never
 * "delivered"), delay-tolerant queuing still works, and no false autonomous-delivery claim is made.
 *
 * Args: <server.js> <dataDir>
 * Exits 0 on success (prints BETA11_DELIVERY_HONESTY_PASS), non-zero on any failure. Never prints a secret.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [serverJsArg, dataDir] = process.argv.slice(2);
if (!serverJsArg || !dataDir) { console.error('usage: beta11-delivery-honesty-accept.mjs <server.js> <dataDir>'); process.exit(2); }
const serverJs = path.resolve(serverJsArg);
const distRoot = path.dirname(path.dirname(serverJs));
const hostMod = pathToFileURL(path.join(distRoot, 'broker', 'host.js')).href;

const procs = [];
function startMcp(sessionId, cwd, extraEnv = {}) {
  const child = spawn(process.execPath, [serverJs], {
    cwd, env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId, XBUS_DATA_DIR: dataDir, XBUS_ALLOW_UNSUPPORTED_NODE: process.env.XBUS_ALLOW_UNSUPPORTED_NODE ?? '1', AGENTEL_ALLOW_UNSUPPORTED_NODE: '1', ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  procs.push(child);
  let buf = ''; const waiters = new Map(); let idc = 0; let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { stderr += d; });
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
    setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); reject(new Error(`rpc ${method} timed out; stderr: ${stderr.slice(-400)}`)); } }, 20000);
  });
  const callTool = async (name, args) => {
    const res = await rpc('tools/call', { name, arguments: args });
    const text = res.result?.content?.[0]?.text; const parsed = text ? JSON.parse(text) : undefined;
    return { parsed, isError: !!res.result?.isError };
  };
  const ok = async (name, args) => { const r = await callTool(name, args); if (r.isError) throw new Error(`tool ${name} unexpected error: ${JSON.stringify(r.parsed)}`); return r.parsed; };
  return { child, rpc, callTool, ok, stderr: () => stderr };
}
function kill(m) { try { m.child.kill('SIGKILL'); } catch { /* */ } const i = procs.indexOf(m.child); if (i >= 0) procs.splice(i, 1); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let broker; let pass = 0;
function check(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); pass++; console.log('  ✓ ' + msg); }
async function cleanup() { for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* */ } } try { await broker?.stop(); } catch { /* */ } }

const recipDir = fs.mkdtempSync(path.join(dataDir, 'proj-recip-'));
const senderDir = fs.mkdtempSync(path.join(dataDir, 'proj-sender-'));

try {
  const { startBrokerHost } = await import(hostMod);
  broker = await startBrokerHost({ dataDir });

  // ── Recipient R: a normal MCP-connected session that then goes IDLE (no proven host wake). ──
  const R = startMcp('11111111-2222-4333-8444-555566667777', recipDir);
  await R.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  const rName = await R.ok('xbus_rename', { name: 'HonestRecipient' });
  check(rName.state === 'active' || rName.name === 'HonestRecipient', 'recipient active under a durable name');

  // Its OWN status: connected, but the honest routing class is degraded_checkpoint_only (no proven
  // host wake-probe) — NOT ready/auto-wakeable. This is the crux honesty assertion.
  const rStatus = await R.ok('xbus_status', {});
  check(rStatus.broker === 'connected', 'recipient reports MCP-connected activation');
  check(rStatus.session?.routingClass === 'degraded_checkpoint_only',
    `recipient routingClass is degraded_checkpoint_only (checkpoint-capable, wake UNPROVEN) — got ${rStatus.session?.routingClass}`);

  // ── Sender S sends a request; the send ack must be HONEST about the recipient. ──
  const S = startMcp('88889999-aaaa-4bbb-8ccc-ddddeeeeffff', senderDir);
  await S.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });

  // xbus_sessions parity: the recipient is listed degraded_checkpoint_only + NOT autonomouslyRoutable.
  const list = await S.ok('xbus_sessions', {});
  const rRow = (Array.isArray(list) ? list : list.sessions ?? []).find((x) => x.name === 'HonestRecipient');
  check(!!rRow, 'sender can discover the recipient via xbus_sessions');
  check(rRow.routingClass === 'degraded_checkpoint_only', `xbus_sessions routingClass parity: degraded_checkpoint_only (got ${rRow?.routingClass})`);
  check(rRow.autonomouslyRoutable === false, 'recipient is NOT advertised autonomously routable');

  const send = await S.ok('xbus_send', { to: 'HonestRecipient', text: 'delay-tolerant work', kind: 'request', requiresAck: true, requiresReply: true });
  check(!!send.messageId, 'delay-tolerant send is durably queued (success semantics preserved)');
  // The sender is told the HONEST signal — never "delivered" for a stored message.
  check(send.deliverySignal === 'queued', `send deliverySignal is "queued", not delivered (got ${send.deliverySignal})`);
  check(send.autonomouslyRoutable === false, 'send ack tells the sender the recipient is not autonomously routable');
  check(send.routingClass === 'degraded_checkpoint_only', 'send ack carries the honest recipient routing class');
  check(send.state !== 'delivered', 'send state never claims "delivered" before injection');

  // ── The message is genuinely durable: the idle recipient can still pull it on its next checkpoint
  //    (this pull IS the "user turn"; we are NOT claiming an autonomous cold-idle wake happened). ──
  const inbox = await R.ok('xbus_inbox', { limit: 10 });
  const im = (inbox.messages ?? []).find((m) => m.messageId === send.messageId);
  check(!!im, 'the queued message is durably retained and pullable by the recipient (durable floor)');

  console.log(`\n  BETA11_DELIVERY_HONESTY_PASS (${pass} assertions)`);
  await cleanup(); process.exit(0);
} catch (e) {
  console.error('  BETA11_DELIVERY_HONESTY_FAIL: ' + (e?.stack ?? String(e)));
  await cleanup(); process.exit(1);
}
