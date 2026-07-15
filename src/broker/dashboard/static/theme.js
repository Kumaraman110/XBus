/* XBus dashboard theme switch — light/dark, CSP-safe (script-src 'self', no inline).
 *
 * Loaded in <head> BEFORE style.css so the saved choice is applied before first
 * paint (no flash). Contains NO data and NO secrets — an inert static asset.
 *
 * Precedence: an explicit operator choice in localStorage ('xbus.theme' = 'light'|
 * 'dark') wins; otherwise the CSS follows the OS via prefers-color-scheme (we leave
 * data-theme UNSET so the @media fallback in style.css governs). The toggle flips
 * to an explicit choice and persists it.
 */
'use strict';
(function () {
  var KEY = 'xbus.theme';
  var root = document.documentElement;

  function saved() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function osPrefersLight() {
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
  }
  /** The theme actually showing right now (explicit attr, else OS). */
  function effective() {
    var attr = root.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') return attr;
    return osPrefersLight() ? 'light' : 'dark';
  }
  /** Apply an explicit theme, or clear to follow the OS when `t` is null. */
  function apply(t) {
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
    else root.removeAttribute('data-theme');
  }

  // 1) First paint: honour a saved explicit choice; else leave unset (OS governs).
  var s = saved();
  if (s === 'light' || s === 'dark') apply(s);

  // 2) Wire the toggle once the button exists.
  function wire() {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var next = effective() === 'light' ? 'dark' : 'light';
      apply(next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* private mode: session-only */ }
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  // 3) If the operator hasn't chosen explicitly, track live OS changes.
  if (!(s === 'light' || s === 'dark') && typeof matchMedia === 'function') {
    try {
      matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () {
        if (!saved()) apply(null); // still following the OS
      });
    } catch (e) { /* Safari <14 has no addEventListener on MQL — safe to skip */ }
  }
})();
