/**
 * Cancellation semantics by delivery state (reliability contract §10). The CLI
 * must NOT claim "cancelled" once the message may already be in the model.
 */
import type { SqliteDriver } from '../database/connection.js';
import type { Clock, IdGen } from '../shared/clock.js';
import { DeliveryState } from '../protocol/states.js';

export type CancelOutcome =
  | 'cancelled_before_delivery'
  | 'cancellation_requested_after_injection'
  | 'already_completed'
  | 'cannot_confirm_delivery_state';

export interface CancelResult {
  outcome: CancelOutcome;
  state: string;
  detail: string;
}

export class CancellationOps {
  constructor(private readonly db: SqliteDriver, private readonly clock: Clock, private readonly ids: IdGen) {}

  /**
   * Cancel by sender. Only the original sender may cancel (caller checks that).
   *  - queued / retry_wait (pre-injection)  -> hard cancel (prevents delivery).
   *  - transport_written / accepted (injected) -> advisory request only.
   *  - completed / terminal                 -> already_completed / cannot_confirm.
   */
  cancel(messageId: string, opts: { reason?: string } = {}): CancelResult {
    return this.db.transaction(() => {
      const d = this.db.prepare('SELECT state FROM deliveries WHERE message_id=?').get(messageId) as { state: string } | undefined;
      if (!d) return { outcome: 'cannot_confirm_delivery_state', state: 'unknown', detail: 'no such delivery' };
      const now = this.clock.nowIso();

      if (d.state === DeliveryState.QUEUED || d.state === DeliveryState.RETRY_WAIT) {
        const res = this.db.prepare(`UPDATE deliveries SET state='${DeliveryState.CANCELLED}', updated_at=? WHERE message_id=? AND state IN ('${DeliveryState.QUEUED}','${DeliveryState.RETRY_WAIT}')`).run(now, messageId);
        if (res.changes > 0) {
          this.audit('CANCELLED_BEFORE_DELIVERY', messageId, opts.reason);
          return { outcome: 'cancelled_before_delivery', state: DeliveryState.CANCELLED, detail: 'delivery prevented before any context injection' };
        }
        // lost a race; re-read
        return this.cancel(messageId, opts);
      }

      if (d.state === DeliveryState.TRANSPORT_WRITTEN || d.state === DeliveryState.ACCEPTED) {
        // Advisory only — the content may already be in / acted on by the model.
        this.audit('CANCELLATION_REQUESTED_AFTER_INJECTION', messageId, opts.reason);
        return {
          outcome: 'cancellation_requested_after_injection',
          state: d.state,
          detail: 'message already injected into recipient context; cancellation is a request, not a guarantee',
        };
      }

      if (d.state === DeliveryState.COMPLETED) {
        return { outcome: 'already_completed', state: d.state, detail: 'the request already completed' };
      }

      return { outcome: 'cannot_confirm_delivery_state', state: d.state, detail: `delivery is in terminal state ${d.state}` };
    });
  }

  private audit(type: string, messageId: string, reason?: string): void {
    this.db.prepare('INSERT INTO audit_events (audit_id, event_type, message_id, safe_metadata_json, created_at) VALUES (?,?,?,?,?)').run(this.ids.next(), type, messageId, JSON.stringify(reason ? { reason } : {}), this.clock.nowIso());
  }
}
