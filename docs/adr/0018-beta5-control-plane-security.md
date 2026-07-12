# ADR 0018 — Beta.5: control-plane security (loopback dashboard, auth, uninstall)

**Status:** Proposed · **Date:** 2026-07-12 · beta.5. Companion to ADR 0013/0015/0016.
Extends the Windows-pipe-security model (ADR 0010) to the new HTTP surface.

## Context

Beta.5 adds an HTTP dashboard — a new attack surface on a machine that previously only
had an ACL'd named pipe. Requirements: loopback only; local auth/CSRF token; strict
CSP; input validation; secret redaction; Windows ACLs for DB/keys; fail closed on
incompatible schema/build; uninstall stops broker/UI and removes only owned config,
preserving the audit DB unless explicit purge.

## Decision

1. **Bind loopback only.** The dashboard HTTP server binds **`127.0.0.1`** exclusively
   (never `0.0.0.0`/`::`); a startup assertion refuses any non-loopback bind. No remote
   access, no LAN exposure.

2. **Browser auth bootstrap — complete flow (nonce → exchange → tab token).** The
   problem: the broker must hand a freshly-opened browser tab an authenticator without
   (a) putting a durable secret in the URL (URLs leak via history, `Referer`, shoulder-
   surfing, server logs), (b) trusting loopback (shared across local OS users), or (c)
   using cookies (ambient-authority/CSRF surface). The flow, end to end:

   - **Server secrets.** On first start the broker mints, in the ACL-restricted data dir
     (owner-only, same regime as `auth/`, ADR 0010): a long-lived **root dashboard key**
     (never sent to the browser) and, per browser-open, a short-lived **one-time nonce**.
   - **Static assets load unauthenticated.** The HTML/CSS/JS bundle contains **no secret
     and no session data** — it's inert app code. Serving it without a token is safe and
     lets the page boot to run the exchange. (Only *data/API* endpoints are gated.)
   - **Nonce travels ONLY in the URL fragment.** The broker opens
     `http://127.0.0.1:<port>/#n=<nonce>`. The **fragment (`#…`) is never sent to the
     server, never in `Referer`, never in server logs** — it exists only in the tab's
     `location.hash`. The nonce is **CSPRNG, single-use, short TTL** (e.g. 60 s), stored
     server-side as `{nonce_hash, expires_at, consumed_at}`.
   - **JS strips the fragment, then exchanges it.** On load the app reads
     `location.hash`, immediately `history.replaceState`s the hash away (so a reload/
     bookmark/back cannot replay it and it won't sit in the address bar), and calls
     **`POST /auth/exchange` with `{nonce}` in the body** (not the URL). `/auth/exchange`
     is the **one write endpoint** and therefore **executes on the broker/writer side**
     (the nonce/token store is broker-owned) — NOT in the read-only off-loop worker that
     serves `/api/*` (ADR 0020 Q5 #2). It **atomically consumes** the nonce (single
     `UPDATE … SET consumed_at=? WHERE nonce_hash=? AND consumed_at IS NULL AND
     expires_at>now` — the affected-row count is the CAS; a second attempt affects 0 rows →
     rejected), verifies TTL, and returns a **short-lived tab token** (CSPRNG, e.g. 30-min
     TTL, bound to `127.0.0.1`), plus its expiry. It mutates only the ephemeral nonce/token
     store — **no product state** — so "no product-state mutation routes" (ADR 0020 Q5 #1)
     holds.
   - **Tab token lives in memory / `sessionStorage` only** — never `localStorage`
     (survives tab close, broader XSS exposure), never a cookie (no ambient CSRF).
   - **Every data/API request carries `Authorization: Bearer <tab-token>`** (a custom
     header, so a cross-site form/GET cannot forge it — CSRF-safe by construction). Every
     `/api/*` and the live-update stream (D2.stream below) requires a valid tab token →
     else `401`. This is the "token on every data request incl. reads" rule from ADR 0020
     Q5 (loopback ≠ trust; the read dashboard exposes session metadata + the ledger).
   - **Live updates use fetch-streaming, NOT EventSource.** `EventSource` cannot send an
     `Authorization` header (browser API limitation), which would force an
     unauthenticated or query-string-token stream — both rejected. Instead the app opens a
     **`fetch()` streaming response** (`GET /api/stream` with the `Authorization` header,
     a `ReadableStream` of newline-delimited JSON events) and reads it incrementally. This
     keeps the token in a header and off the URL.

   **Lifecycle / abuse behavior (all specified + tested):**
   - **Reload / back / bookmark:** the fragment was stripped, so no nonce remains; the
     in-memory tab token is gone after a full reload → the app has no nonce to exchange →
     it shows a "re-open from XBus" prompt and calls `xbus dashboard` (which mints a fresh
     nonce + opens a tab). `sessionStorage` survives a *soft* reload within the same tab,
     so a soft reload keeps working until the tab token expires.
   - **Token expiry:** a `401` from any data request puts the app into a "session expired
     — reopen" state; no silent refresh (Phase 1 keeps it simple + auditable).
   - **Nonce replay:** the atomic consume makes a second exchange of the same nonce fail
     (0 rows) → `401`; an expired nonce → `401`. Both are ledgered as
     `DASHBOARD_AUTH_REJECTED`.
   - **Browser reopen / multiple tabs:** each `xbus dashboard` open mints a **new** nonce
     → a **new independent tab token**; tokens are per-tab, not shared. Opening a second
     tab does not invalidate the first (independent tokens). The single-instance rule
     (ADR 0015) is about the *server*, not the number of tabs.
   - **Token never logged:** neither nonce nor tab token appears in `ledger_events`,
     stderr, or the URL bar after strip (verified by a redaction test).

3. **Strict CSP + no-inline.** Responses set `Content-Security-Policy: default-src
   'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self';
   frame-ancestors 'none'; base-uri 'none'`, plus `X-Content-Type-Options: nosniff`,
   `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. No inline scripts/styles
   (assets served from `'self'`). No third-party origins.

4. **Input validation + redaction.** Every dashboard request body is validated with the
   existing zod-based schema discipline (`schemas.ts`), rejecting unknown/oversized/
   wrong-typed input with a clean typed error (never a raw DB/500 leak — the beta.5
   lesson). Responses reuse the §5.1 body-free/redaction path; the ledger never carries
   secrets or bodies (ADR 0016 §5). Path traversal on static-asset serving is blocked
   (canonicalize + prefix-check under the plugin asset dir).

5. **Windows ACLs.** The DB, WAL, root secret, and dashboard token are owner-only
   (reuse the existing `hardenDir`/icacls path from install, ADR 0010). Fail closed if
   ACLs can't be applied.

6. **Fail closed on incompatible schema/build.** The dashboard server refuses to serve
   if the on-disk schema is newer than the build (existing downgrade guard) or the
   broker build is incompatible; it returns an actionable error page, not partial data.

7. **Uninstall.** `xbus uninstall` stops the broker AND the dashboard HTTP server
   (broker owns both), then removes only ownership-tagged config (existing
   `user-scope-config.ts` `_xbusOwner` scoping — untagged entries preserved, per the
   beta.4 finding + docs). The **audit DB is preserved** (ADR 0016) unless
   `--purge`/`--remove-data` is given (which is logged as a final ledger event before
   deletion). Stop-before-uninstall guidance (beta.5 docs) applies to the dashboard too.

## Threat model notes

- **Same-machine other-user**: loopback is shared across local users, so the token
  (owner-only ACL) is the real boundary — a different OS user can't read the token.
- **Same-user other-process**: any process running as the user can read the token file
  (by design, same as the root secret) — the control plane is same-user-trust, matching
  XBus's existing model (ADR 0010). Documented, not a regression.
- **Browser-origin CSRF/XSS**: mitigated by header-token (not cookie) + strict CSP +
  no inline + loopback-only + nosniff.

## Impact

- New secret (dashboard token) under the existing ACL regime; new HTTP headers/CSP.
- No protocol/STP change; the pipe path is unchanged. Adds an HTTP listener that
  uninstall/stop must tear down (covered by tests).
