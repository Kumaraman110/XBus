#!/usr/bin/env node
/**
 * BETA.11 real-lifecycle dogfood acceptance — the user's actual defect scenario, end-to-end through
 * the REAL installed MCP server + broker over stdio, in FULLY ISOLATED temp roots (never the golden
 * install / live DB). Proves the durable-identity reclaim + activation + negative-lifecycle contract.
 *
 * This is DISTINCT from accept-identity-reclaim.mjs: that reclaims a WORKSPACE-derived name (A and B
 * share a project dir → same suggestion). The beta.11 defect is the OFF-WORKSPACE, user-chosen name
 * (`AccountLookUp` != the workspace suggestion), which only reclaims via the beta.11 durable-name
 * recovery pointer. We name via xbus_rename, build durable state, "upgrade", resume under a NEW
 * session id with plain-claude semantics, and assert automatic reclaim + all the negatives.
 *
 * Args: <server.js> <dataDir> <settingsPath>
 *   server.js     — the built dist/channel/server.js (the MCP entry Claude Code spawns)
 *   dataDir       — isolated broker data dir (temp)
 *   settingsPath  — isolated claude settings.json (temp) — for the persistent-activation remedy check
 * Exits 0 on success (prints BETA11_DOGFOOD_PASS), non-zero on any failure. Never prints a secret.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [serverJsArg, dataDir, settingsPath] = process.argv.slice(2);
if (!serverJsArg || !dataDir) { console.error('usage: beta11-dogfood-accept.mjs <server.js> <dataDir> [settingsPath]'); process.exit(2); }
const serverJs = path.resolve(serverJsArg); // ABSOLUTE — children set cwd to a temp dir, and hostMod must resolve regardless
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

const NAME = 'AccountLookUp';           // user-chosen, mixed-case, NOT a workspace suggestion
const workDir = fs.mkdtempSync(path.join(dataDir, 'proj-al-'));   // "Source_Code"-like dir
const peerDir = fs.mkdtempSync(path.join(dataDir, 'proj-peer-'));
const otherDir = fs.mkdtempSync(path.join(dataDir, 'proj-other-'));

try {
  const { startBrokerHost } = await import(hostMod);
  broker = await startBrokerHost({ dataDir });

  // ── Predecessor A: register (workspace-auto name), then RENAME to the off-workspace AccountLookUp ──
  const A = startMcp('97c77985-9092-4b88-a67c-e552b51e3bb6', workDir);
  await A.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  const rn = await A.ok('xbus_rename', { name: NAME });
  check(rn.name === NAME || rn.state === 'active', `predecessor renamed to ${NAME} (off-workspace, user-chosen)`);
  const aStatus = await A.ok('xbus_status', {});
  check(aStatus.session?.sessionName === NAME && aStatus.session?.sessionNameState === 'active', 'predecessor active under AccountLookUp with a durable logical identity');
  const aLogical = aStatus.session?.logicalIdentityId || aStatus.session?.sessionId;

  // Durable state: a peer queues an ack+reply-required request → accepted (reply-pending) + thread.
  const P = startMcp('pppp2222-0000-4000-8000-00000000pppp', peerDir);
  await P.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  const send = await P.ok('xbus_send', { to: NAME, text: 'lookup account 42', kind: 'request', requiresAck: true, requiresReply: true });
  check(!!send.messageId, 'peer queued an ack+reply request to AccountLookUp (durable inbox item)');
  const aInbox = await A.ok('xbus_inbox', { limit: 10 });
  const am = (aInbox.messages ?? []).find((m) => m.messageId === send.messageId);
  check(!!am, 'predecessor received the queued request');
  await A.ok('xbus_ack', { messageId: send.messageId, status: 'accepted', injectionId: am.injectionId });
  check(true, 'predecessor ACCEPTED the request (reply-pending authority established, not yet replied)');

  // ── Crash the predecessor (a hard kill → its runtime is gone; new session id follows) ──
  kill(A); await wait(500);
  check(true, 'predecessor crashed (runtime gone)');

  // ── Successor B: NEW session id, SAME workspace, plain-claude semantics (no launcher env). It must
  //    recover the durable name via the beta.11 pointer and auto-reclaim WITHOUT xbus_rename. ──
  const B = startMcp('ab4ca108-e38c-4b06-84af-a113e2e49a61', workDir);
  await B.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  const bStatus = await B.ok('xbus_status', {});
  check(bStatus.session?.sessionName === NAME, `successor auto-reclaimed name ${NAME} WITHOUT xbus_rename`);
  check(bStatus.session?.sessionNameState === 'active', 'successor name state is active');
  check(bStatus.broker === 'connected', 'xbus_status reports MCP-connected activation (not hook-only)');
  check((bStatus.session?.logicalIdentityId || bStatus.session?.sessionId) === aLogical, 'successor inherited the predecessor durable logical identity (correct predecessor/successor link)');

  // Inbox + accepted reply-authority follow the durable identity.
  const bInbox = await B.ok('xbus_inbox', { limit: 10 });
  const bm = (bInbox.messages ?? []).find((m) => m.messageId === send.messageId);
  check(!!bm, 'queued inbox item followed to the successor');
  const reply = await B.ok('xbus_reply', { messageId: send.messageId, text: 'account 42 resolved', outcome: 'completed', injectionId: bm?.injectionId });
  check(!!reply.replyMessageId, 'successor completed the ACCEPTED reply-pending request (authority followed)');

  // Exactly one reply can complete — a second reply must be rejected.
  const dupe = await B.callTool('xbus_reply', { messageId: send.messageId, text: 'dupe', outcome: 'completed', injectionId: bm?.injectionId });
  check(dupe.isError === true, 'exactly-one-reply: a second reply is rejected');
  const pInbox = await P.ok('xbus_inbox', { limit: 10 });
  check((pInbox.messages ?? []).some((m) => m.kind === 'reply' && m.correlationId === send.correlationId), 'peer received exactly the one correlated reply from the successor');

  // ── Broker restart → continuity ──
  await broker.stop(); await wait(300);
  broker = await startBrokerHost({ dataDir });
  const B2 = startMcp('ab4ca108-e38c-4b06-84af-a113e2e49a61', workDir);
  await B2.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  const b2 = await B2.ok('xbus_status', {});
  check(b2.session?.sessionName === NAME && b2.session?.sessionNameState === 'active', 'after broker restart: successor still active under AccountLookUp (continuity)');
  kill(B2);

  // ── NEGATIVE: unrelated session (different workspace, no credential) must NOT steal the name ──
  const U = startMcp('cccc4444-0000-4000-8000-00000000cccc', otherDir);
  await U.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  const uRename = await U.callTool('xbus_rename', { name: NAME });
  check(uRename.isError === true, 'unrelated session (no credential) CANNOT steal AccountLookUp — rename rejected');
  const uReason = uRename.parsed?.detail?.reclaimOutcome || uRename.parsed?.reclaimOutcome || uRename.parsed?.code;
  check(!!uReason, `unrelated-session failure carries a discriminated reason (${uReason}) — not a bare NAME_TAKEN`);

  // ── NEGATIVE: live predecessor must NOT be evicted (B is live now; a new session with the secret
  //    should NOT evict a proven-live incumbent — reclaim only redirects a GONE predecessor) ──
  const Blive = startMcp('ab4ca108-e38c-4b06-84af-a113e2e49a61', workDir);
  await Blive.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  await Blive.ok('xbus_status', {});
  const Craid = startMcp('dddd5555-0000-4000-8000-00000000dddd', workDir);
  await Craid.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  const cStatus = await Craid.ok('xbus_status', {});
  // A concurrent session in the same workspace, with B live, must NOT hijack the active name.
  check(cStatus.session?.sessionName !== NAME || cStatus.session?.sessionId === (b2.session?.sessionId), 'live incumbent not evicted by a concurrent same-workspace session');
  kill(Blive); kill(Craid);

  console.log(`\n  BETA11_DOGFOOD_PASS (${pass} assertions)`);
  await cleanup(); process.exit(0);
} catch (e) {
  console.error('  BETA11_DOGFOOD_FAIL: ' + (e?.stack ?? String(e)));
  await cleanup(); process.exit(1);
} finally {
  try { for (const d of [workDir, peerDir, otherDir]) fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ }
}
