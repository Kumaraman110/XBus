/**
 * The `local-operator` principal (beta.6 Phase 2; ADR 0021).
 *
 * The dashboard communication console composes messages as a distinct, reserved actor —
 * NEVER a Claude session. This module defines that principal and provisions its single
 * reserved `sessions` row, which is REQUIRED because:
 *   - `recipient_sequences.recipient_session_id` has an FK to `sessions(session_id)` and
 *     `delivery.reply()` allocates a sequence for the reply's recipient (the operator),
 *     so a Claude session replying to the operator needs a real operator sessions row; and
 *   - `messages.sender_session_id` is NOT NULL and is the idempotency scope, so the
 *     operator's sends need a real sender id, not a free-floating sentinel.
 *
 * The row is hardened so the operator can never be mistaken for a routable/injectable
 * Claude session and never tombstoned by the 15-day retention reaper:
 *   - management_state='unmanaged', state='disconnected', readiness='disconnected'
 *     → deriveSessionLabel → 'unmanaged'/not-routable (excluded from the session selector);
 *   - session_name_state='active' with the reserved name so no real session can claim it;
 *   - expires_at=NULL AND the reaper skips it by id (belt-and-suspenders, ADR 0021 D1);
 *   - created by the broker, never via register_session → it holds NO SessionAuthority,
 *     epoch, live component, or connection, so it can never pull/ack/reply. It is a
 *     routing endpoint, not an actor.
 */
import type { SqliteDriver } from '../database/connection.js';
import type { Clock } from '../shared/clock.js';
import { XBUS_VERSION } from '../protocol/version.js';

/** The reserved operator session id. A fixed, unmistakable string (NOT a UUID) so it can
 *  never collide with a real CLAUDE_CODE_SESSION_ID and reads clearly in the ledger. */
export const OPERATOR_SESSION_ID = 'local-operator';
/** The operator's display alias/name (also its reserved session name — see
 *  RESERVED_SESSION_NAMES). What a recipient session sees as `from=`. */
export const OPERATOR_ALIAS = 'local-operator';
/** messages.author_type / thread_participants.actor_kind for operator-composed turns. */
export const OPERATOR_ACTOR_KIND = 'operator';
/** ledger_events.actor for operator mutations. */
export const OPERATOR_LEDGER_ACTOR = 'local-operator';

/** Is this the reserved operator session id? Used by the reaper (never expire it) and by
 *  the read model (never surface it as a routable target). */
export function isOperatorSession(sessionId: string): boolean {
  return sessionId === OPERATOR_SESSION_ID;
}

/**
 * Idempotently provision the reserved operator session row + its recipient-sequence
 * allocator + an active alias. Safe to call on every broker start (INSERT OR IGNORE /
 * guarded updates); never advances an epoch, never registers a component, never expires.
 * Runs in one transaction. Called from startBrokerHost AFTER migrations, BEFORE the daemon
 * binds — the operator must exist before any reply can be routed to it.
 */
export function ensureOperatorSession(db: SqliteDriver, clock: Clock): void {
  db.transaction(() => {
    const now = clock.nowIso();
    const existing = db.prepare('SELECT session_id FROM sessions WHERE session_id=?').get(OPERATOR_SESSION_ID) as { session_id: string } | undefined;
    if (!existing) {
      // A minimal, unmanaged, non-routable, non-expiring session row. No epoch is started
      // (active_epoch stays 0 — the operator never registers a component), and expires_at
      // is left NULL so the retention reaper never tombstones it (the reaper ALSO skips it
      // by id, ADR 0021). session_name_state='active' + the reserved name locks the name.
      db.prepare(
        `INSERT INTO sessions (
           session_id, automatic_alias, project_id, cwd, xbus_version, capabilities_json,
           receive_mode, state, readiness, last_seen_at, created_at, updated_at,
           management_state, source_last, identify_confidence,
           session_name, normalized_session_name, session_name_state
         ) VALUES (?,?,?,?,?, '[]', 'disconnected', 'disconnected', 'disconnected', ?,?,?,
           'unmanaged', 'operator', 'unidentified', ?, ?, 'active')`,
      ).run(
        OPERATOR_SESSION_ID, OPERATOR_ALIAS, '__xbus_operator__', '__xbus_operator__', XBUS_VERSION,
        now, now, now, OPERATOR_ALIAS, OPERATOR_ALIAS,
      );
      db.prepare('INSERT OR IGNORE INTO recipient_sequences (recipient_session_id, next_sequence) VALUES (?, 1)').run(OPERATOR_SESSION_ID);
      // An active global alias so aliasForSession(operator) returns 'local-operator'
      // (what the recipient sees as from=), not the automatic fallback.
      db.prepare(
        `INSERT INTO aliases (alias_id, alias, alias_ci, scope, project_id, session_id, active, created_at)
         VALUES (?,?,?, 'global', NULL, ?, 1, ?)`,
      ).run(`alias-${OPERATOR_SESSION_ID}`, OPERATOR_ALIAS, OPERATOR_ALIAS.toLowerCase(), OPERATOR_SESSION_ID, now);
    } else {
      // Idempotent hardening: make sure the row can never expire and stays unmanaged even if
      // a prior build (or a manual edit) left it otherwise. Never touches its epoch/components.
      db.prepare(
        `UPDATE sessions SET expires_at=NULL, expired_at=NULL, expiration_reason=NULL,
           management_state='unmanaged', updated_at=? WHERE session_id=?`,
      ).run(now, OPERATOR_SESSION_ID);
      db.prepare('INSERT OR IGNORE INTO recipient_sequences (recipient_session_id, next_sequence) VALUES (?, 1)').run(OPERATOR_SESSION_ID);
    }
  });
}
