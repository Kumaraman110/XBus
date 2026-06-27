#!/usr/bin/env node
/*
 * Minimal, robust persistent-session gate. ONE long-lived stream-json session B
 * (plugin loaded once) across multiple checkpoints, plus a broker restart while
 * B stays open. A's sends are injected directly via IPC (a real peer would be a
 * second Claude session; here we isolate the PERSISTENT-RECEIVER claim, which is
 * the part the gate is about — multi-turn in one open process + epoch stability +
 * broker-restart resilience). The A-as-real-Claude leg is already proven in
 * docs/evidence/live-hook-checkpoint. This isolates persistence.
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'dist/cli/main.js');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-pmin-'));
const EV = path.join(REPO, 'docs/evidence/persistent');
fs.mkdirSync(EV, { recursive: true });
const out = [];
function L(s) { out.push(s); fs.writeFileSync(path.join(EV, 'min-gate.txt'), out.join('\n') + '\n'); }

const ALLOWED = 'mcp__plugin_xbus_xbus__xbus_register,mcp__plugin_xbus_xbus__xbus_inbox,mcp__plugin_xbus_xbus__xbus_ack,mcp__plugin_xbus_xbus__xbus_reply,mcp__plugin_xbus_xbus__xbus_status';

function startBroker() {
  return spawn(process.execPath, [CLI, 'start'], { env: { ...process.env, XBUS_DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'pipe'] });
}
function db(sql) {
  const { openDatabase } = require(path.join(REPO, 'dist/database/connection.js'));
  const d = openDatabase(path.join(DATA, 'xbus.sqlite'), { applyPragmas: false });
  const r = d.prepare(sql).all(); d.close(); return r;
}
function ipcSend(sessionId, alias, text) {
  // Inject a peer message directly (a stand-in hostile/peer sender via IPC).
  return new Promise((resolve, reject) => {
    const { IpcClient } = require(path.join(REPO, 'dist/ipc/client.js'));
    const { defaultEndpoint } = require(path.join(REPO, 'dist/ipc/transport.js'));
    const { clientHello } = require(path.join(REPO, 'dist/ipc/hello.js'));
    (async () => {
      const c = new IpcClient(defaultEndpoint(DATA), { requestTimeoutMs: 5000 });
      await c.connect();
      await c.request('hello', clientHello('mcp'));
      await c.request('register_session', { sessionId: 'aaaa1111-0000-4000-8000-00000000a1a1', instanceId: 'peerA', processId: 1, projectId: 'pa', cwd: '/a', receiveMode: 'hook_checkpoint', capabilities: [], role: 'mcp' });
      await c.request('register_alias', { alias });
      const r = await c.request('send_message', { to: 'implementer', text, requiresAck: true, requiresReply: false });
      c.close(); resolve(r.payload);
    })().catch(reject);
  });
}

function bSession(sessionId) {
  const cwd = fs.mkdtempSync(path.join(DATA, 'cwdB-'));
  const child = spawn(process.env.CLAUDE_CODE_EXECPATH || 'claude', [
    '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--session-id', sessionId, '--plugin-dir', REPO, '--allowedTools', ALLOWED,
  ], { cwd, env: { ...process.env, XBUS_DATA_DIR: DATA, CLAUDE_CODE_SESSION_ID: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const waiters = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m.type === 'result') { const w = waiters.shift(); if (w) w(m.result || ''); } } catch {}
    }
  });
  child.stderr.on('data', () => {});
  return {
    turn(text, ms = 80000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('B turn timeout')), ms);
        waiters.push((r) => { clearTimeout(t); resolve(r); });
        child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
      });
    },
    kill() { try { child.kill('SIGKILL'); } catch {} },
  };
}

async function main() {
  L('=== Minimal persistent-session gate ===');
  L(`node=${process.version} data=${DATA}`);
  let broker = startBroker();
  await new Promise((r) => setTimeout(r, 1500));

  const BSID = '22221111-bbbb-4bbb-8bbb-bbbbbbbb1111';
  const B = bSession(BSID);

  // Checkpoint 1: B registers (turn 1 of one persistent process).
  L('[cp1 register] ' + (await B.turn("Call xbus_register alias 'implementer'. Reply REGISTERED.")).slice(0, 40));
  const e0 = db("SELECT active_epoch FROM sessions WHERE session_id='" + BSID + "'")[0];
  L('[epoch after register] ' + JSON.stringify(e0));

  // Peer sends msg1 (direct IPC), then B processes at checkpoint 2 (turn 2).
  const n1 = 'PERSIST1-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  await ipcSend(BSID, 'architect', `first ${n1}`);
  L('[peer sent] ' + n1);
  const r2 = await B.turn("Call xbus_inbox. For each message, call xbus_ack accepted with its messageId and metadata.xbus_receipt. Quote the message text verbatim.");
  L('[cp2 B processed] ' + r2.replace(/\s+/g, ' ').slice(0, 200));

  // Peer sends msg2, B processes at checkpoint 3 (turn 3, SAME open process).
  const n2 = 'PERSIST2-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  await ipcSend(BSID, 'architect', `second ${n2}`);
  const r3 = await B.turn("Call xbus_inbox again. Ack each with its receipt. Quote texts.");
  L('[cp3 B processed] ' + r3.replace(/\s+/g, ' ').slice(0, 200));

  const e1 = db("SELECT active_epoch FROM sessions WHERE session_id='" + BSID + "'")[0];
  const comps = db("SELECT COUNT(*) n FROM component_instances WHERE session_id='" + BSID + "'")[0];
  L('[epoch after 3 checkpoints] ' + JSON.stringify(e1) + ' componentInstances=' + comps.n);

  // --- broker restart while B stays OPEN ---
  L('[restart] killing broker; B stays open');
  broker.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 1200));
  broker = startBroker();
  await new Promise((r) => setTimeout(r, 1500));
  const n3 = 'AFTER-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  await ipcSend(BSID, 'architect', `post-restart ${n3}`);
  const r4 = await B.turn("Call xbus_inbox; ack each message with its receipt; quote texts. Reply DONE.", 90000);
  L('[cp4 after broker restart] ' + r4.replace(/\s+/g, ' ').slice(0, 200));
  const e2 = db("SELECT active_epoch FROM sessions WHERE session_id='" + BSID + "'")[0];

  // Verdicts from broker (source of truth)
  const acked = db("SELECT COUNT(*) n FROM deliveries WHERE recipient_session_id='" + BSID + "' AND state IN ('accepted','completed')")[0].n;
  const seqs = db("SELECT recipient_sequence FROM messages WHERE recipient_session_id='" + BSID + "' ORDER BY recipient_sequence").map((r) => r.recipient_sequence);
  L('');
  L('=== VERDICTS (broker source of truth) ===');
  L('messages accepted across the persistent session: ' + acked + ' (expect 3)');
  L('recipient sequences (monotonic): ' + JSON.stringify(seqs));
  L('epoch stable register->exchange: ' + (e0.active_epoch === e1.active_epoch));
  L('epoch stable across broker restart: ' + (e1.active_epoch === e2.active_epoch));
  L('saw n3 after restart in B output: ' + r4.includes(n3));

  B.kill(); broker.kill('SIGKILL');
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  L('=== done ===');
  process.exit(0);
}
main().catch((e) => { L('GATE ERROR: ' + (e.stack || e.message)); process.exit(1); });
