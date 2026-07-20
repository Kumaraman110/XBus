/* XBus dashboard — Collections (beta.10, Train B).
 *
 * A Collection is NON-ROUTABLE, LOCAL organizational metadata for grouping agents in the
 * roster (roster organization ONLY). A Collection is NOT a group conversation and carries NO
 * messaging/routing semantics — true group messaging is a separate conversation-domain
 * capability and is deliberately out of scope here. Collections are never sent to the broker,
 * never influence delivery, and never appear on the wire.
 *
 * PERSISTENCE (deliberate): client-side localStorage, same store/pattern as the theme +
 * internal-sessions preferences. Rationale: the dashboard is a single-operator, loopback-only
 * tool, and a server-side Collections table would require a schema migration that bumps
 * SCHEMA_VERSION (derived from the max migration version) and therefore the fail-closed wire
 * compatibility tuple — coupling this change to a coordinated whole-install release. Keeping
 * Collections client-side keeps this purely a dashboard concern with no schema/broker/wire
 * impact. Membership is keyed by the durable canonical session_id, so it survives refresh as
 * long as the session record exists. (If shared-across-browsers persistence is later required,
 * that is an additive server-side change — see the capability-closure ledger.)
 *
 * This module is CSP-safe (script-src 'self', no inline). It is written as an ES module so the
 * pure logic is unit-testable under vitest; it also publishes the same API on
 * `window.XBusCollections` for the classic app.js to consume in the browser.
 */
'use strict';

export const COLLECTIONS_KEY = 'xbus.collections';
const SCHEMA = 1;

/** A fresh, empty Collections state. */
export function emptyState() {
  return { version: SCHEMA, collections: [], members: {} };
}

/** Coerce any parsed value into a well-formed state (defensive against a corrupt/legacy blob). */
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return emptyState();
  const collections = Array.isArray(raw.collections)
    ? raw.collections.filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string').map((c) => ({ id: c.id, name: c.name }))
    : [];
  const validIds = new Set(collections.map((c) => c.id));
  const members = {};
  if (raw.members && typeof raw.members === 'object') {
    for (const sid of Object.keys(raw.members)) {
      const list = raw.members[sid];
      if (!Array.isArray(list)) continue;
      // Keep only membership in collections that still exist (drop dangling references).
      const kept = [...new Set(list.filter((id) => typeof id === 'string' && validIds.has(id)))];
      if (kept.length) members[sid] = kept;
    }
  }
  return { version: SCHEMA, collections, members };
}

/** Load state from a Storage-like object (localStorage). Never throws (private mode / bad JSON). */
export function loadCollections(storage) {
  try {
    const s = storage && storage.getItem ? storage.getItem(COLLECTIONS_KEY) : null;
    if (!s) return emptyState();
    return normalize(JSON.parse(s));
  } catch { return emptyState(); }
}

/** Persist state. Never throws. Returns true iff written. */
export function saveCollections(storage, state) {
  try {
    if (!storage || !storage.setItem) return false;
    storage.setItem(COLLECTIONS_KEY, JSON.stringify(normalize(state)));
    return true;
  } catch { return false; }
}

/** A small non-crypto id (no dependency in the inert asset). */
function newId() {
  return 'col-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

/** Trim + bound a collection name; returns null if empty after trim. */
export function normalizeName(name) {
  const n = String(name == null ? '' : name).trim().slice(0, 60);
  return n.length ? n : null;
}

/** Create a collection (idempotent on case-insensitive name — returns the existing one if present).
 *  Returns { state, collection } (a NEW state object; callers persist it). */
export function createCollection(state, name) {
  const st = normalize(state);
  const nm = normalizeName(name);
  if (!nm) return { state: st, collection: null };
  const existing = st.collections.find((c) => c.name.toLowerCase() === nm.toLowerCase());
  if (existing) return { state: st, collection: existing };
  const collection = { id: newId(), name: nm };
  return { state: { ...st, collections: [...st.collections, collection] }, collection };
}

/** Rename a collection (no-op if id unknown or name empty). Returns a new state. */
export function renameCollection(state, collectionId, name) {
  const st = normalize(state);
  const nm = normalizeName(name);
  if (!nm) return st;
  return { ...st, collections: st.collections.map((c) => (c.id === collectionId ? { ...c, name: nm } : c)) };
}

/** Delete a collection AND drop it from every session's membership. Returns a new state. */
export function deleteCollection(state, collectionId) {
  const st = normalize(state);
  const members = {};
  for (const sid of Object.keys(st.members)) {
    const kept = st.members[sid].filter((id) => id !== collectionId);
    if (kept.length) members[sid] = kept;
  }
  return { version: SCHEMA, collections: st.collections.filter((c) => c.id !== collectionId), members };
}

/** Add a session to a collection (idempotent). Returns a new state. */
export function addMember(state, collectionId, sessionId) {
  const st = normalize(state);
  if (!st.collections.some((c) => c.id === collectionId)) return st; // unknown collection
  const cur = st.members[sessionId] ? [...st.members[sessionId]] : [];
  if (cur.includes(collectionId)) return st;
  return { ...st, members: { ...st.members, [sessionId]: [...cur, collectionId] } };
}

/** Remove a session from a collection. Returns a new state. */
export function removeMember(state, collectionId, sessionId) {
  const st = normalize(state);
  const cur = st.members[sessionId];
  if (!cur) return st;
  const kept = cur.filter((id) => id !== collectionId);
  const members = { ...st.members };
  if (kept.length) members[sessionId] = kept; else delete members[sessionId];
  return { ...st, members };
}

/** The collection ids a session belongs to (empty array if none). */
export function collectionsForSession(state, sessionId) {
  const st = normalize(state);
  return st.members[sessionId] ? [...st.members[sessionId]] : [];
}

/**
 * Filter a session list by a collection selector:
 *  - null / '' / 'all' → all sessions (no filter)
 *  - 'ungrouped'       → sessions in NO collection
 *  - <collectionId>    → sessions in that collection
 * Pure — returns a new array, never mutates input.
 */
export function filterSessionsByCollection(sessions, state, selector) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (!selector || selector === 'all') return list.slice();
  const st = normalize(state);
  if (selector === 'ungrouped') return list.filter((s) => !(st.members[s.sessionId] && st.members[s.sessionId].length));
  return list.filter((s) => st.members[s.sessionId] && st.members[s.sessionId].includes(selector));
}

// Publish on window for the classic (non-module) app.js in the browser. Guarded so importing
// this module under vitest (no window) is a harmless no-op.
if (typeof window !== 'undefined') {
  window.XBusCollections = {
    COLLECTIONS_KEY, emptyState, loadCollections, saveCollections, normalizeName,
    createCollection, renameCollection, deleteCollection, addMember, removeMember,
    collectionsForSession, filterSessionsByCollection,
  };
}
