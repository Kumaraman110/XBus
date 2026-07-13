/**
 * AUDIT-LEDGER OPERABILITY (beta.5 blocker #7 acceptance): prove the END-TO-END wiring, not
 * just the verifyLedger primitive —
 *   - the broker verifies the chain ON STARTUP (a LEDGER_VERIFIED audit row + a dashboard
 *     lastVerifiedAt freshness stamp exist right after start, with no manual call),
 *   - a PERIODIC verify re-runs on the configured interval (a second LEDGER_VERIFIED appears),
 *   - a BROKEN chain is surfaced honestly (verifyLedgerNow records LEDGER_CHAIN_BROKEN + the
 *     dashboard auditStatus reports ok:false + the first bad seq) and is NOT masked,
 *   - the append-only enforcement itself is DIRECTLY asserted (a plain UPDATE/DELETE on
 *     ledger_events is rejected by the trigger — the tamper tests elsewhere DROP the trigger,
 *     so this is the one place that proves the trigger actually fires).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startBrokerHost, type RunningBroker } from '../../src/broker/host.js';
import { IpcClient } from '../../src/ipc/client.js';
import { defaultEndpoint } from '../../src/ipc/transport.js';
import { doHello } from '../../src/ipc/hello.js';
import { ComponentRole } from '../../src/identity/components.js';
import { DashboardReadModel } from '../../src/broker/dashboard/read-model.js';
import { openDatabase } from '../../src/database/connection.js';

let dataDir: string; let broker: RunningBroker; let endpoint: string; let rootSecret: Buffer;

async function announceOne(sessionId: string): Promise<void> {
  const c = new IpcClient(endpoint, { rootSecret, requestTimeoutMs: 5000, helloIdentity: { claimedRole: 'hook', claimedSessionId: sessionId } });
  await c.connect();
  await doHello(c, ComponentRole.HOOK);
  await c.request('register_session', { sessionId, instanceId: `i-${sessionId}`, processId: process.pid, projectId: 'p', cwd: '/tmp/x', receiveMode: 'hook_checkpoint', capabilities: ['pull'], role: ComponentRole.HOOK });
  await c.request('announce_session', { source: 'startup', cwd: '/tmp/x' });
  c.close();
}
const countAudit = (b: RunningBroker, type: string): number =>
  (b.db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE event_type=?`).get(type) as { n: number }).n;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-ledgerop-'));
  endpoint = defaultEndpoint(dataDir);
});
afterEach(async () => {
  if (broker) { try { await broker.stop(); } catch { /* ignore */ } }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('audit-ledger operability — startup + periodic verify, honest break, append-only enforcement', () => {
  it('verifies on startup: a LEDGER_VERIFIED row + a dashboard lastVerifiedAt stamp exist right after start', async () => {
    // Long interval so ONLY the startup verify has run when we observe.
    broker = await startBrokerHost({ dataDir, enforceSingleton: false, ledgerVerifyIntervalMs: 60 * 60_000 });
    rootSecret = broker.rootSecret!;
    expect(countAudit(broker, 'LEDGER_VERIFIED'), 'startup verify recorded a LEDGER_VERIFIED row').toBeGreaterThanOrEqual(1);
    // The dashboard freshness stamp is populated (read over a physically read-only handle).
    const ro = openDatabase(path.join(dataDir, 'xbus.sqlite'), { readOnly: true });
    try {
      const status = new DashboardReadModel(ro).auditStatus();
      expect(status.ok, 'clean chain reports ok').toBe(true);
      expect(status.lastVerifiedAt, 'lastVerifiedAt freshness stamp is set after startup verify').not.toBeNull();
      expect(status.firstBreakSeq).toBeNull();
    } finally { ro.close(); }
  }, 60_000);

  it('verifies PERIODICALLY: a second LEDGER_VERIFIED appears on the interval (not just at startup)', async () => {
    // Short interval so a periodic tick fires during the test.
    broker = await startBrokerHost({ dataDir, enforceSingleton: false, ledgerVerifyIntervalMs: 150 });
    rootSecret = broker.rootSecret!;
    const afterStartup = countAudit(broker, 'LEDGER_VERIFIED');
    // Wait out a couple of intervals; the periodic timer must record additional verifies.
    await new Promise((r) => setTimeout(r, 700));
    expect(countAudit(broker, 'LEDGER_VERIFIED'), 'periodic verify keeps recording LEDGER_VERIFIED rows').toBeGreaterThan(afterStartup);
  }, 60_000);

  it('surfaces a BROKEN chain honestly on verifyLedgerNow (LEDGER_CHAIN_BROKEN + dashboard ok:false), never masked', async () => {
    broker = await startBrokerHost({ dataDir, enforceSingleton: false, ledgerVerifyIntervalMs: 60 * 60_000 });
    rootSecret = broker.rootSecret!;
    await announceOne('60606060-6060-4060-8060-00000000000a'); // real ledger event to tamper
    expect(broker.daemon.verifyLedgerNow().ok, 'chain intact before tamper').toBe(true);

    // Tamper out-of-band: drop the append-only trigger, mutate, restore.
    broker.db.exec('DROP TRIGGER ledger_no_update');
    broker.db.prepare("UPDATE ledger_events SET payload_json='{\"tampered\":1}' WHERE seq=1").run();
    broker.db.exec("CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_events BEGIN SELECT RAISE(ABORT,'ledger_events is append-only'); END");

    const v = broker.daemon.verifyLedgerNow();
    expect(v.ok, 'verifyLedgerNow reports the break').toBe(false);
    expect(v.firstBreakSeq, 'break localized').toBe(1);
    expect(countAudit(broker, 'LEDGER_CHAIN_BROKEN'), 'a LEDGER_CHAIN_BROKEN row is recorded').toBeGreaterThanOrEqual(1);
    // The dashboard read model reports the break honestly (not masked).
    const ro = openDatabase(path.join(dataDir, 'xbus.sqlite'), { readOnly: true });
    try {
      const status = new DashboardReadModel(ro).auditStatus();
      expect(status.ok, 'dashboard reports the broken chain').toBe(false);
      expect(status.firstBreakSeq).toBe(1);
    } finally { ro.close(); }
  }, 60_000);

  it('append-only enforcement: a plain UPDATE and DELETE on ledger_events are REJECTED by the triggers', async () => {
    broker = await startBrokerHost({ dataDir, enforceSingleton: false, ledgerVerifyIntervalMs: 60 * 60_000 });
    rootSecret = broker.rootSecret!;
    await announceOne('60606060-6060-4060-8060-00000000000b'); // ensure a row exists
    expect((broker.db.prepare(`SELECT COUNT(*) AS n FROM ledger_events`).get() as { n: number }).n).toBeGreaterThan(0);
    // These are the enforcement the tamper tests DROP first; here we assert they actually fire.
    expect(() => broker.db.prepare("UPDATE ledger_events SET payload_json='{}' WHERE seq=1").run()).toThrow(/append-only/i);
    expect(() => broker.db.prepare('DELETE FROM ledger_events WHERE seq=1').run()).toThrow(/append-only/i);
  }, 60_000);
});
