/**
 * Beta.10 (Train B) — Collections: NON-ROUTABLE, LOCAL roster-organization metadata.
 *
 * These tests pin the PURE logic of the client-side Collections module (the inert static
 * asset src/broker/dashboard/static/collections.js): create/rename/delete, idempotent
 * membership, dangling-reference cleanup, corrupt-blob tolerance, and the roster filter.
 * Collections carry NO messaging/routing semantics — they never touch the broker or the wire.
 */
import { describe, it, expect } from 'vitest';
// The inert browser asset is a plain ES module; import its pure functions directly.
import {
  emptyState, loadCollections, saveCollections, normalizeName,
  createCollection, renameCollection, deleteCollection,
  addMember, removeMember, collectionsForSession, filterSessionsByCollection,
  COLLECTIONS_KEY,
  makeLocalStorageStore, makeServerStore,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — plain JS asset, no type declarations (intentional: it is a static UI file)
} from '../../src/broker/dashboard/static/collections.js';

/** A minimal in-memory Storage double. */
function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  } as Storage;
}

describe('Collections — pure state logic', () => {
  it('creates a collection and is idempotent on a case-insensitive name', () => {
    let st = emptyState();
    const r1 = createCollection(st, '  Backend agents  ');
    expect(r1.collection.name).toBe('Backend agents'); // trimmed
    st = r1.state;
    expect(st.collections).toHaveLength(1);
    // Same name (different case/space) returns the existing collection, no duplicate.
    const r2 = createCollection(st, 'backend agents');
    expect(r2.collection.id).toBe(r1.collection.id);
    expect(r2.state.collections).toHaveLength(1);
  });

  it('rejects an empty/whitespace name', () => {
    expect(normalizeName('   ')).toBeNull();
    const r = createCollection(emptyState(), '   ');
    expect(r.collection).toBeNull();
    expect(r.state.collections).toHaveLength(0);
  });

  it('adds/removes members idempotently and reports membership', () => {
    let { state, collection } = createCollection(emptyState(), 'Group A');
    const sid = 'aaaa1111-0000-4000-8000-000000000001';
    state = addMember(state, collection.id, sid);
    state = addMember(state, collection.id, sid); // idempotent
    expect(collectionsForSession(state, sid)).toEqual([collection.id]);
    state = removeMember(state, collection.id, sid);
    expect(collectionsForSession(state, sid)).toEqual([]);
    // Removing again is a harmless no-op.
    expect(() => removeMember(state, collection.id, sid)).not.toThrow();
  });

  it('adding to an UNKNOWN collection is a no-op (never routes, never invents a group)', () => {
    const st = emptyState();
    const after = addMember(st, 'col-does-not-exist', 'sid-x');
    expect(collectionsForSession(after, 'sid-x')).toEqual([]);
  });

  it('deleting a collection drops it from every member', () => {
    let { state, collection } = createCollection(emptyState(), 'Doomed');
    state = addMember(state, collection.id, 's1');
    state = addMember(state, collection.id, 's2');
    state = deleteCollection(state, collection.id);
    expect(state.collections).toHaveLength(0);
    expect(collectionsForSession(state, 's1')).toEqual([]);
    expect(collectionsForSession(state, 's2')).toEqual([]);
  });

  it('renames a collection without disturbing membership', () => {
    let { state, collection } = createCollection(emptyState(), 'Old');
    state = addMember(state, collection.id, 's1');
    state = renameCollection(state, collection.id, 'New');
    expect(state.collections[0].name).toBe('New');
    expect(collectionsForSession(state, 's1')).toEqual([collection.id]);
  });
});

describe('Collections — roster filter', () => {
  const sessions = [
    { sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's3' },
  ];
  it("'all'/null returns every session; a collection id filters to members; 'ungrouped' returns non-members", () => {
    let { state, collection } = createCollection(emptyState(), 'Team');
    state = addMember(state, collection.id, 's1');
    state = addMember(state, collection.id, 's2');
    expect(filterSessionsByCollection(sessions, state, 'all').map((s) => s.sessionId)).toEqual(['s1', 's2', 's3']);
    expect(filterSessionsByCollection(sessions, state, null).map((s) => s.sessionId)).toEqual(['s1', 's2', 's3']);
    expect(filterSessionsByCollection(sessions, state, collection.id).map((s) => s.sessionId)).toEqual(['s1', 's2']);
    expect(filterSessionsByCollection(sessions, state, 'ungrouped').map((s) => s.sessionId)).toEqual(['s3']);
  });
});

describe('Collections — persistence + corruption tolerance', () => {
  it('round-trips through a Storage double', () => {
    const store = memStorage();
    let { state, collection } = createCollection(emptyState(), 'Persisted');
    state = addMember(state, collection.id, 'sX');
    expect(saveCollections(store, state)).toBe(true);
    const loaded = loadCollections(store);
    expect(loaded.collections).toHaveLength(1);
    expect(collectionsForSession(loaded, 'sX')).toEqual([collection.id]);
  });

  it('tolerates a corrupt/legacy blob (returns empty, never throws)', () => {
    const store = memStorage();
    store.setItem(COLLECTIONS_KEY, '{ this is not json');
    expect(loadCollections(store)).toEqual(emptyState());
    // A structurally-wrong object is normalized to empty, not crashed on.
    store.setItem(COLLECTIONS_KEY, JSON.stringify({ collections: 'nope', members: 42 }));
    expect(loadCollections(store)).toEqual(emptyState());
  });

  it('drops dangling membership (a member of a collection that no longer exists) on load', () => {
    const store = memStorage();
    // A hand-crafted blob referencing a non-existent collection id.
    store.setItem(COLLECTIONS_KEY, JSON.stringify({ version: 1, collections: [{ id: 'c1', name: 'Real' }], members: { s1: ['c1', 'ghost'] } }));
    const loaded = loadCollections(store);
    expect(collectionsForSession(loaded, 's1')).toEqual(['c1']); // 'ghost' dropped
  });

  it('save/load never throw when storage is unavailable (private mode)', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect(loadCollections(broken)).toEqual(emptyState());
    expect(saveCollections(broken, emptyState())).toBe(false);
  });
});

describe('Collections — swappable persistence backend (WS3 cutover seam)', () => {
  // The dashboard consumes a CollectionsStore interface: async load() + save(state). Two impls:
  //  - localStorage (current default), and
  //  - server (broker DB via authenticated fetch) — ready for WS3 without touching call sites.
  it('localStorage store round-trips via load()/save() (async contract)', async () => {
    const mem = memStorage();
    const store = makeLocalStorageStore(mem);
    let { state, collection } = createCollection(await store.load(), 'Local');
    state = addMember(state, collection.id, 'sA');
    await store.save(state);
    const reloaded = await store.load();
    expect(reloaded.collections.map((c: { name: string }) => c.name)).toEqual(['Local']);
    expect(collectionsForSession(reloaded, 'sA')).toEqual([collection.id]);
  });

  it('localStorage store.load() never throws on unavailable storage (returns empty)', async () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } as unknown as Storage;
    const store = makeLocalStorageStore(broken);
    await expect(store.load()).resolves.toEqual(emptyState());
    await expect(store.save(emptyState())).resolves.toBe(false);
  });

  it('server store GETs the projection on load() and normalizes it', async () => {
    // A fake authenticated API client (the same shape app.js exposes as window.XBusApi).
    const calls: Array<{ path: string; body?: unknown }> = [];
    const api = {
      get: async (path: string) => { calls.push({ path }); return { version: 1, collections: [{ id: 'c1', name: 'Server A' }], members: { s1: ['c1', 'ghost'] } }; },
      post: async (path: string, body: unknown) => { calls.push({ path, body }); return { ok: true, status: 200, body: {} }; },
    };
    const store = makeServerStore(api);
    const state = await store.load();
    expect(calls[0]!.path).toBe('/api/collections');
    // Normalized: dangling 'ghost' membership dropped even from the server payload.
    expect(collectionsForSession(state, 's1')).toEqual(['c1']);
  });

  it('server store PUTs the full state on save() to the authenticated write route', async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const api = {
      get: async (path: string) => { calls.push({ path }); return emptyState(); },
      post: async (path: string, body: unknown) => { calls.push({ path, body }); return { ok: true, status: 200, body: {} }; },
    };
    const store = makeServerStore(api);
    const { state } = createCollection(emptyState(), 'To persist');
    const ok = await store.save(state);
    expect(ok).toBe(true);
    const save = calls.find((c) => c.path === '/api/collections');
    expect(save, 'a write to /api/collections').toBeTruthy();
    expect((save!.body as { collections: unknown[] }).collections).toHaveLength(1);
  });

  it('server store.save() returns false (never throws) on a write failure', async () => {
    const api = {
      get: async () => emptyState(),
      post: async () => ({ ok: false, status: 503, body: { error: 'write_unavailable' } }),
    };
    const store = makeServerStore(api);
    await expect(store.save(emptyState())).resolves.toBe(false);
  });

  it('server store.load() falls back to empty (never throws) on a read failure', async () => {
    const api = {
      get: async () => { throw new Error('network'); },
      post: async () => ({ ok: true, status: 200, body: {} }),
    };
    const store = makeServerStore(api);
    await expect(store.load()).resolves.toEqual(emptyState());
  });
});
