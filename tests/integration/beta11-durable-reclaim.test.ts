/**
 * BETA.11 — durable-identity reclaim reliability for RESUMED persistent sessions.
 *
 * User-reported defect: a session named 'AccountLookUp' (disconnected) was resumed after upgrading to
 * beta.10; the resumed session got a NEW claude session id, landed name=none/pending/hook-only, and
 * `xbus_rename AccountLookUp` returned XBUS_SESSION_NAME_TAKEN. The successor should have AUTOMATICALLY
 * reclaimed the disconnected predecessor's durable logical identity (name + inbox + reply-pending
 * authority) by presenting the persisted owner-secret.
 *
 * Root causes (three independent, all surface as NAME_TAKEN / no-reclaim):
 *   (C1) NAME-ANCHOR MISMATCH — the owner-secret is keyed (projectId, normalize(AWARDED name)) but the
 *        resumed MCP requests the AUTO-DERIVED workspace suggestion and never re-requests the awarded
 *        name (SESSION_NAME is read-only, never persisted), so loadOwnerSecret misses → ownerSecret
 *        undefined → resolveReclaim never runs. THIS is the user's confirmed case.
 *   (C2) STALE-LIVE LIVENESS GATE — resolveReclaim refuses when hasLiveMcp() sees a raw state='live'
 *        mcp component; a HARD CRASH (no socket-close) leaves it 'live', so a correct secret-bearing
 *        reclaim of a genuinely-dead predecessor is refused.
 *   (C3) UPGRADE DATADIR RELOCATION — covered in the upgrade test (beta11-upgrade-reclaim).
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * RED-FIRST: these assertions encode the REQUIRED beta.11 behavior and FAIL on current beta.10. When
 * the fix lands they go green with no assertion edits. Reclaim SUCCESS is asserted via the real
 * RegisterResult signals — logicalIdentityId == the predecessor's, a physical_session_map redirect,
 * and awardedSessionName set — NOT a canonicalSessionId ack field (which does not exist).
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore, type SessionAuthority } from '../../src/broker/store.js';
import { Reaper } from '../../src/broker/reaper.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';
import { DeliveryState } from '../../src/protocol/states.js';
import { saveOwnerSecret, loadOwnerSecret, saveDurableName, resolveDurableName } from '../../src/channel/owner-secret-store.js';
import { normalizeSessionName, suggestSessionName } from '../../src/identity/session-name.js';
import { deriveWorkspaceSuggestion } from '../../src/identity/project.js';

let dir: string; let db: SqliteDriver; let store: BrokerStore; let clock: FakeClock; let reaper: Reaper;
let dataDir: string;
let n = 0;
const sid = (): string => { const h = (++n).toString(16).padStart(8, '0'); return `${h}-0000-4000-8000-000000000000`; };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-b11-reclaim-'));
  dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, new SeqIdGen('m'), 'b');
  reaper = new Reaper(db, clock, new SeqIdGen('r'));
});
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const PROJECT = 'proj-accountlookup';

function reg(over: Partial<Parameters<BrokerStore['register']>[0]> = {}): SessionAuthority {
  const s = over.sessionId ?? sid();
  return store.register({ sessionId: s, instanceId: 'i', connectionId: `c-${s}`, processId: 1, projectId: PROJECT, cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', ...over });
}
function nameState(sessionId: string): { state: string; name: string | null } {
  return db.prepare('SELECT session_name_state AS state, session_name AS name FROM sessions WHERE session_id=?').get(sessionId) as { state: string; name: string | null };
}
function logicalOf(sessionId: string): string | null {
  return (db.prepare('SELECT logical_identity_id AS lid FROM sessions WHERE session_id=?').get(sessionId) as { lid: string | null } | undefined)?.lid ?? null;
}
function mapRedirect(physicalSessionId: string): string | null {
  return (db.prepare('SELECT canonical_session_id AS c FROM physical_session_map WHERE physical_session_id=?').get(physicalSessionId) as { c: string } | undefined)?.c ?? null;
}
function queuedFor(sessionId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE recipient_session_id=? AND state IN (?,?)`)
    .get(sessionId, DeliveryState.QUEUED, DeliveryState.TRANSPORT_WRITTEN) as { n: number }).n;
}
/** Clean disconnect at the store layer (daemon.onConnClose): state='disconnected', live components closed. */
function disconnectGraceful(sessionId: string): void {
  const now = clock.nowIso();
  db.prepare(`UPDATE sessions SET state='disconnected', bound_connection_id=NULL, last_seen_at=? WHERE session_id=?`).run(now, sessionId);
  db.prepare(`UPDATE component_instances SET state='closed', disconnected_at=? WHERE session_id=? AND state='live'`).run(now, sessionId);
}

describe('BETA.11 C1 — resumed session recovers its awarded name and auto-reclaims (the user AccountLookUp case)', () => {
  it('a resumed session whose workspace-suggestion != the awarded name STILL reclaims the disconnected predecessor', () => {
    // A registers, then is renamed to a name UNRELATED to the workspace suggestion (as the user did).
    const sidA = sid();
    const a = reg({ sessionId: sidA });
    // The workspace suggestion for A's cwd is NOT 'AccountLookUp' — model that: A gets renamed explicitly.
    const renameAck = store.renameSession(a, 'AccountLookUp');
    expect(nameState(sidA).name).toBe('AccountLookUp');
    // The client persists the owner secret under the AWARDED name (mcp-server.ts:312 behavior),
    // AND (BETA.11 fix A1) a (projectId, agentType) -> durableName reverse pointer so a resume can
    // recover the name it must re-request. On beta.10 only the by-name secret is saved (no pointer).
    expect(typeof renameAck.ownerSecret).toBe('string');
    const lidA = logicalOf(sidA);
    saveOwnerSecret(dataDir, PROJECT, normalizeSessionName('AccountLookUp'), renameAck.ownerSecret as string, lidA ?? undefined, clock.nowIso());
    saveDurableName(dataDir, PROJECT, 'claude', 'AccountLookUp', lidA ?? undefined, clock.nowIso());

    // A queued request pins to A (reply-pending authority follows the durable identity post-fix).
    const sender = reg({ requestedSessionName: 'ops-sender', projectId: 'proj-sender' });
    store.send(sender, { to: 'AccountLookUp', text: 'resume the lookup', kind: 'request', requiresAck: true, requiresReply: true });
    expect(queuedFor(sidA)).toBe(1);

    // A disconnects (predecessor 97c77985 gone). Well under retention; reaper must not expire it.
    disconnectGraceful(sidA);
    clock.advance(60 * 60_000);
    reaper.sweep();
    expect(nameState(sidA).state).toBe('active'); // predecessor still holds the name until reclaim

    // ── RESUME: successor B, NEW session id, SAME workspace/projectId, persistent activation. ──
    // The KEY of the defect: B derives its requested name from the WORKSPACE, which is NOT 'AccountLookUp'.
    const workspaceSuggestion = suggestSessionName(deriveWorkspaceSuggestion(dir, { agentType: 'claude', projectId: PROJECT })) ?? 'workspace-fallback';
    expect(normalizeSessionName(workspaceSuggestion)).not.toBe(normalizeSessionName('AccountLookUp'));

    // BETA.11 FIX A1/A2: the resume recovers the durable name for (projectId, agentType) so it
    // re-requests it. On beta.10 there is no reverse pointer → resolveDurableName returns null → B
    // requests the workspace suggestion → owner-secret miss → NO reclaim. This is the RED-first hinge.
    const recovered = resolveDurableName(dataDir, PROJECT, 'claude'); // POST-FIX: 'AccountLookUp'; beta.10: null
    const requestName = recovered ?? workspaceSuggestion;
    const ownerSecret = loadOwnerSecret(dataDir, PROJECT, normalizeSessionName(requestName)); // POST-FIX: the saved secret

    const sidB = sid();
    const b = reg({ sessionId: sidB, requestedSessionName: requestName, ...(ownerSecret ? { ownerSecret } : {}) });

    // REQUIRED beta.11 behavior — reclaim SUCCEEDS via the real signals. On reclaim the successor's
    // registration is REDIRECTED onto the canonical (predecessor) session id, so it inherits the name
    // + inbox with ZERO row movement (the inbox is keyed on the canonical id, never re-keyed). Hence
    // there is no separate `sessions` row for sidB — success is: b.sessionId==canonical, same logical
    // identity, and a physical_session_map redirect sidB→canonical.
    expect(b.sessionNameState).toBe('active');                 // beta.10: 'pending'
    expect(b.awardedSessionName).toBe('AccountLookUp');         // beta.10: null
    expect(b.nameReclaimFailed ?? false).toBe(false);          // beta.10: true
    expect(b.sessionId).toBe(sidA);                            // redirected onto the canonical durable id
    expect(b.logicalIdentityId).toBe(logicalOf(sidA));         // same durable logical identity
    expect(mapRedirect(sidB)).toBe(sidA);                      // physical_session_map redirect onto canonical A
    expect(nameState(sidA).state).toBe('active');              // predecessor row IS the canonical owner, still active
    // Inbox + reply-pending authority follow the durable identity (never re-keyed off the canonical id).
    expect(queuedFor(sidA)).toBe(1);                           // inbox intact on the canonical id
    expect(queuedFor(sidB)).toBe(0);                           // sidB is a redirect, not a separate inbox
    // New sends resolve to the (now-reclaimed, active) durable identity.
    const res2 = store.send(sender, { to: 'AccountLookUp', text: 'ping', kind: 'request', requiresAck: false, requiresReply: false });
    expect(res2.recipientSessionId).toBe(sidA);                // canonical durable id (== the reclaimed session)
  });
});
