/**
 * §1 — body-free observability surface (Phase 2 groundwork §1).
 *
 * A metrics payload is a CLOSED set of numbers, booleans, fixed-enum keys, ISO
 * timestamps, and opaque ids already deemed transcript-safe (ADR 0006:
 * brokerInstanceId / buildId / injection_id). It contains NO free text that
 * originated from a peer (message body, ack note, reply text, alias label, repo
 * URL, prompt). This is the R1 invariant — observability must never become an
 * exfiltration channel.
 *
 * The collector holds process-lifetime monotonic counters (bumped at the exact
 * log points in server.ts) plus the reaper totals (folded in the daemon's
 * existing sweep timer). The gauges (deliveries.byState, sessions.byReadiness,
 * connections, buffer, injections, redeliveries) are computed ON READ via the
 * same kind of COUNT(*) GROUP BY snapshot already used by onListSessions — never
 * on the delivery hot path.
 *
 * The serializer routes EVERY string-valued field through safeField() before it
 * leaves the process (defence-in-depth: even the enum keys + opaque ids, which
 * are already safe by construction, are sanitized).
 */
import { safeField, safeId } from './redaction.js';
import { DeliveryState } from '../protocol/states.js';
import { ALL_READINESS } from '../broker/readiness.js';
import type { SweepResult } from '../broker/reaper.js';

/** Handshake-outcome buckets. `authFailed` is a SINGLE uniform bucket — it never
 *  records WHICH check failed (no which-check oracle; spec §9). */
export interface HandshakeCounters {
  ok: number;
  authFailed: number;
  protoMismatch: number;
  timedOut: number;
}

/** §3 DoS-bound observables: refusals + pre-handshake / sealed-open rejections. */
export interface RefusalCounters { connLimit: number; rateLimit: number; }
export interface FrameRejectCounters { preHandshakeRejected: number; secureOpenFailed: number; }

/** Reaper SweepResult totals (camelCase mirror of SweepResult). */
export interface ReaperTotals {
  ackTimedOut: number;
  deadLettered: number;
  expired: number;
  leasesReclaimed: number;
  sessionsExpired: number;
}

/** Point-in-time gauges supplied by the daemon on read (snapshot queries). */
export interface MetricsGauges {
  connections: { active: number; max: number };
  buffer: { bytesInUse: number; budgetBytes: number };
  /** COUNT(*) GROUP BY state over deliveries (keys are DeliveryState enum members). */
  deliveriesByState: Record<string, number>;
  /** COUNT(*) GROUP BY readiness over sessions (keys are Readiness enum members). */
  sessionsByReadiness: Record<string, number>;
  injectionsTotal: number;
  redeliveriesTotal: number;
}

/** The serialized, body-free metrics snapshot. Every value is number | boolean |
 *  fixed-enum key | ISO timestamp | opaque-public-id. No free text. */
export interface MetricsSnapshot {
  ok: true;
  collectedAt: string;
  broker: { instanceId: string; buildId: string; schemaVersion: number; uptimeMs: number; secureTransport: boolean };
  transport: {
    connections: { active: number; max: number };
    buffer: { bytesInUse: number; budgetBytes: number };
    handshakes: HandshakeCounters;
    refusals: RefusalCounters;
    frames: FrameRejectCounters;
  };
  deliveries: Record<string, number>;
  reaper: { sweepsTotal: number; lastSweepAt: string | null; lastSweepDurationMs: number; totals: ReaperTotals };
  sessions: { byReadiness: Record<string, number> };
  injections: { total: number; redeliveries: number };
}

/** The DeliveryState enum keys, fixed at module load — the only delivery keys the
 *  serializer will emit (a value never seen in the store is reported as 0). */
const DELIVERY_KEYS: readonly DeliveryState[] = Object.values(DeliveryState);

/**
 * Process-lifetime metrics collector owned by the daemon. Counters are mutated by
 * side-effect-free `++` bumps at existing log points; gauges are passed in on read.
 */
export class BrokerMetrics {
  private readonly startedMs: number;
  readonly handshakes: HandshakeCounters = { ok: 0, authFailed: 0, protoMismatch: 0, timedOut: 0 };
  readonly refusals: RefusalCounters = { connLimit: 0, rateLimit: 0 };
  readonly frames: FrameRejectCounters = { preHandshakeRejected: 0, secureOpenFailed: 0 };
  readonly reaperTotals: ReaperTotals = { ackTimedOut: 0, deadLettered: 0, expired: 0, leasesReclaimed: 0, sessionsExpired: 0 };
  private sweepsTotal = 0;
  private lastSweepAt: string | null = null;
  private lastSweepDurationMs = 0;

  constructor(
    private readonly brokerInstanceId: string,
    private readonly buildId: string,
    private readonly schemaVersion: number,
    private readonly secureTransport: boolean,
    nowMs: () => number,
  ) {
    this.now = nowMs;
    this.startedMs = nowMs();
  }
  private readonly now: () => number;

  // --- counter bumps (called from server.ts log points) -------------------
  onHandshakeOk(): void { this.handshakes.ok++; }
  onHandshakeAuthFailed(): void { this.handshakes.authFailed++; }
  onHandshakeProtoMismatch(): void { this.handshakes.protoMismatch++; }
  onHandshakeTimedOut(): void { this.handshakes.timedOut++; }
  onRefusedConnLimit(): void { this.refusals.connLimit++; }
  onRefusedRateLimit(): void { this.refusals.rateLimit++; }
  onPreHandshakeRejected(): void { this.frames.preHandshakeRejected++; }
  onSecureOpenFailed(): void { this.frames.secureOpenFailed++; }

  /** Fold one reaper SweepResult into the totals + last-sweep gauges. ONE call in
   *  the daemon's existing periodic timer; sweep() itself is never touched. */
  recordSweep(r: SweepResult, durationMs: number): void {
    this.reaperTotals.ackTimedOut += r.ackTimedOut;
    this.reaperTotals.deadLettered += r.deadLettered;
    this.reaperTotals.expired += r.expired;
    this.reaperTotals.leasesReclaimed += r.leasesReclaimed;
    this.reaperTotals.sessionsExpired += r.sessionsExpired;
    this.sweepsTotal++;
    this.lastSweepAt = new Date(this.now()).toISOString();
    this.lastSweepDurationMs = durationMs;
  }

  // --- serialization -------------------------------------------------------
  /**
   * Build the body-free snapshot. EVERY string-valued field is routed through
   * safeField() (the opaque ids + enum keys are already safe; this is the R1
   * defence-in-depth belt-and-braces so a future regression can't leak text).
   */
  serialize(gauges: MetricsGauges): MetricsSnapshot {
    return {
      ok: true,
      collectedAt: new Date(this.now()).toISOString(),
      broker: {
        // Broker-MINTED ids (uuidv7 instanceId, compile-time buildId) — public per
        // ADR 0006, never peer-derived. Use safeId (control-strip + cap) NOT
        // safeField: the secret-blob scan in safeField mangles a 36-char hyphenated
        // UUIDv7 to [REDACTED] (a false positive). Every OTHER string still routes
        // through full safeField.
        instanceId: safeId(this.brokerInstanceId),
        buildId: safeId(this.buildId),
        schemaVersion: this.schemaVersion,
        uptimeMs: Math.max(0, this.now() - this.startedMs),
        secureTransport: this.secureTransport,
      },
      transport: {
        connections: { active: gauges.connections.active, max: gauges.connections.max },
        buffer: { bytesInUse: gauges.buffer.bytesInUse, budgetBytes: gauges.buffer.budgetBytes },
        handshakes: { ...this.handshakes },
        refusals: { ...this.refusals },
        frames: { ...this.frames },
      },
      // deliveries.byState: emit EVERY enum key (0 if unseen), keyed by the fixed
      // DeliveryState members only — a value not in the enum is never surfaced.
      deliveries: byEnum(DELIVERY_KEYS, gauges.deliveriesByState),
      reaper: {
        sweepsTotal: this.sweepsTotal,
        lastSweepAt: this.lastSweepAt,
        lastSweepDurationMs: this.lastSweepDurationMs,
        totals: { ...this.reaperTotals },
      },
      sessions: { byReadiness: byEnum(ALL_READINESS, gauges.sessionsByReadiness) },
      injections: { total: gauges.injectionsTotal, redeliveries: gauges.redeliveriesTotal },
    };
  }
}

/** Project a COUNT-by snapshot onto a FIXED enum key set: every enum member is
 *  present (0 if unseen) and NO non-enum key from the snapshot is carried through
 *  (a state value not in the enum cannot leak — keys are the fixed enum only). */
function byEnum(keys: readonly string[], counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[safeField(k)] = counts[k] ?? 0;
  return out;
}
