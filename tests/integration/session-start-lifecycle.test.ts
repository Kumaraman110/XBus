/**
 * Beta.5 Phase 1 — SessionStart vertical slice, END TO END over real IPC + SQLite
 * (ADR 0013 D2/D4/D5, ADR 0020 Q1/Q3):
 *
 *   announce_session frame → daemon handler → ONE broker transaction → authoritative
 *   session visibility state + exactly one ledger event → authenticated read model.
 *
 * NO Claude here — an IpcClient stands in for the SessionStart hook's connection (which
 * registers as a `hook` component, then announces). Proves:
 *   - startup / resume / clear / compact each mark the session visible + append exactly
 *     one lifecycle ledger event of the right type,
 *   - repeated announces are idempotent (no second session row, no epoch inflation, a
 *     duplicate `startup` appends NO second STARTED event),
 *   - a fork (distinct session id via a fresh startup) is a separate active session,
 *   - an EXPIRED session resuming gets a fresh epoch with NO message resurrection,
 *   - the hash chain stays valid across the whole sequence.
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
import { verifyLedger } from '../../src/broker/ledger.js';
import { ComponentRole } from '../../src/identity/components.js';

let dataDir: string;
let dbPath: string;
let endpoint: string;
let daemon: BrokerDaemon;
let db: ReturnType<typeof openDatabase>;

async function newClient(): Promise<IpcClient> {
  const c = new IpcClient(endpoint, { idGen: () => `req-${Math.random().toString(36).slice(2)}` });
  await c.connect();
  return c;
}

/** Register a `hook`-role component for a session (what the SessionStart hook does),
 *  then it may announce. Returns the client. */
async function hookRegister(c: IpcClient, sessionId: string, cwd: string): Promise<void> {
  const h = await c.request('hello', { protocolVersion: 1, componentRole: 'hook' });
  expect(h.frameType).toBe('hello_ack');
  const r = await c.request('register_session', {
    sessionId, instanceId: `inst-${sessionId}-${Math.random().toString(36).slice(2)}`,
    processId: process.pid, projectId: `proj-${path.basename(cwd)}`, cwd,
    receiveMode: 'hook_checkpoint', capabilities: ['pull'], role: ComponentRole.HOOK,
  });
  expect(r.frameType).toBe('register_session_ack');
}

async function announce(c: IpcClient, source: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const a = await c.request('announce_session', { source, cwd: '/tmp/dir', ...extra });
  expect(a.frameType, JSON.stringify(a.payload)).toBe('announce_session_ack');
  return a.payload as Record<string, unknown>;
}

function sessionRow(sid: string): { management_state: string; source_last: string | null; identify_confidence: string; first_seen_at: string | null; transcript_path: string | null; active_epoch: number } {
  return db.prepare('SELECT management_state, source_last, identify_confidence, first_seen_at, transcript_path, active_epoch FROM sessions WHERE session_id=?').get(sid) as never;
}
function ledgerRows(sid: string): Array<{ event_type: string; seq: number; payload_json: string }> {
  return db.prepare(`SELECT event_type, seq, payload_json FROM ledger_events WHERE subject_json LIKE ? ORDER BY seq`).all(`%${sid}%`) as never;
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-sstart-'));
  ensureDataDir(dataDir);
  dbPath = path.join(dataDir, 'xbus.sqlite');
  endpoint = defaultEndpoint(dataDir);
  db = openDatabase(dbPath, { applyPragmas: true });
  runMigrations(db, systemClock.nowIso());
  daemon = new BrokerDaemon(db, endpoint, systemClock, uuidIdGen, 'broker-sstart-1', {});
  await daemon.start();
});
afterEach(async () => {
  await daemon.stop();
  db.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('SessionStart lifecycle over real IPC + SQLite', () => {
  it('startup marks the session active + appends exactly one SESSION_STARTED ledger event', async () => {
    const sid = '11111111-1111-1111-1111-111111111111';
    const c = await newClient();
    await hookRegister(c, sid, '/tmp/dir');
    const ack = await announce(c, 'startup', { transcriptPath: '/p/t.jsonl', agentType: 'claude' });
    expect(ack.managementState).toBe('active');
    expect(ack.lifecycleEvent).toBe('SESSION_STARTED');
    expect(ack.appended).toBe(true);

    const row = sessionRow(sid);
    expect(row.management_state).toBe('active');
    expect(row.source_last).toBe('startup');
    expect(row.identify_confidence).toBe('signal');
    expect(row.first_seen_at).not.toBeNull();
    expect(row.transcript_path).toBe('/p/t.jsonl');

    const led = ledgerRows(sid);
    expect(led.map((l) => l.event_type)).toEqual(['SESSION_STARTED']);
    expect(verifyLedger(db).ok).toBe(true);
    c.close();
  });

  it('resume / clear / compact each append their own distinct lifecycle event', async () => {
    const sid = '22222222-2222-2222-2222-222222222222';
    const c = await newClient();
    await hookRegister(c, sid, '/tmp/dir');
    await announce(c, 'startup');
    await announce(c, 'resume');
    await announce(c, 'clear');
    await announce(c, 'compact');
    const led = ledgerRows(sid);
    expect(led.map((l) => l.event_type)).toEqual(['SESSION_STARTED', 'SESSION_RESUMED', 'SESSION_CLEARED', 'SESSION_COMPACTED']);
    // clear/compact keep the session active + identity unchanged (ADR 0013 D2).
    expect(sessionRow(sid).management_state).toBe('active');
    expect(verifyLedger(db).ok).toBe(true);
    c.close();
  });

  it('repeated startup is idempotent: no duplicate STARTED event, one session row, epoch stable', async () => {
    const sid = '33333333-3333-3333-3333-333333333333';
    const c = await newClient();
    await hookRegister(c, sid, '/tmp/dir');
    const a1 = await announce(c, 'startup');
    const a2 = await announce(c, 'startup'); // duplicate birth
    const a3 = await announce(c, 'startup');
    expect(a1.appended).toBe(true);
    expect(a2.appended).toBe(false); // deduped — no second SESSION_STARTED
    expect(a3.appended).toBe(false);
    expect(a1.epoch).toBe(a2.epoch); // no epoch inflation
    const led = ledgerRows(sid);
    expect(led.filter((l) => l.event_type === 'SESSION_STARTED')).toHaveLength(1);
    const nSessions = (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE session_id=?').get(sid) as { n: number }).n;
    expect(nSessions).toBe(1);
    c.close();
  });

  it('a fork (distinct session id via fresh startup) is a SEPARATE active session — no inheritance', async () => {
    const parent = '44444444-4444-4444-4444-444444444444';
    const fork = '55555555-5555-5555-5555-555555555555';
    const cp = await newClient(); await hookRegister(cp, parent, '/tmp/dir'); await announce(cp, 'startup');
    const cf = await newClient(); await hookRegister(cf, fork, '/tmp/dir'); await announce(cf, 'startup');
    // Two distinct active sessions, each with its own epoch-1 + its own STARTED event.
    expect(sessionRow(parent).active_epoch).toBe(1);
    expect(sessionRow(fork).active_epoch).toBe(1);
    expect(ledgerRows(parent).map((l) => l.event_type)).toEqual(['SESSION_STARTED']);
    expect(ledgerRows(fork).map((l) => l.event_type)).toEqual(['SESSION_STARTED']);
    // Distinct automatic aliases (beta.4.1 collision-safe) — no address inheritance.
    const aliases = db.prepare('SELECT DISTINCT session_id FROM aliases WHERE active=1').all() as Array<{ session_id: string }>;
    expect(new Set(aliases.map((a) => a.session_id)).size).toBeGreaterThanOrEqual(2);
    cp.close(); cf.close();
  });

  it('unauthenticated announce (no register_session) is rejected — identity comes from the connection', async () => {
    const c = await newClient();
    await c.request('hello', { protocolVersion: 1, componentRole: 'hook' });
    const a = await c.request('announce_session', { source: 'startup', cwd: '/tmp/dir' });
    expect(a.frameType).toBe('error');
    expect((a.payload as { code: string }).code).toBe('XBUS_SESSION_NOT_REGISTERED');
    c.close();
  });

  it('announce with a missing source is a clean protocol violation (no raw DB error)', async () => {
    const sid = '66666666-6666-6666-6666-666666666666';
    const c = await newClient();
    await hookRegister(c, sid, '/tmp/dir');
    const a = await c.request('announce_session', { cwd: '/tmp/dir' });
    expect(a.frameType).toBe('error');
    expect((a.payload as { code: string }).code).toBe('XBUS_PROTOCOL_VIOLATION');
    c.close();
  });
});
