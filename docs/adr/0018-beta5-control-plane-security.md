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

2. **Local auth token + CSRF.** On first start the broker mints a random
   **dashboard token** (32 bytes, CSPRNG), stored in the ACL-restricted data dir
   alongside the root secret (same Windows owner-only ACL as `auth/`, ADR 0010). The
   dashboard URL opened in the browser carries a one-time handoff; the SPA then holds
   the token and sends it as a header on every request. **All mutating endpoints
   require the token** (loopback alone is not trusted — other local processes/users
   share loopback). CSRF: mutations require the token in a custom header (not a cookie),
   so a browser cross-site form/GET cannot forge them; `SameSite`/no-cookie-auth.

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
