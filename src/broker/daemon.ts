/**
 * Broker daemon: binds the IPC server to the store + delivery ops, and tracks
 * per-connection session authority (sessionId↔instanceId↔connection binding).
 *
 * Authority is derived from the CONNECTION, never from frame payloads. A frame
 * that performs a privileged op (send/ack/reply/checkpoint) is only honored if
 * its connection has completed register_session and still holds the current
 * fencing token for that session.
 */
import type { SqliteDriver } from '../database/connection.js';
import type { Clock, IdGen } from '../shared/clock.js';
import { IpcServer, type ServerConn, type ServerOptions } from '../ipc/server.js';
import { makeFrame, type Frame, type FrameType, type RegisterPayload } from '../protocol/commands.js';
import { BrokerStore, type SessionAuthority } from './store.js';
import { DeliveryOps, INJECTION_METADATA_KEY } from './delivery.js';
import { Reaper, type SweepResult } from './reaper.js';
import { DeadLetterStore } from './deadletter.js';
import { ControlsStore, type ReceiveControl } from './controls.js';
import type { ReadinessHints } from './readiness.js';
import { XBusError, XBusErrorCode, isXBusError } from '../protocol/errors.js';
import { validateSendInput } from '../protocol/schemas.js';
import { ComponentRole, isComponentRole, assertAllowed, Operation } from '../identity/components.js';
import { checkCompatibility, brokerHelloInfo, SCHEMA_VERSION, BUILD_ID, type HelloInfo } from '../protocol/handshake.js';
import { readProvenance, resolveIdentity, provenancePathFromDist, type Provenance } from '../shared/build-identity.js';
import { BrokerMetrics, type MetricsGauges, type MetricsSnapshot } from '../observability/metrics.js';
import { evaluateRegistration, type AdapterRegistrationDeclaration } from '../adapter-broker/enforce.js';
import { TrustedEvidenceRegistry } from '../adapter-broker/trusted-evidence.js';
import type { AwardedSupport } from '../adapter/evidence.js';

export interface DaemonOptions {
  authSecret?: string;
  /** Installation root secret — enables the secure transport (XBUS-STP). */
  rootSecret?: Buffer;
  ackDeadlineMs?: number;
  /** Require the one-time receipt capability for ack/reply (ADR 0003). Default true. */
  requireReceipt?: boolean;
  /** Reaper sweep interval (ms). 0 disables the periodic timer (tests drive it
   *  explicitly via runReaperSweep). Default 30s. */
  reaperIntervalMs?: number;
  /** IPC transport resource bounds (§3). Passed through to the IpcServer. */
  maxConnections?: number;
  idleTimeoutMs?: number;
  globalBufferBudgetBytes?: number;
  connectRatePerSec?: number;
  handshakeTimeoutMs?: number;
  log?: (line: string) => void;
}

export class BrokerDaemon {
  private ipc: IpcServer | null = null;
  private store: BrokerStore;
  private delivery: DeliveryOps;
  private controls: ControlsStore;
  private reaper: Reaper;
  private deadLetters: DeadLetterStore;
  private readonly metrics: BrokerMetrics;
  private reaperTimer: NodeJS.Timeout | null = null;
  private readonly reaperIntervalMs: number;
  private connAuth = new Map<string, SessionAuthority>();
  private connHello = new Set<string>();
  /** In-memory awarded support per connection (adapter-aware registrations only; never persisted).
   *  This is REGISTRATION-AWARD state: it records what the broker awarded at register time and is
   *  consulted at register time to enforce the requested receive mode. It is NOT yet an
   *  authorization gate for later operations (progress/streaming/live delivery); PR3 may consume
   *  it in the Claude adapter path after separate authorization. */
  private connAwarded = new Map<string, AwardedSupport>();
  /** Broker-OWNED trusted-evidence registry. Adapter frames can neither read nor write it;
   *  only broker validation code records into it. In-memory only (no persistence). */
  private readonly trustedEvidence = new TrustedEvidenceRegistry();
  private readonly authSecret: string | undefined;
  private readonly rootSecret: Buffer | undefined;
  private readonly serverTuning: Pick<DaemonOptions, 'maxConnections' | 'idleTimeoutMs' | 'globalBufferBudgetBytes' | 'connectRatePerSec' | 'handshakeTimeoutMs'>;
  private readonly log: (line: string) => void;
  /** This broker's EXACT build identity, resolved from the packaged
   *  provenance.json (or a labelled source identity from a dev run). See ADR 0011. */
  private readonly identity: Provenance;

  constructor(
    private readonly db: SqliteDriver,
    private readonly endpoint: string,
    private readonly clock: Clock,
    private readonly ids: IdGen,
    private readonly brokerInstanceId: string,
    opts: DaemonOptions = {},
  ) {
    this.store = new BrokerStore(db, clock, ids, brokerInstanceId);
    this.controls = new ControlsStore(db, clock);
    // The real daemon REQUIRES the one-time receipt capability for ack/reply
    // (ADR 0003). Receipt issuance happens at hook checkpoint injection.
    this.delivery = new DeliveryOps(db, clock, ids, opts.ackDeadlineMs ?? 5 * 60_000, undefined, { requireReceipt: opts.requireReceipt ?? true });
    // Real process: jitter the retry backoff with Math.random (full jitter).
    // Deterministic tests construct Reaper directly with a fixed rng.
    this.reaper = new Reaper(db, clock, ids, { rng: () => Math.random() });
    // Dead-letter inspection store, surfaced via the admin-gated
    // `dead_letter` frame (read-only list/inspect — safe metadata only).
    this.deadLetters = new DeadLetterStore(db, clock, ids);
    // Resolve this broker's exact identity once (provenance.json next to the
    // installed binaries, else a labelled source identity). Fail-soft: a malformed
    // provenance degrades to source identity here (the artifact contract + installer
    // are the fail-CLOSED gates; the running broker must not crash on it).
    this.identity = (() => {
      try { return resolveIdentity(SCHEMA_VERSION, readProvenance(provenancePathFromDist(import.meta.url))); }
      catch { return resolveIdentity(SCHEMA_VERSION, null); }
    })();
    // §1 observability collector: process-lifetime counters + reaper totals. The
    // secureTransport flag mirrors whether a root secret is configured. Report
    // the EXACT build id (this.identity.buildId) — provenance, not the compat tuple.
    this.metrics = new BrokerMetrics(brokerInstanceId, this.identity.buildId, SCHEMA_VERSION, opts.rootSecret !== undefined, () => clock.nowMs());
    this.reaperIntervalMs = opts.reaperIntervalMs ?? 30_000;
    this.authSecret = opts.authSecret;
    this.rootSecret = opts.rootSecret;
    this.serverTuning = {
      ...(opts.maxConnections !== undefined ? { maxConnections: opts.maxConnections } : {}),
      ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
      ...(opts.globalBufferBudgetBytes !== undefined ? { globalBufferBudgetBytes: opts.globalBufferBudgetBytes } : {}),
      ...(opts.connectRatePerSec !== undefined ? { connectRatePerSec: opts.connectRatePerSec } : {}),
      ...(opts.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: opts.handshakeTimeoutMs } : {}),
    };
    this.log = opts.log ?? (() => {});
  }

  async start(): Promise<void> {
    const serverOpts: ServerOptions = { log: this.log, brokerInstanceId: this.brokerInstanceId, metrics: this.metrics, ...this.serverTuning };
    if (this.rootSecret) serverOpts.rootSecret = this.rootSecret;
    this.ipc = new IpcServer(
      this.endpoint,
      (conn, frame) => this.handle(conn, frame),
      (id) => this.onConnClose(id),
      serverOpts,
    );
    await this.ipc.listen();
    this.log(`broker listening on ${this.endpoint}${this.rootSecret ? ' (secure XBUS-STP)' : ''}`);
    // Reliability reaper (§4): periodically reclaim ack-timeouts, acceptance-TTL
    // expiries and abandoned leases. unref'd so it never holds the process open.
    if (this.reaperIntervalMs > 0) {
      this.reaperTimer = setInterval(() => {
        try { const t0 = this.clock.nowMs(); const r = this.reaper.sweep(); this.metrics.recordSweep(r, this.clock.nowMs() - t0); } catch (e) { this.log(`reaper sweep failed: ${(e as Error).message}`); }
      }, this.reaperIntervalMs);
      if (typeof this.reaperTimer.unref === 'function') this.reaperTimer.unref();
    }
  }

  /** Explicit reaper sweep — used by tests (with a FakeClock) and by `xbus doctor`.
   *  Deterministic and idempotent given a fixed clock. Folds the result into the
   *  metrics totals on the SAME path the periodic timer uses (sweep() untouched). */
  runReaperSweep(): SweepResult {
    const t0 = this.clock.nowMs();
    const r = this.reaper.sweep();
    this.metrics.recordSweep(r, this.clock.nowMs() - t0);
    return r;
  }

  async stop(): Promise<void> {
    if (this.reaperTimer) { clearInterval(this.reaperTimer); this.reaperTimer = null; }
    await this.ipc?.close();
  }

  private reply(conn: ServerConn, type: FrameType, payload: unknown, reqId?: string): void {
    conn.send(makeFrame(type, payload, reqId, this.clock.nowIso()));
  }

  private err(conn: ServerConn, e: unknown, reqId?: string): void {
    const xe = isXBusError(e) ? e : new XBusError(XBusErrorCode.DATABASE_ERROR, 'internal error');
    this.reply(conn, 'error', xe.toWire(), reqId);
  }

  private onConnClose(id: string): void {
    const auth = this.connAuth.get(id);
    if (auth) {
      // Connection drop ⇒ authority revoked (I14). Mark session disconnected if
      // this connection is still the bound one.
      try {
        this.db.transaction(() => {
          this.db
            .prepare(`UPDATE sessions SET state='disconnected', bound_connection_id=NULL, disconnected_at=?, updated_at=? WHERE session_id=? AND bound_connection_id=?`)
            .run(this.clock.nowIso(), this.clock.nowIso(), auth.sessionId, id);
          this.db.prepare(`UPDATE session_instances SET state='closed', disconnected_at=? WHERE instance_id=?`).run(this.clock.nowIso(), auth.instanceId);
          // Mark THIS connection's component non-live so a later reconnect of the
          // same session isn't falsely blocked by the split-brain guard (the
          // dead owner no longer counts as a live writer).
          this.db.prepare(`UPDATE component_instances SET state='closed', disconnected_at=? WHERE connection_id=? AND state='live'`).run(this.clock.nowIso(), id);
        });
      } catch (e) {
        this.log(`onConnClose cleanup failed: ${(e as Error).message}`);
      }
    }
    this.connAuth.delete(id);
    this.connHello.delete(id);
    this.connAwarded.delete(id);
  }

  private requireAuth(conn: ServerConn): SessionAuthority {
    const auth = this.connAuth.get(conn.id);
    if (!auth) throw new XBusError(XBusErrorCode.SESSION_NOT_REGISTERED, 'register_session required first');
    return auth;
  }

  private handle(conn: ServerConn, frame: Frame): void {
    try {
      switch (frame.frameType) {
        case 'hello':
          return this.onHello(conn, frame);
        case 'register_session':
          return this.onRegister(conn, frame);
        case 'register_alias':
          return this.onRegisterAlias(conn, frame);
        case 'rename_session':
          return this.onRenameSession(conn, frame);
        case 'send_message':
          return this.onSend(conn, frame);
        case 'checkpoint_pull':
          return this.onCheckpointPull(conn, frame);
        case 'checkpoint_pull_hook':
          return this.onCheckpointPullHook(conn, frame);
        case 'ack_message':
          return this.onAck(conn, frame);
        case 'reply_message':
          return this.onReply(conn, frame);
        case 'inbox':
          return this.onInbox(conn, frame);
        case 'redeliver':
          return this.onRedeliver(conn, frame);
        case 'signal_readiness':
          return this.onSignalReadiness(conn, frame);
        case 'list_sessions':
          return this.onListSessions(conn, frame);
        case 'get_metrics':
          return this.onGetMetrics(conn, frame);
        case 'get_status':
          return this.onStatus(conn, frame);
        case 'heartbeat':
          return this.reply(conn, 'heartbeat_ack', { ok: true }, frame.requestId);
        case 'shutdown':
          return this.onShutdown(conn, frame);
        case 'set_control':
          return this.onSetControl(conn, frame);
        case 'process_next':
          return this.onProcessNext(conn, frame);
        case 'dead_letter':
          return this.onDeadLetter(conn, frame);
        case 'block_peer':
          return this.onBlockPeer(conn, frame);
        default:
          return this.reply(conn, 'error', { code: XBusErrorCode.PROTOCOL_VIOLATION, message: `unsupported frame ${frame.frameType}` }, frame.requestId);
      }
    } catch (e) {
      this.err(conn, e, frame.requestId);
    }
  }

  private onHello(conn: ServerConn, frame: Frame): void {
    const p = (frame.payload ?? {}) as Partial<HelloInfo>;
    if (this.authSecret !== undefined && p.auth !== this.authSecret) {
      throw new XBusError(XBusErrorCode.AUTH_FAILED, 'authentication failed');
    }
    // Build the client's hello info, defaulting a minimal legacy hello to the
    // current single protocol version (back-compat with tests sending only
    // {protocolVersion}). A full hello carries min/max + schema + buildId.
    const pv = p.protocolVersion ?? 0;
    const client: HelloInfo = {
      xbusVersion: p.xbusVersion ?? 'unknown',
      protocolVersion: pv,
      minimumProtocolVersion: p.minimumProtocolVersion ?? pv,
      maximumProtocolVersion: p.maximumProtocolVersion ?? pv,
      schemaVersion: p.schemaVersion ?? SCHEMA_VERSION, // legacy hello assumed current schema
      componentRole: p.componentRole ?? 'mcp',
      buildId: p.buildId ?? 'legacy',
      capabilities: p.capabilities ?? [],
    };
    // The hello ack carries the broker's compatibility info AND its EXACT build
    // identity (resolved from the packaged provenance.json), so a client / doctor
    // can detect a compatible-but-mixed-build broker (see ADR 0011).
    const broker = { ...brokerHelloInfo(this.brokerInstanceId), exactBuild: this.identity };
    const verdict = checkCompatibility(client, broker);
    if (!verdict.ok) {
      this.audit('VERSION_INCOMPATIBLE', { result: verdict.result, clientBuild: client.buildId });
      // Fail closed BEFORE register: a single typed error carrying the verdict
      // (the connection never enters the hello'd set, so register is blocked).
      throw new XBusError(XBusErrorCode.VERSION_INCOMPATIBLE, verdict.detail, { result: verdict.result });
    }
    this.connHello.add(conn.id);
    this.reply(conn, 'hello_ack', { ok: true, compatibility: verdict.result, brokerInstanceId: this.brokerInstanceId, broker }, frame.requestId);
  }

  private audit(eventType: string, fields: Record<string, unknown>): void {
    try {
      this.db
        .prepare('INSERT INTO audit_events (audit_id, event_type, actor_session_id, actor_instance_id, message_id, trace_id, safe_metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(this.ids.next(), eventType, null, null, null, null, JSON.stringify(fields), this.clock.nowIso());
    } catch { /* never fail a handshake on audit-write */ }
  }

  private onRegister(conn: ServerConn, frame: Frame): void {
    if (!this.connHello.has(conn.id)) throw new XBusError(XBusErrorCode.AUTH_FAILED, 'hello required before register');
    // Clear any prior award at the START of every registration attempt, so a stale
    // award can never survive a re-registration (adapter-aware → legacy, high → low,
    // success → failed, identity change). A new award is set only on full success.
    this.connAwarded.delete(conn.id);
    const p = frame.payload as RegisterPayload & { role?: string; supersede?: boolean; adapterRegistration?: AdapterRegistrationDeclaration };
    // The register frame's role is the connection's declared authority role. It is NOT a
    // privilege the broker grants: what a role can DO is enforced elsewhere (assertAllowed
    // per-operation), and for adapter-aware registrations evaluateRegistration cross-checks
    // that the adapter DECLARATION's role equals this authority role (FORBIDDEN_ROLE on
    // mismatch — PR #4 trust boundary). The trusted-evidence award is bound to exact
    // identity and cannot be forged by role choice. So role is read from the register frame
    // (not cached from hello) by design; there is no self-promotion path.
    const role = p.role && isComponentRole(p.role) ? p.role : ComponentRole.MCP;
    // OPT-IN adapter enforcement. The adapter frame carries ONLY an untrusted
    // DECLARATION (id/version/role/declaredCapabilities). The TRUSTED evidence used to
    // verify those declarations is BROKER-OWNED — resolved from this.trustedEvidence by
    // exact adapter identity, never deserialized from the frame. A legacy beta.2
    // registration (no adapterRegistration) takes a pure no-op path. May throw
    // PROTOCOL_VIOLATION/FORBIDDEN_ROLE; computed BEFORE store.register so a rejected
    // adapter-aware registration never persists a session.
    const declaration = p.adapterRegistration;
    const resolved = declaration
      ? this.trustedEvidence.resolve({ adapterId: declaration.adapterId, adapterVersion: declaration.adapterVersion, role: declaration.role, ...(declaration.buildId !== undefined ? { buildId: declaration.buildId } : {}) })
      : undefined;
    const enforcement = evaluateRegistration({
      receiveMode: p.receiveMode,
      declaration,
      authority: { role, sessionId: p.sessionId },
      trustedEvidence: resolved?.ok ? resolved.evidence : undefined,
    });
    const auth = this.store.register({
      sessionId: p.sessionId,
      instanceId: p.instanceId,
      connectionId: conn.id,
      processId: p.processId,
      projectId: p.projectId,
      cwd: p.cwd,
      receiveMode: p.receiveMode,
      capabilities: p.capabilities ?? [],
      role,
      supersede: p.supersede === true,
      ...(p.repositoryRoot !== undefined ? { repositoryRoot: p.repositoryRoot } : {}),
      ...(p.claudeCodeVersion !== undefined ? { claudeCodeVersion: p.claudeCodeVersion } : {}),
      // Beta.4 (ADR 0012): optional name request + agent type. The store awards the
      // name (active) or falls to pending_name; never fails registration over it.
      ...(p.requestedSessionName !== undefined ? { requestedSessionName: p.requestedSessionName } : {}),
      ...(p.agentType !== undefined ? { agentType: p.agentType } : {}),
    });
    this.connAuth.set(conn.id, auth);
    // Composition (ADR 0012 §5 + PR #4): the register ack carries THREE additive,
    // orthogonal field-sets on top of the frozen base (sessionId/instanceId/
    // componentInstanceId/role/epoch/generation):
    //   • beta.4 naming — sessionNameState + awardedSessionName (present once a name is
    //     awarded or pending);
    //   • PR #4 enforcement — awardedSupport, present ONLY for adapter-aware
    //     registrations (in-memory award; no schema change; a legacy ack is byte-identical).
    // All are unknown-field-tolerant, so the two feature lines compose without touching
    // the frozen wire bytes. The connAwarded map is set here (success) and was already
    // cleared at the start of this attempt, so a stale award can never survive.
    const ackPayload: Record<string, unknown> = {
      sessionId: auth.sessionId, instanceId: auth.instanceId, componentInstanceId: auth.componentInstanceId,
      role: auth.role, epoch: auth.epoch, generation: auth.generation,
      ...(auth.sessionNameState !== undefined ? { sessionNameState: auth.sessionNameState } : {}),
      ...(auth.awardedSessionName != null ? { awardedSessionName: auth.awardedSessionName } : {}),
    };
    if (enforcement) {
      this.connAwarded.set(conn.id, enforcement.awarded);
      ackPayload.awardedSupport = enforcement.awarded;
    }
    this.reply(conn, 'register_session_ack', ackPayload, frame.requestId);
  }

  private onRenameSession(conn: ServerConn, frame: Frame): void {
    // Beta.4 (ADR 0012 D4): choose/change the session's human-readable name. This is
    // the resolution path for a session stranded in pending_name (e.g. two sessions
    // launched from the same project picked the same suggested name). mcp-role only;
    // SESSION_NAME_TAKEN / INVALID_SESSION_NAME surface to the model so it can retry.
    const auth = this.requireAuth(conn);
    const p = frame.payload as { name: string };
    const r = this.store.renameSession(auth, p.name);
    this.reply(conn, 'rename_session_ack', { name: r.name, sessionNameState: r.state }, frame.requestId);
  }

  private onRegisterAlias(conn: ServerConn, frame: Frame): void {
    const auth = this.requireAuth(conn);
    const p = frame.payload as { alias: string };
    const r = this.store.registerAlias(auth, p.alias);
    this.reply(conn, 'register_alias_ack', r, frame.requestId);
  }

  private onSend(conn: ServerConn, frame: Frame): void {
    const auth = this.requireAuth(conn);
    assertAllowed(auth.role, Operation.SEND);
    const input = validateSendInput(frame.payload);
    const result = this.store.send(auth, input);
    // §2: the message is always durable. Reflect the recipient's REAL acceptance
    // state honestly: a receiver still initializing cannot be injected yet, so the
    // sender is told `queued_receiver_initializing` (not "queued_until_checkpoint",
    // which would imply the next checkpoint will deliver it).
    const recvMode = this.receiveModeOf(result.recipientSessionId);
    const readiness = this.store.readinessOf(result.recipientSessionId);
    let state = result.state;
    if (readiness === 'initializing') state = 'queued_receiver_initializing';
    else if (readiness === 'degraded_ack_unavailable' || readiness === 'degraded_hook_unavailable') state = 'queued_receiver_degraded';
    else if (recvMode === 'hook_checkpoint') state = 'queued_until_checkpoint';
    this.reply(conn, 'send_message_ack', { ...result, state, recipientReceiveMode: recvMode, recipientReadiness: readiness }, frame.requestId);
  }

  private onCheckpointPull(conn: ServerConn, frame: Frame): void {
    const auth = this.requireAuth(conn);
    const p = (frame.payload ?? {}) as { limit?: number };
    const pending = this.delivery.pendingForSession(auth, p.limit !== undefined ? { limit: p.limit } : {});
    // Mark them injected (transport_written) — ack deadline starts now. markInjected
    // reports only NEWLY-injected ids; an already-injected message re-selected after
    // an ack-timeout requeue is re-armed but NOT reported, so its body is not
    // re-presented (Layer-3 invariant). Each newly-injected message has a valid
    // injection record — surface its id so a returned body NEVER lacks one.
    const marked = this.delivery.markInjected(auth, pending.map((m) => m.messageId));
    const markedSet = new Set(marked);
    this.db.prepare(`UPDATE sessions SET last_checkpoint_at=?, last_seen_at=?, updated_at=? WHERE session_id=?`).run(this.clock.nowIso(), this.clock.nowIso(), this.clock.nowIso(), auth.sessionId);
    // ADR 0012 D5: injecting a body at a checkpoint is MEANINGFUL recipient activity, so
    // it must refresh the 15-day idle timer — on the MCP checkpoint path too, not only
    // the hook path (onCheckpointPullHook → delivery.checkpointPull → refreshActivity).
    // Only when a body was actually (newly) injected: an empty/recovery-only pull is not
    // meaningful (mirrors the body-push guard in delivery.checkpointPull).
    if (marked.length > 0) this.store.refreshMeaningfulActivity(auth.sessionId);
    // LAYER-3 INVARIANT (see the promise on lines above + delivery.checkpointPull):
    // a returned body must NEVER lack a valid injection id. `marked` already contains
    // only messages whose receipts.issue() succeeded, so injectionIdFor() is expected
    // non-null — but ENFORCE it structurally rather than trust it: if the id is somehow
    // absent (race / concurrent deletion / corruption) DROP the body (never present one
    // without a referable id for ack/reply), mirroring the hook path's body-suppress.
    const messages = pending
      .filter((m) => markedSet.has(m.messageId))
      .flatMap((m) => {
        const injectionId = this.delivery.injectionIdFor(m.messageId, auth.epoch);
        if (!injectionId) {
          this.audit('INJECTION_ID_MISSING_BODY_SUPPRESSED', { sessionId: auth.sessionId, messageId: m.messageId });
          return [];
        }
        return [{ ...m, metadata: { ...(m.metadata ?? {}), [INJECTION_METADATA_KEY]: injectionId } }];
      });
    this.reply(conn, 'checkpoint_pull_ack', { messages }, frame.requestId);
  }

  /**
   * Privileged hook checkpoint pull (ADR 0003/0004). The hook must have
   * REGISTERED as a `hook` component on THIS connection; the session + epoch are
   * derived from that authenticated authority (NOT a caller-supplied sessionId).
   * Role + epoch + replay are enforced in DeliveryOps.checkpointPull.
   */
  private onCheckpointPullHook(conn: ServerConn, frame: Frame): void {
    const auth = this.requireAuth(conn);
    const p = (frame.payload ?? {}) as { checkpointId?: string; limit?: number };
    const checkpointId = p.checkpointId ?? this.ids.next();
    const messages = this.delivery.checkpointPull(auth, checkpointId, p.limit ?? 10);
    if (messages.length > 0) {
      this.db.prepare(`UPDATE sessions SET last_checkpoint_at=?, last_seen_at=?, updated_at=? WHERE session_id=?`).run(this.clock.nowIso(), this.clock.nowIso(), this.clock.nowIso(), auth.sessionId);
    }
    this.reply(conn, 'checkpoint_pull_hook_ack', { messages }, frame.requestId);
  }

  /**
   * Authenticated IPC shutdown (ADR 0007) — the NORMAL stop path. Requires:
   * a registered ADMIN-role connection, and the caller must echo this broker's
   * instanceId (proves it's talking to the intended broker, not a stale one).
   */
  private onShutdown(conn: ServerConn, frame: Frame): void {
    const auth = this.requireAuth(conn);
    assertAllowed(auth.role, Operation.SHUTDOWN);
    const p = (frame.payload ?? {}) as { brokerInstanceId?: string };
    if (p.brokerInstanceId !== this.brokerInstanceId) {
      throw new XBusError(XBusErrorCode.IDENTITY_MISMATCH, 'brokerInstanceId mismatch; refusing shutdown');
    }
    this.audit('SHUTDOWN_REQUESTED', { instanceId: auth.componentInstanceId });
    this.reply(conn, 'shutdown_ack', { ok: true, brokerInstanceId: this.brokerInstanceId }, frame.requestId);
    // Defer the actual stop so the ack flushes first.
    setTimeout(() => { void this.onShutdownRequested?.(); }, 50);
  }

  /** Set by the host: performs graceful broker stop + state-file cleanup. */
  onShutdownRequested?: () => void | Promise<void>;

  /** Set the CALLER's own receive control (pause/resume/dnd/manual). */
  private onSetControl(conn: ServerConn, frame: Frame): void {
    const auth = this.requireAuth(conn);
    const p = (frame.payload ?? {}) as { mode?: string };
    const mode = (['active', 'paused', 'do_not_disturb', 'manual_checkpoint'].includes(p.mode ?? '') ? p.mode : 'active') as ReceiveControl;
    this.controls.setControl(auth.sessionId, mode);
    // ADR 0012 D5: an intentional pause/resume/DND control change is MEANINGFUL activity
    // and must refresh the 15-day idle timer — a user who explicitly pauses a session has
    // not abandoned it. (refreshMeaningfulActivity is guarded on expired_at IS NULL, so it
    // never revives a tombstone.)
    this.store.refreshMeaningfulActivity(auth.sessionId);
    this.audit('CONTROL_SET', { sessionId: auth.sessionId, mode });
    this.reply(conn, 'set_control_ack', { sessionId: auth.sessionId, mode }, frame.requestId);
  }

  /** Manual single-step delivery for the caller's own session. */
  private onProcessNext(conn: ServerConn, frame: Frame): void {
    const auth = this.requireAuth(conn);
    const msgs = this.delivery.processNext(auth, this.ids.next());
    this.reply(conn, 'process_next_ack', { messages: msgs }, frame.requestId);
  }

  /**
   * §5 — dead-letter inspection (admin, read-only). `action:'list'` returns
   * all dead-lettered deliveries' SAFE metadata (ids/states/counts/recovery hint —
   * never a body); `action:'inspect'` returns one record by messageId. Redrive is
   * intentionally NOT exposed here (a mutating recovery op kept off the preview CLI).
   */
  private onDeadLetter(conn: ServerConn, frame: Frame): void {
    const auth = this.requireAuth(conn);
    assertAllowed(auth.role, Operation.DEAD_LETTER);
    const p = (frame.payload ?? {}) as { action?: string; messageId?: string };
    if (p.action === 'inspect') {
      if (!p.messageId) { this.reply(conn, 'error', { code: XBusErrorCode.PROTOCOL_VIOLATION, message: 'inspect requires messageId' }, frame.requestId); return; }
      const record = this.deadLetters.inspect(p.messageId);
      this.reply(conn, 'dead_letter_ack', { record }, frame.requestId);
      return;
    }
    // default: list
    this.reply(conn, 'dead_letter_ack', { records: this.deadLetters.list() }, frame.requestId);
  }

  /** Block/unblock a peer alias for the CALLER (recipient) session. */
  private onBlockPeer(conn: ServerConn, frame: Frame): void {
    const auth = this.requireAuth(conn);
    const p = (frame.payload ?? {}) as { alias?: string; unblock?: boolean };
    if (!p.alias) throw new XBusError(XBusErrorCode.INVALID_ALIAS, 'alias required');
    if (p.unblock) this.controls.unblockPeer(auth.sessionId, p.alias);
    else this.controls.blockPeer(auth.sessionId, p.alias, () => this.ids.next());
    this.reply(conn, 'block_peer_ack', { alias: p.alias, blocked: !p.unblock }, frame.requestId);
  }

  private onAck(conn: ServerConn, frame: Frame): void {
    const auth = this.requireAuth(conn);
    const p = frame.payload as { messageId: string; status: 'accepted' | 'rejected'; note?: string; injectionId?: string };
    const r = this.delivery.ack(auth, { messageId: p.messageId, status: p.status, ...(p.note !== undefined ? { note: p.note } : {}), ...(p.injectionId !== undefined ? { injectionId: p.injectionId } : {}) });
    this.reply(conn, 'ack_message_ack', r, frame.requestId);
  }

  private onReply(conn: ServerConn, frame: Frame): void {
    const auth = this.requireAuth(conn);
    const p = frame.payload as { messageId: string; text: string; outcome: 'completed' | 'failed' | 'partial'; idempotencyKey?: string; metadata?: Record<string, string>; injectionId?: string };
    const r = this.delivery.reply(
      auth,
      { messageId: p.messageId, text: p.text, outcome: p.outcome, ...(p.idempotencyKey !== undefined ? { idempotencyKey: p.idempotencyKey } : {}), ...(p.metadata !== undefined ? { metadata: p.metadata } : {}), ...(p.injectionId !== undefined ? { injectionId: p.injectionId } : {}) },
      (recipientSessionId) => this.allocSequence(recipientSessionId),
    );
    this.reply(conn, 'reply_message_ack', r, frame.requestId);
  }

  private onInbox(conn: ServerConn, frame: Frame): void {
    const auth = this.requireAuth(conn);
    const p = (frame.payload ?? {}) as { limit?: number; markInjected?: boolean; checkpointId?: string };
    if (p.markInjected === false) {
      // Peek: list without marking injected / issuing a receipt.
      const peek = this.delivery.pendingForSession(auth, p.limit !== undefined ? { limit: p.limit } : {});
      this.reply(conn, 'inbox_ack', { messages: peek }, frame.requestId);
      return;
    }
    // §1: inbox VIEW — body included once (first injection), already-presented
    // entries return metadata + bodyIncluded:false (no model-visible duplicate).
    const messages = this.delivery.inboxView(auth, p.checkpointId ?? this.ids.next(), p.limit ?? 50);
    this.reply(conn, 'inbox_ack', { messages }, frame.requestId);
  }

  private onRedeliver(conn: ServerConn, frame: Frame): void {
    const auth = this.requireAuth(conn);
    const p = (frame.payload ?? {}) as { messageId?: string; reason?: string };
    if (!p.messageId) throw new XBusError(XBusErrorCode.MESSAGE_NOT_FOUND, 'messageId required');
    const entry = this.delivery.redeliver(auth, p.messageId, p.reason ?? 'explicit');
    if (!entry) throw new XBusError(XBusErrorCode.MESSAGE_NOT_FOUND, 'no such message for this session');
    this.reply(conn, 'redeliver_ack', { entry, warning: 'the receiving model may process this request twice' }, frame.requestId);
  }

  /**
   * §2 — explicit readiness signal. The caller declares concrete capability
   * hints; the broker DERIVES the readiness state (never trusts a bare "ready").
   * Until this lands, the session sits in `initializing` and receives no injection.
   */
  private onSignalReadiness(conn: ServerConn, frame: Frame): void {
    const auth = this.requireAuth(conn);
    const p = (frame.payload ?? {}) as { ackAvailable?: boolean; hookAvailable?: boolean; live?: boolean; versionOk?: boolean };
    const hints: ReadinessHints = {};
    if (p.ackAvailable !== undefined) hints.ackAvailable = p.ackAvailable;
    if (p.hookAvailable !== undefined) hints.hookAvailable = p.hookAvailable;
    if (p.live !== undefined) hints.live = p.live;
    if (p.versionOk !== undefined) hints.versionOk = p.versionOk;
    const r = this.store.signalReadiness(auth, hints);
    this.reply(conn, 'signal_readiness_ack', r, frame.requestId);
  }

  private onListSessions(conn: ServerConn, frame: Frame): void {
    this.requireAuth(conn);
    const rows = this.db
      .prepare(`SELECT s.session_id, s.automatic_alias, s.project_id, s.project_alias, s.state, s.receive_mode, s.readiness, s.readiness_updated_at, s.last_checkpoint_at, s.session_name, s.session_name_state, s.expired_at FROM sessions s`)
      .all() as Array<Record<string, unknown>>;
    const sessions = rows.map((r) => {
      const sid = r.session_id as string;
      const queued = (this.db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE recipient_session_id=? AND state IN ('queued','retry_wait')`).get(sid) as { n: number }).n;
      const unacked = (this.db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE recipient_session_id=? AND state='transport_written'`).get(sid) as { n: number }).n;
      const aliases = (this.db.prepare(`SELECT alias FROM aliases WHERE session_id=? AND active=1 AND alias NOT LIKE 'session-%'`).all(sid) as Array<{ alias: string }>).map((a) => a.alias);
      return {
        // Beta.4: the human-readable session NAME (the primary user-facing address)
        // + its lifecycle state, so peers can discover a session by name and see
        // whether it is active / pending (unroutable) / expired. ADR 0012 D2/D3.
        name: (r.session_name as string) ?? null,
        sessionNameState: (r.session_name_state as string) ?? 'unnamed',
        expired: (r.expired_at as string | null) !== null,
        alias: aliases[0] ?? (r.automatic_alias as string),
        project: (r.project_alias as string) ?? (r.project_id as string),
        // connection (is a socket attached?), receiveMode (HOW it takes delivery),
        // and readiness (is it SAFE to inject now?) are reported SEPARATELY (§2).
        connection: r.state as string,
        receiveMode: r.receive_mode as string,
        readiness: (r.readiness as string) ?? 'disconnected',
        readinessUpdatedAt: (r.readiness_updated_at as string) ?? null,
        lastCheckpoint: (r.last_checkpoint_at as string) ?? null,
        queued,
        unacknowledged: unacked,
        sessionId: sid,
      };
    });
    this.reply(conn, 'list_sessions_ack', { sessions }, frame.requestId);
  }

  /**
   * §1 — body-free metrics. Role: admin (via the SAME assertAllowed privileged
   * path as list_sessions/shutdown). The collector's serializer routes every
   * string-valued field through safeField(); the snapshot here is pure counts +
   * enum keys (the same COUNT(*) GROUP BY shape as onListSessions).
   */
  private onGetMetrics(conn: ServerConn, frame: Frame): void {
    const auth = this.requireAuth(conn);
    assertAllowed(auth.role, Operation.GET_METRICS);
    this.reply(conn, 'get_metrics_ack', { metrics: this.metricsSnapshot() }, frame.requestId);
  }

  /** Build the body-free metrics snapshot (on-read snapshot queries + collector
   *  counters). Public so the host/doctor path can embed it. */
  /**
   * Record broker-OWNED trusted evidence for an adapter identity. This is the ONLY way
   * the registration path obtains verified evidence; it is called by broker-owned
   * validation code (the conformance runner under broker control, a real-runtime
   * validator, or a policy step) — NEVER from an adapter registration frame. In-memory
   * only; no persistence.
   */
  recordTrustedEvidence(ev: Parameters<TrustedEvidenceRegistry['record']>[0]): void {
    this.trustedEvidence.record(ev);
  }

  metricsSnapshot(): MetricsSnapshot {
    const g = this.ipc?.gauges() ?? { activeConnections: 0, maxConnections: 0, bufferBytesInUse: 0, bufferBudgetBytes: 0 };
    const deliveriesByState = this.countBy(
      `SELECT state AS k, COUNT(*) AS n FROM deliveries GROUP BY state`,
    );
    const sessionsByReadiness = this.countBy(
      `SELECT readiness AS k, COUNT(*) AS n FROM sessions GROUP BY readiness`,
    );
    const injectionsTotal = (this.db.prepare(`SELECT COUNT(*) AS n FROM context_injections`).get() as { n: number }).n;
    const redeliveriesTotal = (this.db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE event_type='EXPLICIT_REDELIVERY'`).get() as { n: number }).n;
    const gauges: MetricsGauges = {
      connections: { active: g.activeConnections, max: g.maxConnections },
      buffer: { bytesInUse: g.bufferBytesInUse, budgetBytes: g.bufferBudgetBytes },
      deliveriesByState, sessionsByReadiness, injectionsTotal, redeliveriesTotal,
    };
    return this.metrics.serialize(gauges);
  }

  /** Run a `SELECT k, COUNT(*) n GROUP BY` and fold to a {key:count} map. The
   *  serializer projects this onto the FIXED enum key set (non-enum keys dropped). */
  private countBy(sql: string): Record<string, number> {
    const rows = this.db.prepare(sql).all() as Array<{ k: string | null; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) if (r.k !== null) out[r.k] = r.n;
    return out;
  }

  private onStatus(conn: ServerConn, frame: Frame): void {
    // Report the CALLER's own broker-owned identity. The session is keyed by the
    // AUTHENTICATED connection (this.connAuth), never a caller-supplied id — a caller
    // cannot spoke another session's id to read its state. This is a pure read: a plain
    // SELECT that never refreshes meaningful activity and never revives an expired row.
    const auth = this.connAuth.get(conn.id);
    let session: Record<string, unknown> | null = null;
    if (auth) {
      const row = this.db.prepare(
        `SELECT session_name AS name, normalized_session_name AS norm, session_name_state AS state,
                agent_type AS agentType, cwd, readiness, last_meaningful_activity_at AS lastActivity,
                expires_at AS expiresAt, expired_at AS expiredAt
         FROM sessions WHERE session_id=?`,
      ).get(auth.sessionId) as
        | { name: string | null; norm: string | null; state: string | null; agentType: string | null; cwd: string | null; readiness: string | null; lastActivity: string | null; expiresAt: string | null; expiredAt: string | null }
        | undefined;
      // sessionName reports the ACTIVE display name only; pending/unnamed/retired ⇒ null
      // (a pending session holds no routable name). session_name_state carries the nuance.
      const active = row?.state === 'active';
      session = {
        sessionId: auth.sessionId,
        instanceId: auth.instanceId,
        generation: auth.generation,
        epoch: auth.epoch,
        sessionName: active ? (row?.name ?? null) : null,
        sessionNameState: row?.state ?? 'unnamed',
        agentType: row?.agentType ?? null,
        cwd: row?.cwd ?? null,
        readiness: row?.readiness ?? null,
        lastMeaningfulActivityAt: row?.lastActivity ?? null,
        expiresAt: row?.expiresAt ?? null,
        expired: row?.expiredAt != null,
      };
    }
    const payload = {
      broker: 'connected',
      brokerInstanceId: this.brokerInstanceId,
      compatibilityId: BUILD_ID,
      session,
    };
    this.reply(conn, 'get_status_ack', payload, frame.requestId);
  }

  private receiveModeOf(sessionId: string): string {
    const r = this.db.prepare('SELECT receive_mode FROM sessions WHERE session_id=?').get(sessionId) as { receive_mode: string } | undefined;
    return r?.receive_mode ?? 'disconnected';
  }

  private allocSequence(recipientSessionId: string): number {
    const seqRow = this.db.prepare('SELECT next_sequence FROM recipient_sequences WHERE recipient_session_id=?').get(recipientSessionId) as { next_sequence: number } | undefined;
    const sequence = seqRow ? seqRow.next_sequence : 1;
    this.db.prepare('INSERT OR REPLACE INTO recipient_sequences (recipient_session_id, next_sequence) VALUES (?, ?)').run(recipientSessionId, sequence + 1);
    return sequence;
  }
}
