/**
 * Beta.7 (ADR 0024) — Claude title capture (separate from the xbus alias) + operator session
 * controls (rename alias / pause-DND / pin / archive / remove-record / managed stop).
 *
 * Proves the store-level contract WITHOUT the daemon/dashboard: title is captured from the
 * documented SessionStart field into claude_title (NEVER conflated with session_name/alias,
 * NEVER routing-read), the operator controls mutate the right columns + append a ledger event,
 * remove-record never deletes a transcript, and stop-managed refuses a non-managed session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority } from '../../src/broker/store.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let clock: FakeClock;
const S = 'ssss7777-0000-4000-8000-00000000cccc';

function setup(): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-ctrl-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, new SeqIdGen('c'), 'b');
}
beforeEach(() => setup());
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function register(name?: string): SessionAuthority {
  const auth = store.register({ sessionId: S, instanceId: 'iS', connectionId: 'cS', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', ...(name ? { requestedSessionName: name } : {}) });
  store.signalReadiness(auth, { ackAvailable: true, versionOk: true });
  return auth;
}
function row(): Record<string, unknown> {
  return db.prepare('SELECT claude_title, claude_title_source, claude_title_at, session_name, normalized_session_name, pinned, archived, archived_at FROM sessions WHERE session_id=?').get(S) as Record<string, unknown>;
}
function hookAuth(a: SessionAuthority): SessionAuthority { return { ...a, role: 'hook' as never }; }
function ledgerCount(eventType: string): number {
  return (db.prepare('SELECT COUNT(*) n FROM ledger_events WHERE event_type=?').get(eventType) as { n: number }).n;
}

describe('Claude title capture (ADR 0024) — separate from the xbus alias', () => {
  it('captures session_title from announce into claude_title, never touching the xbus name', () => {
    const auth = register('seatmap-api'); // xbus alias
    store.announceSession(hookAuth(auth), { source: 'startup', sessionTitle: 'Refactor auth flow' });
    const r = row();
    expect(r.claude_title).toBe('Refactor auth flow');
    expect(r.claude_title_source).toBe('startup');
    expect(r.claude_title_at).not.toBeNull();
    // The xbus alias pool is UNTOUCHED — the two identities are distinct.
    expect(r.session_name).toBe('seatmap-api');
    expect(r.normalized_session_name).toBe('seatmap-api');
    // claude_title is NEVER normalized/reserved and is display-only text.
  });

  it('a later /rename-style title overwrites (latest wins); an absent title never clears it', () => {
    const auth = register('svc');
    store.announceSession(hookAuth(auth), { source: 'startup', sessionTitle: 'First title' });
    store.announceSession(hookAuth(auth), { source: 'resume', sessionTitle: 'Renamed title' });
    expect(row().claude_title).toBe('Renamed title');
    expect(row().claude_title_source).toBe('resume');
    // An announce with NO title must not wipe the captured one.
    store.announceSession(hookAuth(auth), { source: 'resume' });
    expect(row().claude_title).toBe('Renamed title');
  });

  it('the captured title never becomes a routable alias (resolveRecipient must not find it)', () => {
    const auth = register('realname');
    store.announceSession(hookAuth(auth), { source: 'startup', sessionTitle: 'display-only-title' });
    // A peer cannot address the session by its Claude TITLE (only by the xbus name/alias/id).
    const other = store.register({ sessionId: 'oooo0000-0000-4000-8000-00000000000f', instanceId: 'io', connectionId: 'co', processId: 2, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp' });
    expect(() => store.send(other, { to: 'display-only-title', text: 'x', kind: 'request', requiresAck: false, requiresReply: false })).toThrow(); // UNKNOWN_RECIPIENT
    // …but the real xbus name resolves fine.
    expect(() => store.send(other, { to: 'realname', text: 'x', kind: 'request', requiresAck: false, requiresReply: false })).not.toThrow();
  });
});

describe('operator session controls (ADR 0024)', () => {
  it('rename alias sets the xbus name + ledgers; a taken name is rejected', () => {
    register('oldname');
    const r = store.operatorRenameAlias(S, 'newname');
    expect(r.state).toBe('active');
    expect(r.name).toBe('newname');
    expect(row().session_name).toBe('newname');
    expect(ledgerCount('OPERATOR_ALIAS_RENAMED')).toBe(1);
    // A second session holding a name → rename to it is rejected.
    store.register({ sessionId: 'tttt0000-0000-4000-8000-00000000000e', instanceId: 'it', connectionId: 'ct', processId: 3, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: [], role: 'mcp', requestedSessionName: 'taken' });
    expect(() => store.operatorRenameAlias(S, 'taken')).toThrow();
  });

  it('pause/DND control sets the receive control + ledgers', () => {
    register();
    store.operatorSetControl(S, 'paused');
    const c = db.prepare('SELECT receiving FROM session_controls WHERE session_id=?').get(S) as { receiving: number } | undefined;
    expect(c?.receiving).toBe(0); // paused
    expect(ledgerCount('OPERATOR_CONTROL_SET')).toBe(1);
    store.operatorSetControl(S, 'active');
    expect((db.prepare('SELECT receiving FROM session_controls WHERE session_id=?').get(S) as { receiving: number }).receiving).toBe(1);
  });

  it('pin/archive set the lifecycle flags + ledger; unarchive clears archived_at', () => {
    register();
    store.operatorSetPinned(S, true);
    expect(row().pinned).toBe(1);
    store.operatorSetArchived(S, true);
    expect(row().archived).toBe(1);
    expect(row().archived_at).not.toBeNull();
    store.operatorSetArchived(S, false);
    expect(row().archived).toBe(0);
    expect(row().archived_at).toBeNull();
    expect(ledgerCount('OPERATOR_SESSION_PINNED')).toBe(1);
    expect(ledgerCount('OPERATOR_SESSION_ARCHIVED')).toBe(1);
  });

  it('remove-record deletes the row + projections but NEVER the transcript, and refuses a connected session', () => {
    const auth = register('gone');
    // Record a transcript path (as announce would); prove the file is untouched by removal.
    const transcript = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(transcript, '{"real":"transcript"}');
    db.prepare('UPDATE sessions SET transcript_path=? WHERE session_id=?').run(transcript, S);
    // A CONNECTED session is refused.
    expect(() => store.operatorRemoveRecord(S)).toThrow();
    // Disconnect it, then remove.
    db.prepare("UPDATE sessions SET state='disconnected' WHERE session_id=?").run(S);
    const r = store.operatorRemoveRecord(S);
    expect(r.removed).toBe(true);
    expect(db.prepare('SELECT session_id FROM sessions WHERE session_id=?').get(S)).toBeUndefined();
    expect(db.prepare('SELECT recipient_session_id FROM recipient_sequences WHERE recipient_session_id=?').get(S)).toBeUndefined();
    // THE TRANSCRIPT FILE IS UNTOUCHED.
    expect(fs.existsSync(transcript)).toBe(true);
    expect(fs.readFileSync(transcript, 'utf8')).toContain('real');
    void auth;
  });

  it('stop-managed refuses a non-managed session; succeeds + returns liveness anchors + clears ALL managed markers', () => {
    register();
    // Not managed → refused.
    expect(() => store.clearManagedSession(S)).toThrow();
    // Mark it managed (as the launcher would), then stop.
    store.recordManagedSession(S, 999999, 'sched:x:1');
    expect((db.prepare('SELECT managed_by_xbus FROM sessions WHERE session_id=?').get(S) as { managed_by_xbus: number }).managed_by_xbus).toBe(1);
    const r = store.clearManagedSession(S);
    expect(r.pid).toBe(999999);
    // The liveness anchors are returned so the daemon can validate before any kill (ADR 0024 §4).
    expect(r.launchKey).toBe('sched:x:1');
    expect(r.startedAt).not.toBeNull();
    // ALL managed markers cleared (not just pid) — a stale started_at/launch_key can't linger.
    const after = db.prepare('SELECT managed_by_xbus, managed_pid, managed_started_at, managed_launch_key FROM sessions WHERE session_id=?').get(S) as { managed_by_xbus: number; managed_pid: number | null; managed_started_at: string | null; managed_launch_key: string | null };
    expect(after.managed_by_xbus).toBe(0);
    expect(after.managed_pid).toBeNull();
    expect(after.managed_started_at).toBeNull();
    expect(after.managed_launch_key).toBeNull();
  });

  it('markManagedSessionExited clears markers so a dead session retains NO killable pid; idempotent + safe on non-managed', () => {
    register();
    // Safe no-op on a non-managed session (never throws).
    expect(() => store.markManagedSessionExited(S)).not.toThrow();
    store.recordManagedSession(S, 424242, 'sched:y:2');
    store.markManagedSessionExited(S);
    const after = db.prepare('SELECT managed_by_xbus, managed_pid FROM sessions WHERE session_id=?').get(S) as { managed_by_xbus: number; managed_pid: number | null };
    expect(after.managed_by_xbus).toBe(0);
    expect(after.managed_pid).toBeNull(); // no killable pid left → a later stop can't SIGTERM a recycled pid
    // Idempotent: a second call is a harmless no-op.
    expect(() => store.markManagedSessionExited(S)).not.toThrow();
    expect(ledgerCount('MANAGED_SESSION_EXITED')).toBe(1);
  });
});
