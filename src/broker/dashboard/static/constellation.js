/*
 * AgenTel dashboard — Constellation (BETA.11): a three.js companion visualization of the live bus.
 *
 * A COMPANION view, NOT a replacement: the 2D console remains the operational surface (dense tables,
 * threads, inspector, keyboard/accessibility). This tab renders the same live data spatially —
 * durable logical identities as glowing nodes (colored by activation state), and message / thread /
 * delivery relationships as animated edges — so an operator can see the shape and flow of the fleet
 * at a glance.
 *
 * Cost discipline: three.js (~690 KB, vendored same-origin under /vendor/three for the strict CSP
 * `script-src 'self'` + full offline support) is loaded LAZILY — dynamic import()ed only the first
 * time the Constellation tab is opened. The 2D console and the headless API never parse/allocate the
 * WebGL library. The whole scene is disposed when the tab is hidden so we never animate off-screen.
 *
 * Data: reuses the existing authenticated /api/sessions payload (rendered.js/app.js already fetch it);
 * this module is handed the latest sessions array via update(sessions) and owns only the WebGL scene.
 */

// State-lazy handles (populated on first activate()).
let THREE = null;
let OrbitControls = null;
let loading = null;

// Scene graph handles.
let renderer = null, scene = null, camera = null, controls = null, container = null;
let nodeMesh = null, edgeLines = null, running = false, disposed = false;
let nodes = []; // [{ id, name, state, x,y,z, vx,vy,vz }]
let edges = []; // [{ a, b }] indices into nodes

// Activation-state → color (matches the 2D roster label palette conceptually).
const STATE_COLOR = {
  'active-ready': 0x4ade80,        // connected + routable — green
  'active-disconnected': 0xfbbf24, // durable but offline — amber (the reclaim-relevant state)
  'active-starting': 0x38bdf8,     // initializing — blue
  dormant: 0x8b5cf6,               // dormant/expired identity — violet
  expired: 0x6b7280,               // tombstoned — grey
  unmanaged: 0x94a3b8,             // grey-blue
  _default: 0x64748b,
};

function colorForSession(s) {
  // Derive a label the same way the roster does: routable+ready → active-ready; else by state.
  if (s.routable) return STATE_COLOR['active-ready'];
  if (s.expired) return STATE_COLOR.expired;
  const label = s.label || (s.connState === 'disconnected' ? 'active-disconnected' : 'active-starting');
  return STATE_COLOR[label] ?? STATE_COLOR._default;
}

/** Lazy-load three.js (vendored, same-origin). Resolves the module + OrbitControls once. */
async function ensureThree() {
  if (THREE) return;
  if (!loading) {
    loading = (async () => {
      THREE = await import('/vendor/three/three.module.js');
      const oc = await import('/vendor/three/controls/OrbitControls.js');
      OrbitControls = oc.OrbitControls;
    })();
  }
  await loading;
}

/** Build the scene once, sized to the given host element. */
function buildScene(host) {
  container = host;
  const w = host.clientWidth || 800, h = host.clientHeight || 480;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 2000);
  camera.position.set(0, 0, 120);
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  host.appendChild(renderer.domElement);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  const key = new THREE.DirectionalLight(0xffffff, 0.9); key.position.set(60, 80, 100); scene.add(key);
}

/** Rebuild the node/edge geometry from the latest sessions. Cheap enough to redo on each update. */
function rebuildGraph(sessions) {
  if (!scene) return;
  // Deterministic layout seed from the session id so nodes don't jump between refreshes (no RNG —
  // a stable hash → sphere position; the physics tick then relaxes them into a readable cloud).
  const routable = (sessions || []).filter((s) => s.sessionId && s.sessionId !== 'local-operator');
  const prev = new Map(nodes.map((n) => [n.id, n]));
  nodes = routable.map((s, i) => {
    const keep = prev.get(s.sessionId);
    const a = hash01(s.sessionId), b = hash01(s.sessionId + '#'), c = hash01(s.sessionId + '@');
    return keep ? { ...keep, name: s.name || s.alias || s.sessionId.slice(0, 8), state: s.label, color: colorForSession(s) } : {
      id: s.sessionId, name: s.name || s.alias || s.sessionId.slice(0, 8), state: s.label, color: colorForSession(s),
      x: (a - 0.5) * 80, y: (b - 0.5) * 80, z: (c - 0.5) * 80, vx: 0, vy: 0, vz: 0, i,
    };
  });
  // Edges: connect each session to the operator "hub" at origin (a simple, honest topology — the
  // bus is a hub; richer thread edges can be layered later). Also link sessions sharing a project.
  edges = [];
  const byProject = new Map();
  nodes.forEach((n, idx) => {
    const proj = (routable[idx] && routable[idx].project) || '';
    if (proj) { if (!byProject.has(proj)) byProject.set(proj, []); byProject.get(proj).push(idx); }
  });
  for (const group of byProject.values()) {
    for (let k = 1; k < group.length; k++) edges.push({ a: group[0], b: group[k] });
  }

  disposeGraphMeshes();
  if (nodes.length === 0) return;

  // Nodes: one InstancedMesh of small spheres, per-instance position + color.
  const geo = new THREE.SphereGeometry(2.2, 20, 20);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.1, emissiveIntensity: 0.6 });
  nodeMesh = new THREE.InstancedMesh(geo, mat, nodes.length);
  const m = new THREE.Matrix4(), col = new THREE.Color();
  nodes.forEach((n, i) => { m.setPosition(n.x, n.y, n.z); nodeMesh.setMatrixAt(i, m); nodeMesh.setColorAt(i, col.setHex(n.color)); });
  nodeMesh.instanceMatrix.needsUpdate = true;
  if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
  scene.add(nodeMesh);

  // Edges: LineSegments (2 endpoints per edge) rebuilt each physics tick (positions change).
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.28 });
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(edges.length * 6), 3));
  edgeLines = new THREE.LineSegments(edgeGeo, edgeMat);
  scene.add(edgeLines);
}

/** Render exactly one frame (used by the reduced-motion static path + on-orbit re-render). */
function renderStaticFrame() {
  if (!renderer || disposed) return;
  controls.update();
  renderer.render(scene, camera);
}

/** One physics step (force-directed relaxation) applied to node positions + edge geometry. */
function relaxOnce() {
  const N = nodes.length;
  if (N === 0) return;
  for (let i = 0; i < N; i++) {
    const a = nodes[i];
    const r = Math.hypot(a.x, a.y, a.z) || 1; const target = 55;
    const pull = (target - r) * 0.002;
    a.vx += (a.x / r) * pull; a.vy += (a.y / r) * pull; a.vz += (a.z / r) * pull;
    for (let j = i + 1; j < N; j++) {
      const b = nodes[j]; let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      let d2 = dx * dx + dy * dy + dz * dz; if (d2 < 1) d2 = 1;
      const f = 12 / d2; const inv = 1 / Math.sqrt(d2);
      dx *= inv; dy *= inv; dz *= inv;
      a.vx += dx * f; a.vy += dy * f; a.vz += dz * f;
      b.vx -= dx * f; b.vy -= dy * f; b.vz -= dz * f;
    }
  }
  const m = new THREE.Matrix4();
  for (let i = 0; i < N; i++) {
    const n = nodes[i]; n.vx *= 0.86; n.vy *= 0.86; n.vz *= 0.86;
    n.x += n.vx; n.y += n.vy; n.z += n.vz;
    m.setPosition(n.x, n.y, n.z); nodeMesh.setMatrixAt(i, m);
  }
  nodeMesh.instanceMatrix.needsUpdate = true;
  if (edgeLines && edges.length) {
    const pos = edgeLines.geometry.getAttribute('position');
    edges.forEach((e, k) => {
      const a = nodes[e.a], b = nodes[e.b]; if (!a || !b) return;
      pos.setXYZ(k * 2, a.x, a.y, a.z); pos.setXYZ(k * 2 + 1, b.x, b.y, b.z);
    });
    pos.needsUpdate = true;
  }
}

/** One physics + render tick: light force-directed relaxation (repel all, spring edges to hub). */
function tick() {
  if (!running || disposed) return;
  relaxOnce();
  controls.update();
  renderer.render(scene, camera);
}

function disposeGraphMeshes() {
  for (const obj of [nodeMesh, edgeLines]) {
    if (!obj) continue;
    scene.remove(obj);
    obj.geometry && obj.geometry.dispose();
    obj.material && obj.material.dispose();
  }
  nodeMesh = null; edgeLines = null;
}

// FNV-1a → [0,1), deterministic (no Math.random — stable layout across refreshes).
function hash01(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return ((h >>> 0) % 100000) / 100000;
}

let pendingSessions = null;
function onResize() {
  if (!renderer || !container) return;
  const w = container.clientWidth || 800, h = container.clientHeight || 480;
  camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h);
}

export const Constellation = {
  /** Activate the tab: lazy-load three, build the scene, start the loop. Idempotent.
   *  Accessibility: if the user prefers reduced motion, we do NOT run the continuous
   *  physics/animation loop — we render a single static frame (still fully orbit-able on demand),
   *  honoring prefers-reduced-motion exactly like the CSS animations do. */
  async activate(host) {
    disposed = false;
    await ensureThree();
    if (disposed) return; // deactivated while three was loading
    if (!renderer) { buildScene(host); window.addEventListener('resize', onResize); }
    if (pendingSessions) { rebuildGraph(pendingSessions); pendingSessions = null; }
    running = true;
    const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      // Relax the layout a few steps synchronously (so it's readable), then render ONE static frame.
      for (let i = 0; i < 60 && nodes.length; i++) { relaxOnce(); }
      renderStaticFrame();
      controls.addEventListener('change', renderStaticFrame); // re-render only on user orbit input
    } else {
      renderer.setAnimationLoop(tick);
    }
  },
  /** Latest live data (called by app.js on every /api/sessions refresh). */
  update(sessions) {
    if (renderer && running) rebuildGraph(sessions);
    else pendingSessions = sessions; // buffer until the tab is first activated
  },
  /** Deactivate: stop the loop (never animate off-screen). Scene kept for fast re-activate. */
  deactivate() {
    running = false;
    if (renderer) renderer.setAnimationLoop(null);
  },
  /** Full teardown (page unload). */
  dispose() {
    disposed = true; running = false;
    if (renderer) { renderer.setAnimationLoop(null); disposeGraphMeshes(); renderer.dispose(); renderer.domElement.remove(); }
    window.removeEventListener('resize', onResize);
    renderer = scene = camera = controls = container = null;
  },
};
