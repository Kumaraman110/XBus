# ADR 0023 — Beta.7: professional dashboard redesign (separate delivery columns, internal filter)

**Status:** Accepted for Phase-3 build · **Date:** 2026-07-14 · beta.7 · builds on
ADR 0015/0018/0020 (dashboard + security + read-model) and ADR 0021 (operator console).

## Design skill used (honest record — corrected)

The goal directs: *"invoke the official Anthropic frontend-design skill available in Claude
Code and record its name/source in PR evidence. If unavailable, use the closest official
Anthropic UI/design skill and state that honestly; never invent usage."*

**Correction (honesty).** The first version of this ADR claimed `frontend-design` was "NOT
installed." **That was wrong** — I checked only one skill cache (`bundled-skills/…`) and
concluded absence without searching the plugin marketplaces. The official Anthropic
**`frontend-design`** skill **IS installed** at
`~/.claude/plugins/marketplaces/claude-plugins-official/plugins/frontend-design/skills/frontend-design/SKILL.md`
(plugin author: Anthropic). The user caught this; the record is corrected here rather than
left standing.

- **`frontend-design` (official, Anthropic) was invoked** for the final visual redesign — its
  guidance drove committing to a bold, distinctive aesthetic direction, distinctive type
  treatment, atmosphere/depth, and motion, while avoiding generic AI aesthetics. The chosen
  direction and its rationale are recorded below.
- **`dataviz` (bundled skill) was ALSO used**, specifically for the delivery-state color system:
  its palette **validator was run** (`scripts/validate_palette.js`) against the real dark panel
  surface (not eyeballed) to prove the five delivery-state hues are ≥3:1 contrast and
  CVD-separated. The two skills are complementary — `frontend-design` for the aesthetic
  point-of-view, `dataviz` for the validated status palette.
- The redesign preserves the strict CSP by construction (external `/style.css` + `/app.js`
  only; no inline styles, no remote fonts/images/CDN — `default-src 'none'`), so the sci-fi
  look is built entirely from CSS (gradients, `perspective`/`transform` 3D depth, keyframes,
  `clip-path`) over a system-font stack treated for a distinctive identity, never a shipped
  binary font.

## Decision

1. **Delivery renders as FIVE separate columns — `Queued | Delivered | ACK | Replied | Failed`**
   — never the old combined `q/d/ack/reply/fail` string. Each is a colored **state pill**: the
   number carries the value, the pill hue + the column header carry the state. Per the dataviz
   status-palette rule, a status color never carries meaning alone — the column label is the
   secondary channel.

2. **The delivery-state palette is validated, not chosen by taste.** Colors (on the dark panel
   surface `#171d2b`): queued `#fab219` (amber), delivered `#5b9dff` (blue), ack `#35c07f`
   (teal), replied `#0ca30c` (green), failed `#d03b3b` (red). The validator + a WCAG check
   confirm **all five clear ≥ 3:1 contrast** (9.18 / 6.18 / 7.22 / 5.02 / 3.50) and are
   **CVD-separated** (worst adjacent ΔE 12.4, above the 12 target). The categorical
   "lightness band" check FAILs by design — these are *status* colors at deliberately different
   lightnesses, exempt from the categorical band, mitigated by the always-present label.

3. **Internal sessions are hidden by default behind an "Internal sessions" filter.** The
   read-model emits a derived `internal` boolean (additive, **no migration** — computed by
   `isInternalSession` from the id/slug shape: `local-operator`, `cli-*`, `installer-*`,
   `proj-cli`/`proj-install`/`proj-operator`). The client hides internal rows by default,
   shows a "N internal session(s) hidden" note, and re-renders on toggle (preference persisted
   in `sessionStorage`). A client heuristic is the fallback for older brokers.

4. **Friendly statuses + drill-down.** The Status column shows human copy (`Ready`,
   `Waiting for recipient checkpoint`, `Disconnected — queuing`, `Dormant`, `Unmanaged`,
   `Expired`); the raw label, session id, connection/readiness, and last-sent/received live in
   a keyboard-operable **Details** disclosure, so IDs/technical detail are available without
   cluttering the row.

5. **Hierarchy, responsive, keyboard-accessible, states.** Semantic section landmarks +
   heading hierarchy; a horizontal `table-scroll` wrapper so the 9-column table never overflows
   a narrow viewport (the console grid already stacks under 820px); `focus-visible` outlines on
   every control; thread rows are `role="button"` + `tabindex=0` + Enter/Space; explicit
   loading / empty / error states (a visible `error-banner` on a failed refresh, not a silent
   swallow).

6. **The strict-CSP inert-asset contract is unchanged.** All CSS/JS stay in external
   `/style.css` + `/app.js` (no inline styles/`<style>`/`on*` handlers, no CDN/remote fonts,
   self-hosted only); no `localStorage`/`document.cookie`/`EventSource`; no baked session
   ids/secrets; the browser never sets a sender/actor (identity stays broker-stamped, ADR 0021).
   The existing `dashboard-ui` + `dashboard-server` inert-asset/CSP tests still pass, extended
   with beta.7 assertions (five columns, no combined string, internal filter, friendly status).

## Consequences

- Positive: an at-a-glance, accessible, professional console; delivery state is legible per
  bucket with validated color + labels; internal noise is hidden by default but one toggle away.
- Negative / accepted: the sessions table widened 7→9 columns (mitigated by the scroll
  wrapper); `internal` is a derived heuristic (robust for the known internal shapes; a future
  explicit column could make it authoritative).
- The redesign is client + read-model only — no schema/wire change, no new broker command.
