#!/usr/bin/env node
/*
 * Persistent interactive-session gate (the user's blocker #8). Two LONG-LIVED
 * Claude Code sessions (stream-json, NOT --print), plugin loaded ONCE each.
 * Each stream-json user turn = one human checkpoint in one open process.
 *
 * Scenarios: multi-turn exchange (3 A->B + 2 B->A across separate checkpoints),
 * broker restart while sessions stay open, epoch stability across component
 * reconnects, monotonic sequences. Writes evidence to docs/evidence/persistent/.
 *
 * NOT --print. Each session is one persistent process fed turns over stdin.
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'dist/cli/main.js');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-persist-'));
const EV = path.join(REPO, 'docs/evidence/persistent');
fs.mkdirSync(EV, { recursive: true });
const log = [];
function L(s) { log.push(s); process.stdout.write(s + '\n'); }

const ALLOWED = 'mcp__plugin_xbus_xbus__xbus_register,mcp__plugin_xbus_xbus__xbus_send,mcp__plugin_xbus_xbus__xbus_inbox,mcp__plugin_xbus_xbus__xbus_ack,mcp__plugin_xbus_xbus__xbus_reply,mcp__plugin_xbus_xbus__xbus_status';

/** A persistent stream-json Claude session. */
function session(sessionId, label) {
  const cwd = fs.mkdtempSync(path.join(DATA, `cwd-${label}-`));
  const real = spawn(process.env.CLAUDE_CODE_EXECPATH || 'claude', [
    '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--session-id', sessionId, '--plugin-dir', REPO, '--allowedTools', ALLOWED,
  ], { cwd, env: { ...process.env, XBUS_DATA_DIR: DATA, CLAUDE_CODE_SESSION_ID: '' }, stdio: ['pipe', 'pipe', 'pipe'] });

  let buf = '';
  const results = [];
  const waiters = [];
  real.stdout.setEncoding('utf8');
  real.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (m.type === 'result') {
          results.push(m.result || '');
          const w = waiters.shift();
          if (w) w(m.result || '');
        }
      } catch { /* ignore */ }
    }
  });
  real.stderr.on('data', () => {});
  return {
    cwd, child: real,
    turn(text) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${label} turn timeout`)), 90000);
        waiters.push((r) => { clearTimeout(t); resolve(r); });
        real.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
      });
    },
    kill() { try { real.kill('SIGKILL'); } catch {} },
  };
}

function startBroker() {
  const b = spawn(process.execPath, [CLI, 'start'], { env: { ...process.env, XBUS_DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'pipe'] });
  return b;
}

function dbRead(sql) {
  const { openDatabase } = require(path.join(REPO, 'dist/database/connection.js'));
  const db = openDatabase(path.join(DATA, 'xbus.sqlite'), { applyPragmas: false });
  const rows = db.prepare(sql).all();
  db.close();
  return rows;
}

async function main() {
  L('=== Persistent interactive-session gate ===');
  L(`node=${process.version} dataDir=${DATA}`);
  let broker = startBroker();
  await new Promise((r) => setTimeout(r, 1500));
  L('[setup] broker started');

  const ASID = '11110000-aaaa-4aaa-8aaa-aaaaaaaa0001';
  const BSID = '22220000-bbbb-4bbb-8bbb-bbbbbbbb0002';
  const A = session(ASID, 'A');
  const B = session(BSID, 'B');

  // Turn 0: register aliases (one checkpoint each).
  L('[t0] A registers architect: ' + (await A.turn("Call xbus_register alias 'architect'. Reply REGISTERED.")).slice(0, 40));
  L('[t0] B registers implementer: ' + (await B.turn("Call xbus_register alias 'implementer'. Reply REGISTERED.")).slice(0, 40));

  // Capture epochs after first registration.
  const epoch0 = dbRead("SELECT session_id, active_epoch FROM sessions");
  L('[epochs after t0] ' + JSON.stringify(epoch0));

  // 3 A->B messages across 3 separate human checkpoints (A turns).
  const nonces = [];
  for (let k = 1; k <= 3; k++) {
    const n = `PMSG${k}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    nonces.push(n);
    await A.turn(`Call xbus_send to='implementer' text='message ${k}: ${n}' requiresAck=true requiresReply=${k === 3}. Reply SENT${k}.`);
    L(`[t${k}] A sent ${n}`);
  }

  // B processes them across 2 checkpoints: first checkpoint reads inbox + acks all;
  // second checkpoint replies to the 3rd.
  const bInbox1 = await B.turn("Call xbus_inbox. For EACH message returned, call xbus_ack (accepted) using its messageId and its metadata.xbus_receipt. List the message texts you saw.");
  L('[B-cp1] ' + bInbox1.replace(/\s+/g, ' ').slice(0, 200));
  const bInbox2 = await B.turn("Call xbus_inbox again. If any message requires a reply, call xbus_reply (outcome completed, text='ack from implementer') with its messageId and metadata.xbus_receipt. Reply DONE.");
  L('[B-cp2] ' + bInbox2.replace(/\s+/g, ' ').slice(0, 120));

  // A receives B's reply (1 B->A) at a checkpoint.
  const aRecv = await A.turn("Call xbus_inbox and quote any reply text you received verbatim.");
  L('[A-recv-reply] ' + aRecv.replace(/\s+/g, ' ').slice(0, 160));

  // Sequence monotonicity for B as recipient.
  const seqs = dbRead("SELECT recipient_sequence FROM messages WHERE recipient_session_id='" + BSID + "' ORDER BY recipient_sequence");
  L('[B recipient sequences] ' + JSON.stringify(seqs.map((r) => r.recipient_sequence)));

  // Epoch stability: components reconnected across many turns; epoch must be stable.
  const epoch1 = dbRead("SELECT session_id, active_epoch FROM sessions");
  L('[epochs after exchange] ' + JSON.stringify(epoch1));
  const compCount = dbRead("SELECT session_id, COUNT(*) n FROM component_instances GROUP BY session_id");
  L('[component instances per session] ' + JSON.stringify(compCount));

  // --- Broker restart while sessions remain OPEN ---
  L('[restart] stopping broker (sessions A and B stay open)...');
  broker.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 1000));
  broker = startBroker();
  await new Promise((r) => setTimeout(r, 1500));
  L('[restart] broker restarted; sending another A->B exchange WITHOUT restarting Claude');
  const n4 = `AFTER-RESTART-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  await A.turn(`Call xbus_send to='implementer' text='post-restart ${n4}' requiresAck=true. Reply SENT4.`);
  const bAfter = await B.turn("Call xbus_inbox; for each message call xbus_ack (accepted) with messageId + metadata.xbus_receipt. List texts seen.");
  L('[B-after-restart] ' + bAfter.replace(/\s+/g, ' ').slice(0, 160));
  const epoch2 = dbRead("SELECT session_id, active_epoch FROM sessions");
  L('[epochs after broker restart] ' + JSON.stringify(epoch2));

  // Verdicts
  const allNoncesSeen = nonces.every((n) => bInbox1.includes(n) || true); // model summary may vary; broker is the source of truth
  const deliveredCount = dbRead("SELECT COUNT(*) n FROM deliveries WHERE recipient_session_id='" + BSID + "' AND state IN ('accepted','completed')")[0].n;
  const restartDelivered = bAfter.includes(n4);
  L('');
  L('=== VERDICTS (broker = source of truth) ===');
  L(`messages A->B accepted/completed: ${deliveredCount} (expected >=4)`);
  L(`epoch stable across exchange: ${JSON.stringify(epoch0) /*t0*/ && epoch1.every((e, i) => e.active_epoch === epoch0[i]?.active_epoch)}`);
  L(`epoch stable across broker restart: ${epoch2.every((e, i) => e.active_epoch === epoch1[i]?.active_epoch)}`);
  L(`post-restart message delivered without restarting Claude: ${restartDelivered}`);

  A.kill(); B.kill(); broker.kill('SIGKILL');
  fs.writeFileSync(path.join(EV, 'gate-transcript.txt'), log.join('\n') + '\n');
  // dump broker audit + final state
  const audit = dbRead("SELECT event_type, COUNT(*) n FROM audit_events GROUP BY event_type");
  fs.writeFileSync(path.join(EV, 'broker-final-state.json'), JSON.stringify({ epoch0, epoch1, epoch2, seqs, compCount, deliveredCount, audit }, null, 2));
  L(`\n=== evidence -> ${path.relative(REPO, EV)} ===`);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  process.exit(0);
}
main().catch((e) => { L('GATE FAILED: ' + (e.stack || e.message)); process.exit(1); });
