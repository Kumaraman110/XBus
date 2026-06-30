#!/usr/bin/env node
/**
 * Beta.4 broker-side acceptance harness (driven by scripts/beta4-accept.mjs). Uses
 * the INSTALLED dist. Proves, end-to-end, the beta.4 promises that don't need a model:
 *
 *   1. ZERO-FRICTION AUTO-START: two MCP server processes are spawned with NO broker
 *      running and NO `xbus start` — the first tool call's ensureBroker() must start
 *      exactly one broker. (No startBrokerHost() here, unlike the beta.3 harness.)
 *   2. AUTO-NAMING + ROUTE-BY-NAME: each session auto-registers with a name (set via
 *      XBUS_SESSION_NAME for determinism); A addresses B by its NAME (no alias).
 *   3. REQUEST/ACK/REPLY + the correlated reply path still work named.
 *   4. DUPLICATE-NAME → PENDING → xbus_rename → active (the pending escape hatch).
 *   5. CONCURRENCY: many concurrent ensureBroker() callers → exactly ONE broker.
 *   6. 15-DAY EXPIRY via an injected FakeClock (broker-side, deterministic).
 *
 * Args: <installed-server.js> <dataDir>. Exits 0 on success.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [serverJs, dataDir] = process.argv.slice(2);
if (!serverJs || !dataDir) { console.error('usage: beta4-accept-exchange.mjs <server.js> <dataDir>'); process.exit(2); }
const distRoot = path.dirname(path.dirname(serverJs)); // <plugin>/dist
const imp = (rel) => import(pathToFileURL(path.join(distRoot, rel)).href);

const procs = [];
function startMcp(sessionId, label, name) {
  const cwd = fs.mkdtempSync(path.join(dataDir, `cwd-${label}-`));
  const child = spawn(process.execPath, [serverJs], {
    cwd, env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId, XBUS_DATA_DIR: dataDir, XBUS_SESSION_NAME: name, XBUS_ALLOW_UNSUPPORTED_NODE: process.env.XBUS_ALLOW_UNSUPPORTED_NODE ?? '' },
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
      try { const m = JSON.parse(line); if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } catch { /* */ }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++idc; waiters.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n');
    setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); reject(new Error(`rpc ${method} timed out`)); } }, 30000);
  });
  const callTool = async (name2, args) => {
    const res = await rpc('tools/call', { name: name2, arguments: args });
    const text = res.result?.content?.[0]?.text; const parsed = text ? JSON.parse(text) : undefined;
    if (res.result?.isError) throw new Error(`tool ${name2} error: ${JSON.stringify(parsed)}`);
    return parsed;
  };
  return { child, rpc, callTool };
}
const pass = (n) => console.log(`  [PASS] ${n}`);
async function cleanup() { for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* */ } } }

try {
  // ── 1+2+3: zero-friction auto-start + named two-session exchange ──
  // NO broker is started here. The MCP server's ensureBroker() must auto-start it.
  const A = startMcp('aaaa1111-aaaa-1111-aaaa-111111111111', 'A', 'accept-architect');
  const B = startMcp('bbbb2222-bbbb-2222-bbbb-222222222222', 'B', 'accept-implementer');
  await A.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  await B.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  // First tool call triggers ensureBroker auto-start + auto-register-with-name.
  await A.callTool('xbus_status', {});
  await B.callTool('xbus_status', {});
  pass('broker auto-started on first tool call (no manual `xbus start`)');

  // Connect as admin via the INSTALLED ipc client to inspect broker state by name.
  const { IpcClient } = await imp('ipc/client.js');
  const { defaultEndpoint } = await imp('ipc/transport.js');
  const { loadOrCreateRootSecret } = await imp('ipc/root-secret.js');
  const { doHello } = await imp('ipc/hello.js');
  const endpoint = defaultEndpoint(dataDir);
  const rootSecret = loadOrCreateRootSecret(dataDir);
  async function listSessions() {
    const c = new IpcClient(endpoint, { requestTimeoutMs: 8000, rootSecret, helloIdentity: { claimedRole: 'admin' } });
    await c.connect(); await doHello(c, 'admin');
    await c.request('register_session', { sessionId: `cli-${Date.now()}`, instanceId: 'cli', processId: process.pid, projectId: 'p', cwd: '/', receiveMode: 'poll_only', capabilities: ['cli'], role: 'admin' });
    const f = await c.request('list_sessions', {});
    c.close();
    return (f.payload?.sessions ?? f.sessions ?? []);
  }
  let sess = await listSessions();
  const namedA = sess.find((s) => s.name === 'accept-architect' && s.sessionNameState === 'active');
  const namedB = sess.find((s) => s.name === 'accept-implementer' && s.sessionNameState === 'active');
  if (!namedA || !namedB) throw new Error('sessions did not auto-register with active names: ' + JSON.stringify(sess.map((s) => [s.name, s.sessionNameState])));
  pass('both sessions discoverable BY NAME (accept-architect, accept-implementer)');

  // Route A → B by NAME; ack + reply.
  const nonce = 'B4-NONCE-5Z';
  const send = await A.callTool('xbus_send', { to: 'accept-implementer', text: `ack+reply ${nonce}`, requiresAck: true, requiresReply: true });
  if (!send.messageId) throw new Error('named send failed: ' + JSON.stringify(send));
  const inbox = await B.callTool('xbus_inbox', { limit: 10 });
  const msg = (inbox.messages ?? []).find((m) => m.text?.includes(nonce));
  if (!msg) throw new Error('B inbox missing named message');
  await B.callTool('xbus_ack', { messageId: send.messageId, status: 'accepted', injectionId: msg.injectionId });
  const reply = await B.callTool('xbus_reply', { messageId: send.messageId, text: 'ok', outcome: 'completed', injectionId: msg.injectionId });
  if (!reply.replyMessageId) throw new Error('reply failed');
  const aInbox = await A.callTool('xbus_inbox', { limit: 10 });
  if (!(aInbox.messages ?? []).some((m) => m.kind === 'reply' && m.correlationId === send.correlationId)) throw new Error('A missed correlated reply');
  pass('named request → ack → correlated reply');

  // ── 4: duplicate-name → pending → xbus_rename → active ──
  const C = startMcp('cccc3333-cccc-3333-cccc-333333333333', 'C', 'accept-architect'); // same name as A
  await C.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  await C.callTool('xbus_status', {}); // registers → collision → pending
  sess = await listSessions();
  const pendingC = sess.find((s) => s.sessionId === 'cccc3333-cccc-3333-cccc-333333333333');
  if (pendingC?.sessionNameState !== 'pending') throw new Error('C did not go pending on name collision: ' + JSON.stringify(pendingC));
  const renamed = await C.callTool('xbus_rename', { name: 'accept-architect-2' });
  if (renamed.sessionNameState !== 'active' || renamed.name !== 'accept-architect-2') throw new Error('rename did not activate: ' + JSON.stringify(renamed));
  pass('duplicate name → pending → xbus_rename → active');

  // ── 5: concurrency — many concurrent ensureBroker callers → exactly ONE broker ──
  const { ensureBrokerDefault } = await imp('broker/ensure.js');
  const results = await Promise.all(Array.from({ length: 8 }, () => ensureBrokerDefault(dataDir)));
  const okCount = results.filter((r) => r.ok && r.isRunning).length;
  const launchedCount = results.filter((r) => r.ok && r.launched).length;
  if (okCount !== 8) throw new Error(`not all ensureBroker callers connected: ${okCount}/8`);
  // The broker was already running (auto-started above), so NONE should have launched a new one.
  if (launchedCount > 0) throw new Error(`concurrency spawned ${launchedCount} extra brokers (expected 0; one already running)`);
  pass('8 concurrent ensureBroker callers all connected to the ONE running broker (0 extra spawns)');

  // ── 6: 15-day expiry via an injected FakeClock (broker-side, deterministic) ──
  const { openDatabase } = await imp('database/connection.js');
  const { runMigrations } = await imp('database/migrations.js');
  const { BrokerStore } = await imp('broker/store.js');
  const { Reaper } = await imp('broker/reaper.js');
  const { FakeClock, SeqIdGen } = await imp('shared/clock.js');
  const expDir = fs.mkdtempSync(path.join(dataDir, 'expiry-'));
  const edb = openDatabase(path.join(expDir, 'x.sqlite'), { applyPragmas: true });
  const clock = new FakeClock(); const ids = new SeqIdGen('m');
  runMigrations(edb, clock.nowIso());
  const store = new BrokerStore(edb, clock, ids, 'b');
  const reaper = new Reaper(edb, clock, ids);
  const sid = 'eeee4444-eeee-4444-eeee-444444444444';
  const auth = store.register({ sessionId: sid, instanceId: 'i', connectionId: 'c', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp', requestedSessionName: 'expiry-victim' });
  store.signalReadiness(auth, { ackAvailable: true, versionOk: true });
  clock.advance(15 * 24 * 60 * 60 * 1000 - 60_000); // 14d23h59m
  if (reaper.sweep().sessionsExpired !== 0) throw new Error('expired too early (inside 15d window)');
  clock.advance(2 * 60_000); // now > 15 days
  if (reaper.sweep().sessionsExpired !== 1) throw new Error('did not expire after 15 days');
  const row = edb.prepare('SELECT expired_at, session_name_state FROM sessions WHERE session_id=?').get(sid);
  if (!row.expired_at || row.session_name_state !== 'retired') throw new Error('expiry did not retire the session/name');
  edb.close();
  pass('15-day expiry: active at 14d23h59m, expired + name released after 15d (FakeClock)');

  console.log('  BETA4_BROKER_EXCHANGE_PASS');
  await cleanup();
  process.exit(0);
} catch (e) {
  console.error('  [FAIL] beta4 exchange: ' + (e?.stack ?? String(e)));
  await cleanup();
  process.exit(1);
}
