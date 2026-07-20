/**
 * Broker host: opens the DB, runs migrations, starts the daemon. Used both by
 * the standalone broker process and by in-process tests.
 */
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { openDatabase, type SqliteDriver } from '../database/connection.js';
import { runMigrations } from '../database/migrations.js';
import { BrokerDaemon, type DaemonOptions } from './daemon.js';
import { defaultEndpoint, ensureDataDir } from '../ipc/transport.js';
import { systemClock, uuidIdGen, type Clock, type IdGen } from '../shared/clock.js';
import { existsSync as fsExists } from 'node:fs';
import { writeStateFile, removeStateFileIfOwned, ownerIdentityHash } from './state-file.js';
import { osProcessCreationTimeMs } from './liveness-proof.js';
import { hardenFile } from '../ipc/acl.js';
import { BUILD_ID, SCHEMA_VERSION } from '../protocol/handshake.js';
import { readProvenance, resolveIdentity, provenancePathFromDist } from '../shared/build-identity.js';
import { checkSingleton } from './singleton.js';
import { loadOrCreateRootSecret } from '../ipc/root-secret.js';
import { XBusError, XBusErrorCode } from '../protocol/errors.js';
import { DashboardServer } from './dashboard/server.js';
import { DashboardAuth } from './dashboard/auth.js';
import { WorkerReadExecutor } from './dashboard/read-worker.js';
import { BrokerStore } from './store.js';
import { ensureOperatorSession } from './operator.js';
import { scanTranscripts } from './session-import.js';

export interface BrokerHostOptions extends DaemonOptions {
  dataDir: string;
  clock?: Clock;
  ids?: IdGen;
  /** Write the broker state file + enable IPC shutdown (default true). Tests that
   *  run multiple in-process brokers in one dir can disable it. */
  writeStateFile?: boolean;
  /** Called after a graceful IPC-requested stop completes (the CLI exits here). */
  onStopped?: () => void;
  /** Enforce the singleton probe before binding (default true). */
  enforceSingleton?: boolean;
  /** Enable the XBUS-STP secure transport (default true). Tests may disable. */
  secureTransport?: boolean;
  /** Beta.5 Phase 1: start the loopback read-only dashboard alongside the broker
   *  (ADR 0015). Default false in Phase 1 (opt-in until the UI slice + `xbus dashboard`
   *  verb land); when true the broker owns the single HTTP server on 127.0.0.1. A
   *  dashboard start failure is best-effort and NEVER fails broker start (I5). */
  dashboard?: boolean | { port?: number };
  /** Beta.5 Phase 1 (ADR 0013 D5): on start, import previously-existing sessions from the
   *  Claude transcript listing as DORMANT rows (metadata only). Best-effort — a scan/import
   *  failure NEVER fails broker start. Default false (opt-in); when a string, overrides the
   *  projects dir (tests). */
  importDormantSessions?: boolean | { projectsDir?: string };
}

export interface RunningBroker {
  daemon: BrokerDaemon;
  db: SqliteDriver;
  endpoint: string;
  brokerInstanceId: string;
  /** Present when the secure transport is enabled — clients need it to connect. */
  rootSecret?: Buffer;
  /** Present when a dashboard was started (ADR 0015). */
  dashboard?: DashboardServer;
  dashboardUrl?: string;
  stop(): Promise<void>;
}

export async function startBrokerHost(opts: BrokerHostOptions): Promise<RunningBroker> {
  ensureDataDir(opts.dataDir);
  const dbPath = path.join(opts.dataDir, 'xbus.sqlite');
  const endpoint = defaultEndpoint(opts.dataDir);
  const clock = opts.clock ?? systemClock;
  const ids = opts.ids ?? uuidIdGen;
  const db = openDatabase(dbPath, { applyPragmas: true });
  // Harden the DB + WAL/SHM sidecars (Windows ACL / Unix mode). Best-effort: the
  // data dir is already hardened, so sidecars created later inherit it on Unix;
  // on Windows we set each explicitly where present.
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { if (fsExists(f)) hardenFile(f); } catch { /* best effort */ }
  }
  runMigrations(db, clock.nowIso());
  // Beta.6 Phase 2 (ADR 0021): provision the reserved `local-operator` principal AFTER
  // migrations (its columns exist) and BEFORE the daemon binds (a reply may route to it as
  // soon as delivery starts). Idempotent; never expires; never registers a component.
  ensureOperatorSession(db, clock);
  // Beta.5 Phase 1 (ADR 0013 D5): best-effort dormant import from the transcript LISTING
  // (metadata only). A scan/import failure must NEVER fail broker start (I5), so it is
  // wrapped + swallowed with a log note. Runs once at start, before the daemon binds.
  if (opts.importDormantSessions) {
    try {
      const projectsDir = typeof opts.importDormantSessions === 'object' ? opts.importDormantSessions.projectsDir : undefined;
      const metas = scanTranscripts(projectsDir);
      if (metas.length > 0) {
        const importStore = new BrokerStore(db, clock, ids, 'importer');
        const r = importStore.importDormantSessions(metas);
        opts.log?.(`imported ${r.imported} dormant session(s) (${r.skipped} already known)`);
      }
    } catch (e) {
      opts.log?.(`dormant import skipped (continuing): ${(e as Error).message}`);
    }
  }
  const brokerInstanceId = uuidv7();
  const daemonOpts: DaemonOptions = {};
  // Secure transport (XBUS-STP): load/create the per-installation root secret and
  // enable it by default. Tests can opt out with secureTransport:false.
  let rootSecret: Buffer | undefined;
  if (opts.secureTransport !== false) {
    rootSecret = loadOrCreateRootSecret(opts.dataDir);
    daemonOpts.rootSecret = rootSecret;
  }
  if (opts.authSecret !== undefined) daemonOpts.authSecret = opts.authSecret;
  if (opts.ackDeadlineMs !== undefined) daemonOpts.ackDeadlineMs = opts.ackDeadlineMs;
  if (opts.requireReceipt !== undefined) daemonOpts.requireReceipt = opts.requireReceipt;
  // Timer intervals passthrough: without these, a caller-supplied reaper / ledger-verify
  // interval was silently dropped and the daemon always used its hardcoded defaults (the
  // BrokerHostOptions type advertised them, but the host never forwarded them — a
  // non-functional, untestable option). Forward both so the periodic audit-ledger verify
  // (blocker #7) and reaper cadence are actually configurable through startBrokerHost.
  if (opts.reaperIntervalMs !== undefined) daemonOpts.reaperIntervalMs = opts.reaperIntervalMs;
  if (opts.ledgerVerifyIntervalMs !== undefined) daemonOpts.ledgerVerifyIntervalMs = opts.ledgerVerifyIntervalMs;
  // §3 transport resource bounds passthrough.
  if (opts.maxConnections !== undefined) daemonOpts.maxConnections = opts.maxConnections;
  if (opts.idleTimeoutMs !== undefined) daemonOpts.idleTimeoutMs = opts.idleTimeoutMs;
  if (opts.globalBufferBudgetBytes !== undefined) daemonOpts.globalBufferBudgetBytes = opts.globalBufferBudgetBytes;
  if (opts.connectRatePerSec !== undefined) daemonOpts.connectRatePerSec = opts.connectRatePerSec;
  if (opts.handshakeTimeoutMs !== undefined) daemonOpts.handshakeTimeoutMs = opts.handshakeTimeoutMs;
  if (opts.log !== undefined) daemonOpts.log = opts.log;
  // Singleton acquisition (reliability contract §14): probe for an existing
  // reachable broker BEFORE binding; map a bind race (EADDRINUSE) to a typed,
  // actionable error instead of a raw OS error.
  if (opts.enforceSingleton !== false) {
    const probe = await checkSingleton(opts.dataDir, endpoint);
    if (probe.outcome === 'already_running') {
      db.close();
      throw new XBusError(XBusErrorCode.BROKER_ALREADY_RUNNING, probe.detail, { endpoint });
    }
    // 'contended' / 'stale_cleared' / 'acquired' all proceed to bind; the bind
    // itself is the atomic arbiter (a true concurrent race yields EADDRINUSE below).
  }

  const daemon = new BrokerDaemon(db, endpoint, clock, ids, brokerInstanceId, daemonOpts);
  try {
    await daemon.start();
  } catch (e) {
    db.close();
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new XBusError(XBusErrorCode.BROKER_CONTENDED, 'another broker won the bind race for this data directory; connect to it or retry', { endpoint });
    }
    throw e;
  }

  // Beta.5 Phase 1 (ADR 0015): start the loopback read-only dashboard alongside the
  // broker, best-effort — a dashboard failure must NEVER fail broker start (I5). The
  // broker owns the single HTTP server; the read path is an OFF-LOOP worker with its own
  // readOnly:true handle (ADR 0020 Q5), so it cannot stall delivery or mutate the DB.
  let dashboard: DashboardServer | undefined;
  let dashboardUrl: string | undefined;
  if (opts.dashboard) {
    try {
      const auth = new DashboardAuth(clock);
      const reader = new WorkerReadExecutor(dbPath, { requestTimeoutMs: 5000 });
      const wantPort = typeof opts.dashboard === 'object' && opts.dashboard.port !== undefined ? opts.dashboard.port : 0;
      dashboard = new DashboardServer({
        auth, reader, host: '127.0.0.1', port: wantPort, ...(opts.log ? { log: opts.log } : {}),
        // Beta.6 Phase 2 (ADR 0021): the operator console's WRITE seam. The dashboard route
        // (already bearer-authenticated) forwards the payload to these daemon methods, which
        // run the transactional store op on the BROKER LOOP (the single writer) and stamp the
        // reserved 'local-operator' identity server-side. The dashboard's own DB handle stays
        // read-only. A throw surfaces to the route as a clean 4xx; the broker is unaffected.
        onOperatorSend: (payload) => daemon.operatorSend(payload),
        onMarkThreadRead: (payload) => daemon.operatorMarkThreadRead(payload),
        onOperatorControl: (payload) => daemon.operatorControl(payload),
        onOperatorRedeliver: (payload) => daemon.operatorRedeliver(payload),
        onOperatorCollections: (payload) => daemon.operatorReplaceCollections(payload),
        onOperatorSchedule: (payload) => daemon.operatorSchedule(payload),
      });
      await dashboard.start();
      dashboardUrl = dashboard.url;
      // Push live snapshots to open streams on every session-state / thread mutation (off-loop read).
      daemon.onSessionStateChanged = () => dashboard!.notifyChange();
      // Beta.5 (blocker #3): let the `xbus dashboard` CLI mint a one-time open-URL over IPC.
      // mintOpenUrl() returns `${url}/#n=<nonce>` (nonce in fragment, single-use, short-TTL);
      // it travels back on the encrypted IPC channel only — never logged/persisted.
      daemon.dashboardUrlMinter = () => ({ url: dashboard!.mintOpenUrl(), dashboardUrl: dashboard!.url });
    } catch (e) {
      opts.log?.(`dashboard start failed (continuing without it): ${(e as Error).message}`);
      try { await dashboard?.stop(); } catch { /* ignore */ }
      dashboard = undefined;
      dashboardUrl = undefined;
    }
  }

  // Write the identity-rich state file (ADR 0007) so `xbus stop` can target this
  // broker safely. Atomic + user-only perms; written only if a dataDir is real.
  let stopped = false;
  const doStop = async () => {
    if (stopped) return;
    stopped = true;
    // Stop the dashboard FIRST (its off-loop worker holds a read-only DB handle; close it
    // before the writer's db.close()). Best-effort.
    if (dashboard) { try { await dashboard.stop(); } catch { /* ignore */ } }
    await daemon.stop();
    removeStateFileIfOwned(opts.dataDir, brokerInstanceId);
    db.close();
  };
  if (opts.writeStateFile !== false) {
    // §8: record the EXACT build id (from provenance) in the state file so a
    // stale broker is distinguishable from a newer one — not just by the
    // compatibility tuple (which is identical across the line). Fail-soft to a
    // source identity (the broker must not fail to start over provenance).
    const stateIdentity = (() => {
      try { return resolveIdentity(SCHEMA_VERSION, readProvenance(provenancePathFromDist(import.meta.url))); }
      catch { return resolveIdentity(SCHEMA_VERSION, null); }
    })();
    // Beta.10 Stage 0 (recycled-PID fix): record THIS broker's OS process-creation time via the
    // SAME reader the liveness proof uses on the way back in, so a real broker round-trips to an
    // EQUAL value (guards the inverse-failure where a real broker is mislabeled 'recycled'). Best
    // effort: null on an unreadable host → the liveness proof falls back to the handshake arm.
    const processCreatedAt = osProcessCreationTimeMs(process.pid);
    writeStateFile(opts.dataDir, {
      pid: process.pid,
      processStartedAt: clock.nowIso(),
      ...(processCreatedAt != null ? { processCreatedAt } : {}),
      brokerInstanceId,
      buildId: BUILD_ID,
      exactBuildId: stateIdentity.buildId,
      sourceCommit: stateIdentity.sourceCommit,
      endpoint,
      ownerIdentityHash: ownerIdentityHash(),
      ...(dashboard ? { dashboardPort: dashboard.port, dashboardUrl: dashboard.url } : {}),
    });
    // The authenticated IPC shutdown path triggers a graceful stop. The host
    // does NOT exit the process — the caller (CLI start loop) decides that via
    // the optional onStopped hook, so in-process tests aren't terminated.
    daemon.onShutdownRequested = () => { void doStop().then(() => opts.onStopped?.()); };
  }

  return {
    daemon,
    db,
    endpoint,
    brokerInstanceId,
    ...(rootSecret ? { rootSecret } : {}),
    ...(dashboard && dashboardUrl ? { dashboard, dashboardUrl } : {}),
    stop: doStop,
  };
}
