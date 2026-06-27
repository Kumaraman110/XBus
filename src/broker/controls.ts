/**
 * People-facing scheduling controls (ADR 0005/0009). Encodes the receiver-side
 * receive policy that gates delivery BEFORE the retry/dispatch engine:
 *   active | paused | do_not_disturb | manual_checkpoint | blocked | disconnected
 *
 * - paused: messages persist; checkpoint pull returns nothing; resume re-enables.
 * - do_not_disturb: like paused for AUTOMATIC delivery; inspectable via inbox peek.
 * - manual_checkpoint: only `xbus process-next` injects (no auto checkpoint drain).
 * - blocked sender: sends from that alias are refused at send time (quarantine
 *   policy documented: reject-before-persist).
 */
import type { SqliteDriver } from '../database/connection.js';
import type { Clock } from '../shared/clock.js';

export type ReceiveControl = 'active' | 'paused' | 'do_not_disturb' | 'manual_checkpoint';

export class ControlsStore {
  constructor(private readonly db: SqliteDriver, private readonly clock: Clock) {}

  getControl(sessionId: string): ReceiveControl {
    const row = this.db.prepare('SELECT receiving FROM session_controls WHERE session_id=?').get(sessionId) as { receiving: number } | undefined;
    if (!row) return 'active';
    // `receiving` packs the mode: 1=active, 0=paused, 2=dnd, 3=manual.
    switch (row.receiving) {
      case 0: return 'paused';
      case 2: return 'do_not_disturb';
      case 3: return 'manual_checkpoint';
      default: return 'active';
    }
  }

  setControl(sessionId: string, mode: ReceiveControl): void {
    const v = mode === 'paused' ? 0 : mode === 'do_not_disturb' ? 2 : mode === 'manual_checkpoint' ? 3 : 1;
    const now = this.clock.nowIso();
    this.db
      .prepare('INSERT INTO session_controls (session_id, receiving, paused_at, updated_at) VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET receiving=excluded.receiving, paused_at=excluded.paused_at, updated_at=excluded.updated_at')
      .run(sessionId, v, mode === 'active' ? null : now, now);
  }

  /** Does automatic checkpoint delivery flow right now? (active only.) */
  autoDeliveryEnabled(sessionId: string): boolean {
    return this.getControl(sessionId) === 'active';
  }

  blockPeer(ownerSessionId: string, blockedAliasCi: string, idgen: () => string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO blocked_peers (id, owner_session_id, blocked_alias_ci, created_at) VALUES (?,?,?,?)')
      .run(idgen(), ownerSessionId, blockedAliasCi.toLowerCase(), this.clock.nowIso());
  }

  unblockPeer(ownerSessionId: string, blockedAliasCi: string): void {
    this.db.prepare('DELETE FROM blocked_peers WHERE owner_session_id=? AND blocked_alias_ci=?').run(ownerSessionId, blockedAliasCi.toLowerCase());
  }

  isBlocked(ownerSessionId: string, senderAliasCi: string): boolean {
    const row = this.db.prepare('SELECT 1 AS x FROM blocked_peers WHERE owner_session_id=? AND blocked_alias_ci=?').get(ownerSessionId, senderAliasCi.toLowerCase());
    return row !== undefined;
  }
}
