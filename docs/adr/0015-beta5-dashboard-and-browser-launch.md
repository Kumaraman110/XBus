# ADR 0015 — Beta.5: localhost dashboard + browser launch (no tab storm)

**Status:** Proposed · **Date:** 2026-07-12 · beta.5. Companion to ADR 0013; security
in ADR 0018.

## Context

Beta.5 needs a localhost dashboard showing all session states and message state, and
every startup/resume/fork must "open/focus the default browser dashboard" while
"preventing multiple brokers and tab storms." Today there is no HTTP server; the only
listener is the UDS/named-pipe IPC.

## Decision

1. **The broker owns the dashboard HTTP server** (not the per-session hook). The broker
   is already the machine singleton (one per data dir, `host.ts`/`singleton.ts`). It
   starts ONE HTTP server bound to **`127.0.0.1`** (never `0.0.0.0`) on a broker-chosen
   port, recorded in `broker.state.json` (`dashboardUrl`, `dashboardPort`). Single
   broker ⇒ single dashboard server by construction (prevents "multiple brokers/UIs").

2. **Transport split**: the browser talks HTTP/JSON + a **`fetch()`-streaming** read-only
   live-update channel (`GET /api/stream`, newline-delimited JSON) — **not
   `EventSource`**, which cannot carry the `Authorization` header the auth flow requires
   (ADR 0018 D2). The dashboard's DB reads run **off the broker event loop** (a
   `worker_thread`/child process with a `SQLITE_OPEN_READONLY` handle — ADR 0020 Q5 #2),
   so a large read cannot stall delivery. The broker remains the **single writer** (I4);
   in Phase 1 there are **no product-state mutation routes** at all (rename/operator-send
   are Phase 2/3), so the dashboard issues no broker mutations yet.

3. **Browser open is broker-side and debounced (no tab storm).** SessionStart asks the
   broker to "ensure dashboard". The broker:
   - starts the HTTP server once (idempotent);
   - opens the OS default browser to the dashboard URL **only if** (a) the dashboard
     has never been opened this broker lifetime, OR (b) `now - lastOpenedAt >
     OPEN_DEBOUNCE` (e.g. 60s) AND no reachable dashboard tab heartbeat is seen.
   - A lightweight **tab heartbeat** (the open dashboard pings `/alive` every N s)
     lets the broker know a tab is already open and suppress new opens. Four sessions
     starting within seconds ⇒ at most one browser open.
   Browser launch is best-effort: failure to open a browser NEVER blocks the session or
   the broker (I5) — the URL is also printed to the hook stderr and `xbus doctor`.

4. **Windows default-browser launch** uses the documented `cmd /c start "" <url>` (or
   `ShellExecute` via a tiny helper) — no bundled browser, no assumption of a specific
   browser. macOS/Linux equivalents (`open`, `xdg-open`) are stubbed but Windows-first.

5. **A `dashboard`/`ui` CLI verb** (`xbus dashboard [--no-open]`) prints/opens the URL on
   demand, for the case where auto-open was suppressed or the user closed the tab.

## Dashboard content (read-model, Phase 1)

Per session: name + connection/readiness; last message sent; last message received +
sender + delivery state (queued / delivered / acknowledged / replied / failed /
expired / dead-lettered). Plus dormant + unmanaged sessions (ADR 0013 D5/D6). Timeline
+ filters + detail come from the ledger (ADR 0016). Rename control + (Phase 2) compose.

## Impact

- New dependency risk: to honor XBus's "pure-JS, uuid+zod only" bar (package-win
  FORBIDDEN_RUNTIME), the dashboard server uses **`node:http`** + a hand-rolled tiny
  router and static-file serve — **no express/fastify**. **Locked decision:** the UI is
  **hand-written vanilla HTML/CSS/JS** (no framework, no runtime bundler, no build step)
  checked in and served from the plugin dir — for Phase 1's read-only surface this keeps
  the artifact fully toolchain-free (ADR 0011 / package-win). A framework/bundle is
  explicitly **out** for Phase 1 (revisit only if a later phase's interactivity needs it).
- New `broker.state.json` fields (`dashboardPort`, `dashboardUrl`, `dashboardOpenedAt`);
  loopback bind + auth token in ADR 0018.
- Uninstall stops the HTTP server with the broker (ADR 0018).
