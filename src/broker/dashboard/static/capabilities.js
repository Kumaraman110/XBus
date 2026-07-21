/* XBus dashboard — capability probe (beta.10, Train B). PURE + CSP-safe.
 *
 * Pre-staging for the WS1 broker batch (#1 redelivery, #5 /api/health, #2 instances[], collections
 * /api). The dashboard's own release gate forbids rendering a dead control before its endpoint
 * exists, so optional features are GATED on this probe. It does cheap authenticated GETs against the
 * not-yet-existing endpoints; while they 404 the flags stay OFF and nothing renders. The instant WS1
 * ships them, the same probe flips the flags — no code change at the call sites.
 *
 * Contract (matches the shapes WS2 specified to WS1):
 *   - GET /api/health → { build, runtime, ledger, readWorker, capabilities?: string[] }
 *       capabilities may explicitly advertise 'redeliver' / 'instances'. If /api/health responds but
 *       omits the list, we INFER both (the batch ships together per the coordinator's plan) — still
 *       safe because the individual call sites also verify the concrete field/endpoint before acting.
 *   - GET /api/collections → the collections projection (presence ⇒ server-side collections available)
 *
 * ES module for unit-testability; published on window.XBusCaps for app.js/agents.js.
 */
'use strict';

/** All capabilities OFF — the pre-WS1 default (nothing optional renders). */
export function emptyCaps() {
  return { health: false, redeliver: false, instances: false, removeSafe: false, collectionsServer: false };
}

/**
 * Derive the health-gated feature flags from a /api/health body. A well-formed object ⇒ health:true.
 * An explicit `capabilities` array is honored exactly; absent ⇒ infer the WS1 batch shipped together
 * (redeliver + instances both on). A null/garbage body ⇒ everything off.
 */
export function parseHealthCapabilities(body) {
  if (!body || typeof body !== 'object') return { health: false, redeliver: false, instances: false, removeSafe: false };
  if (Array.isArray(body.capabilities)) {
    const set = new Set(body.capabilities.map((x) => String(x)));
    // removeSafe: only when the broker EXPLICITLY advertises the KNOWN-3-safe teardown. Never
    // inferred — remove_record is destructive, so it lights ONLY on an explicit safe signal.
    return { health: true, redeliver: set.has('redeliver'), instances: set.has('instances'), removeSafe: set.has('remove_safe') };
  }
  // Health present, no explicit list → the batch ships together (coordinator's plan): infer the
  // read-only features, but NOT removeSafe (destructive → requires an explicit advertised signal).
  return { health: true, redeliver: true, instances: true, removeSafe: false };
}

/**
 * Probe the broker for optional capabilities. NEVER throws: a missing endpoint (404 → api.get
 * rejects) simply leaves that flag off. `api` is the app.js seam (window.XBusApi): get(path)
 * resolves the parsed JSON body or rejects on a non-ok read.
 */
export async function probeCapabilities(api) {
  const caps = emptyCaps();
  // #5 /api/health (+ #1 redeliver / #2 instances advertised or inferred).
  try {
    const health = await api.get('/api/health');
    const hc = parseHealthCapabilities(health);
    caps.health = hc.health; caps.redeliver = hc.redeliver; caps.instances = hc.instances; caps.removeSafe = hc.removeSafe;
  } catch { /* /api/health absent → health features stay off */ }
  // Server-side collections: the endpoint fail-closes to an EMPTY {version:0,...} on an s10 DB
  // (pre-s11 migration), so mere 200 is NOT enough — we require a live s11 store (version >= 1)
  // before switching off localStorage. Pre-s11 → keep localStorage (Package D sequencing note).
  try {
    const col = await api.get('/api/collections');
    caps.collectionsServer = !!(col && typeof col === 'object' && typeof col.version === 'number' && col.version >= 1);
  } catch { /* /api/collections absent → keep localStorage collections */ }
  return caps;
}

if (typeof window !== 'undefined') {
  window.XBusCaps = { emptyCaps, parseHealthCapabilities, probeCapabilities };
}
