/**
 * BETA.10 WS3 — server-side Collections (s11). RED-first.
 *
 * Collections are local, non-routable, ordered, renameable, archiveable roster grouping over
 * LOGICAL agents (logical_identity_id). NOT message recipients, NOT group conversations. The
 * store exposes an operator-authorized read + a full-state replace (the dashboard POSTs the whole
 * {collections, members} state), plus targeted CRUD used by the replace. Safety invariants:
 *   - deleting a collection NEVER deletes agents (only the collection + its membership rows);
 *   - explicitly removing an identity (operatorRemoveRecord) cleans its membership transactionally;
 *   - unique ACTIVE normalized name per workspace; no duplicate member; ordering preserved.
 *
 * These map to the dashboard's locked contract: readCollections() → {version, collections:[{id,
 * name,sortOrder,state}], members:{logicalAgentId:[collectionId]}}; replaceCollections(state).
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
let n = 0;
const sid = (): string => { const h = (++n).toString(16).padStart(8, '0'); return `${h}-0000-4000-8000-000000000000`; };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-coll-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, new SeqIdGen('m'), 'b');
});
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function reg(name?: string): SessionAuthority {
  const s = sid();
  return store.register({ sessionId: s, instanceId: 'i', connectionId: `c-${s}`, processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack', 'reply'], role: 'mcp', ...(name ? { requestedSessionName: name } : {}) });
}

describe('WS3 Collections — CRUD, ordering, archive, membership (RED-first)', () => {
  it('read is empty initially; replace creates ordered collections + memberships; read round-trips', () => {
    const a1 = reg('agent-1');
    const a2 = reg('agent-2');
    expect(store.readCollections().collections).toHaveLength(0);
    store.replaceCollections({
      collections: [
        { id: 'c1', name: 'Backend', sortOrder: 0, state: 'active' },
        { id: 'c2', name: 'Frontend', sortOrder: 1, state: 'active' },
      ],
      members: { [a1.logicalIdentityId!]: ['c1'], [a2.logicalIdentityId!]: ['c1', 'c2'] },
    });
    const r = store.readCollections();
    expect(r.collections.map((c) => c.name)).toEqual(['Backend', 'Frontend']); // ordered by sortOrder
    expect(r.members[a2.logicalIdentityId!]!.sort()).toEqual(['c1', 'c2']);
    expect(r.version).toBeGreaterThan(0);
  });

  it('rename + reorder + archive via replace', () => {
    store.replaceCollections({ collections: [{ id: 'c1', name: 'Old', sortOrder: 0, state: 'active' }], members: {} });
    store.replaceCollections({ collections: [{ id: 'c1', name: 'Renamed', sortOrder: 5, state: 'archived' }], members: {} });
    const c = store.readCollections().collections[0]!;
    expect(c.name).toBe('Renamed');
    expect(c.sortOrder).toBe(5);
    expect(c.state).toBe('archived');
  });

  it('unique ACTIVE normalized name per workspace is enforced (two active same-name rejected)', () => {
    expect(() => store.replaceCollections({
      collections: [
        { id: 'c1', name: 'Team', sortOrder: 0, state: 'active' },
        { id: 'c2', name: 'team', sortOrder: 1, state: 'active' },
      ], members: {},
    })).toThrow();
  });

  it('SAFETY — deleting a collection (dropped from replace) NEVER deletes agents', () => {
    const a1 = reg('keep-me');
    store.replaceCollections({ collections: [{ id: 'c1', name: 'Temp', sortOrder: 0, state: 'active' }], members: { [a1.logicalIdentityId!]: ['c1'] } });
    // replace with c1 GONE → the collection + its membership vanish, the AGENT remains.
    store.replaceCollections({ collections: [], members: {} });
    expect(store.readCollections().collections).toHaveLength(0);
    const agentStillExists = (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE session_id=?').get(a1.sessionId) as { n: number }).n;
    expect(agentStillExists, 'deleting a collection must not delete the agent').toBe(1);
    const memberRows = (db.prepare('SELECT COUNT(*) AS n FROM collection_members').get() as { n: number }).n;
    expect(memberRows, 'membership rows for the deleted collection are gone').toBe(0);
  });

  it('SAFETY — operatorRemoveRecord cleans the removed identity membership transactionally', () => {
    const a1 = reg('doomed');
    store.replaceCollections({ collections: [{ id: 'c1', name: 'Grp', sortOrder: 0, state: 'active' }], members: { [a1.logicalIdentityId!]: ['c1'] } });
    expect((db.prepare('SELECT COUNT(*) AS n FROM collection_members WHERE logical_agent_id=?').get(a1.logicalIdentityId!) as { n: number }).n).toBe(1);
    // Explicitly remove the identity.
    db.prepare(`UPDATE sessions SET state='disconnected' WHERE session_id=?`).run(a1.sessionId);
    db.prepare(`UPDATE component_instances SET state='closed' WHERE session_id=?`).run(a1.sessionId);
    store.operatorRemoveRecord(a1.sessionId);
    // membership cleaned; the collection itself survives (only the member left).
    expect((db.prepare('SELECT COUNT(*) AS n FROM collection_members WHERE logical_agent_id=?').get(a1.logicalIdentityId!) as { n: number }).n, 'removed identity membership is cleaned').toBe(0);
    expect(store.readCollections().collections, 'the collection itself survives an agent removal').toHaveLength(1);
  });

  it('no duplicate member (same agent twice in one collection collapses to one row)', () => {
    const a1 = reg('dup');
    store.replaceCollections({ collections: [{ id: 'c1', name: 'D', sortOrder: 0, state: 'active' }], members: { [a1.logicalIdentityId!]: ['c1', 'c1'] } });
    expect((db.prepare('SELECT COUNT(*) AS n FROM collection_members WHERE collection_id=? AND logical_agent_id=?').get('c1', a1.logicalIdentityId!) as { n: number }).n).toBe(1);
  });
});
