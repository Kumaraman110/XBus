/*
 * AgenTel dashboard — tab controller (BETA.11). Switches between the dense 2D operator Console
 * (default) and the three.js Constellation companion view, and feeds the latest live /api/sessions
 * payload (cached on window.__sessions by app.js) into the Constellation while it is visible.
 *
 * External module only (strict CSP: script-src 'self'; no inline JS). three.js itself is loaded
 * lazily by constellation.js on first activation — this controller has no WebGL cost until the
 * Constellation tab is opened.
 */
import { Constellation } from '/constellation.js';

const tabs = [
  { btn: 'tabbtn-console', panel: 'tab-console' },
  { btn: 'tabbtn-constellation', panel: 'tab-constellation' },
];

let feedTimer = null;

function feedConstellation() {
  // app.js caches the authenticated /api/sessions array here on every refresh.
  if (window.__sessions) Constellation.update(window.__sessions);
}

async function activateConstellation() {
  const host = document.getElementById('constellation-canvas');
  if (!host) return;
  try {
    await Constellation.activate(host);
    feedConstellation();
    // Keep the view in sync with the roster's live refresh (app.js updates window.__sessions).
    if (feedTimer) clearInterval(feedTimer);
    feedTimer = setInterval(feedConstellation, 2000);
  } catch (e) {
    // WebGL unavailable / three.js failed to load: honest fallback. Build via DOM (no innerHTML with
    // an inline style — the strict CSP forbids inline styles; the padding comes from a CSS class).
    host.textContent = '';
    const p = document.createElement('p');
    p.className = 'constellation-note constellation-fallback muted';
    p.textContent = '3D view unavailable in this browser (WebGL required). The Console tab has the full data.';
    host.appendChild(p);
  }
}

function deactivateConstellation() {
  if (feedTimer) { clearInterval(feedTimer); feedTimer = null; }
  Constellation.deactivate();
}

function select(target) {
  for (const t of tabs) {
    const btn = document.getElementById(t.btn);
    const panel = document.getElementById(t.panel);
    if (!btn || !panel) continue;
    const active = t.panel === target;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    panel.hidden = !active;
  }
  if (target === 'tab-constellation') void activateConstellation();
  else deactivateConstellation();
}

function init() {
  for (const t of tabs) {
    const btn = document.getElementById(t.btn);
    if (btn) btn.addEventListener('click', () => select(t.panel));
  }
  window.addEventListener('beforeunload', () => Constellation.dispose());
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
