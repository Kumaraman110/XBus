/**
 * Dashboard READ MODEL (ADR 0020 Q2/Q5). Pure, synchronous reads over a
 * PHYSICALLY read-only SQLite handle (`openDatabase(..., { readOnly: true })`). This is
 * the ONLY DB access the dashboard has — there is no writer handle in the read path, so
 * it structurally cannot mutate state (I4). The label for each session is derived by a
 * pure decision function (deriveSessionLabel) so it is unit-testable in isolation.
 *
 * This module holds NO secrets and serves NO bodies — only ids, states, counts, hashes,
 * and the safe session-visibility columns. It is designed to run inside an off-loop
 * worker (read-worker.ts) so a pathological large scan executes off the broker event loop
 * and cannot stall delivery.
 */
import type { SqliteDriver } from '../../database/connection.js';

/** The dashboard-visible label for a session, derived top-down, first-match-wins from the
 *  FOUR real fields (ADR 0020 Q2 decision table). */
export type SessionLabel =
  | 'expired'
  | 'unmanaged'
  | 'dormant'
  | 'active-disconnected'
  | 'active-ready'
  | 'active-starting';

export interface SessionLabelInputs {
  managementState: string;      // unmanaged | dormant | active
  connectionState: string;      // connected | disconnected  (sessions.state)
  readiness: string;            // initializing | ready_checkpoint | ready_live | degraded_* | disconnected
  expiredAt: string | null;     // tombstone (ADR 0012 D6)
}

/**
 * ADR 0020 Q2 decision table — evaluated TOP-DOWN, first match wins (so an `expired_at`
 * set row is caught before the active rows, and a legacy `active`+`expired_at` backfill
 * row lands on `expired`, not `active-*`). Pure + exhaustively unit-tested.
 */
export function deriveSessionLabel(i: SessionLabelInputs): { label: SessionLabel; routable: boolean } {
  if (i.expiredAt !== null) return { label: 'expired', routable: false };                    // row 1
  if (i.managementState === 'unmanaged') return { label: 'unmanaged', routable: false };      // row 2
  if (i.managementState === 'dormant') return { label: 'dormant', routable: false };          // row 3
  // management_state === 'active' below
  if (i.connectionState === 'disconnected') return { label: 'active-disconnected', routable: false }; // row 4 (queued, not injectable now)
  if (i.readiness === 'ready_checkpoint' || i.readiness === 'ready_live') return { label: 'active-ready', routable: true }; // row 5
  return { label: 'active-starting', routable: false };                                        // row 6 (initializing / degraded_*)
}

export interface DashboardSession {
  sessionId: string;
  name: string | null;
  sessionNameState: string;
  label: SessionLabel;
  routable: boolean;
  managementState: string;
  source: string | null;
  identifyConfidence: string;
  agentType: string | null;
  project: string;
  firstSeenAt: string | null;
  lastSeenSourceAt: string | null;
  queued: number;
  unacknowledged: number;
}

export interface UnmanagedBanner {
  /** Conservative aggregate count of possibly-unmanaged sessions (ADR 0013 D6). Computed
   *  broker-side from a NON-INVASIVE live-`claude`-process count minus the managed+dormant
   *  sessions the read model reports; the read-only worker never spawns processes, so it
   *  reports `managedOrDormant` and 0 for `possibleUnmanaged` unless the broker posts a
   *  live-process count. Never per-session, never invasive (ADR 0013 D6). */
  possibleUnmanaged: number;
  /** The count of managed+dormant sessions the read model knows (the subtrahend). */
  managedOrDormant: number;
}

export interface LedgerPage {
  events: Array<{ seq: number; eventType: string; actor: string; subject: unknown; payload: unknown; createdAt: string; entryHash: string }>;
  nextBeforeSeq: number | null;
}

export class DashboardReadModel {
  constructor(private readonly db: SqliteDriver) {}

  /** All sessions with their derived label + safe metadata (newest-first by first_seen). */
  sessions(): DashboardSession[] {
    const rows = this.db.prepare(
      `SELECT session_id AS sessionId, session_name AS name, session_name_state AS nameState,
              management_state AS mgmt, source_last AS source, identify_confidence AS conf,
              agent_type AS agentType, project_alias AS projectAlias, project_id AS projectId,
              state AS connState, readiness, expired_at AS expiredAt,
              first_seen_at AS firstSeenAt, last_seen_source_at AS lastSeenSourceAt
         FROM sessions ORDER BY COALESCE(first_seen_at, created_at) DESC`,
    ).all() as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const sid = r.sessionId as string;
      const { label, routable } = deriveSessionLabel({
        managementState: (r.mgmt as string) ?? 'active',
        connectionState: (r.connState as string) ?? 'disconnected',
        readiness: (r.readiness as string) ?? 'disconnected',
        expiredAt: (r.expiredAt as string | null) ?? null,
      });
      const queued = (this.db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE recipient_session_id=? AND state IN ('queued','retry_wait')`).get(sid) as { n: number }).n;
      const unacked = (this.db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE recipient_session_id=? AND state='transport_written'`).get(sid) as { n: number }).n;
      return {
        sessionId: sid,
        name: (r.name as string | null) ?? null,
        sessionNameState: (r.nameState as string) ?? 'unnamed',
        label, routable,
        managementState: (r.mgmt as string) ?? 'active',
        source: (r.source as string | null) ?? null,
        identifyConfidence: (r.conf as string) ?? 'signal',
        agentType: (r.agentType as string | null) ?? null,
        project: (r.projectAlias as string) ?? (r.projectId as string) ?? 'unknown',
        firstSeenAt: (r.firstSeenAt as string | null) ?? null,
        lastSeenSourceAt: (r.lastSeenSourceAt as string | null) ?? null,
        queued, unacknowledged: unacked,
      };
    });
  }

  /** One session's detail (or null). Same safe projection as sessions(). */
  session(sessionId: string): DashboardSession | null {
    return this.sessions().find((s) => s.sessionId === sessionId) ?? null;
  }

  /**
   * A page of the audit ledger, newest-first, keyset-paginated by seq. `limit` is clamped
   * to [1, 500] so a hostile value cannot force an unbounded scan; `beforeSeq` (exclusive)
   * pages backward. Bodies are never present (the ledger stores ids/states/hashes only).
   */
  ledger(opts: { beforeSeq?: number; limit?: number } = {}): LedgerPage {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 500);
    const before = Number.isSafeInteger(opts.beforeSeq) && (opts.beforeSeq as number) > 0 ? opts.beforeSeq as number : null;
    const rows = (before === null
      ? this.db.prepare(`SELECT seq, event_type AS eventType, actor, subject_json AS subjectJson, payload_json AS payloadJson, created_at AS createdAt, entry_hash AS entryHash FROM ledger_events ORDER BY seq DESC LIMIT ?`).all(limit)
      : this.db.prepare(`SELECT seq, event_type AS eventType, actor, subject_json AS subjectJson, payload_json AS payloadJson, created_at AS createdAt, entry_hash AS entryHash FROM ledger_events WHERE seq < ? ORDER BY seq DESC LIMIT ?`).all(before, limit)
    ) as Array<{ seq: number; eventType: string; actor: string; subjectJson: string; payloadJson: string; createdAt: string; entryHash: string }>;
    const events = rows.map((r) => ({
      seq: r.seq, eventType: r.eventType, actor: r.actor,
      subject: safeParse(r.subjectJson), payload: safeParse(r.payloadJson),
      createdAt: r.createdAt, entryHash: r.entryHash,
    }));
    const nextBeforeSeq = events.length === limit ? events[events.length - 1]!.seq : null;
    return { events, nextBeforeSeq };
  }

  /** Aggregate banner data (ADR 0013 D6). The read-only worker cannot spawn a process
   *  listing, so it reports the managed+dormant count (the honest subtrahend); the broker
   *  computes the final `possibleUnmanaged` from a non-invasive live-process count. */
  unmanagedBanner(): UnmanagedBanner {
    const managedOrDormant = (this.db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE management_state IN ('active','dormant') AND expired_at IS NULL`).get() as { n: number }).n;
    return { possibleUnmanaged: 0, managedOrDormant };
  }
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
