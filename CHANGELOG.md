# Changelog

All notable changes to XBus are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is in
pre-1.0 Developer Preview, so the public surface may still change.

## [0.1.0-beta.2] — first public developer preview

The first public artifact. Same product behavior as the internally-hardened build
it was cut from — no protocol, schema, crypto, database, installer, broker, or
migration change. This release completes the public sanitization (independent
**XBus** branding, synthetic test fixtures, public-only provenance) and prepares
the public distribution.

### Identity / packaging
- Product version `0.1.0-beta.2`; build identity `xbus-0.1.0-beta.2-<commit>`
  (exact, deterministic) separate from the stable wire **compatibility id**
  `xbus-p1-stp1-s5` (application protocol 1 · XBUS-STP 1 · schema 5).
- **Wire-compatible** with the prior internal builds: no protocol or crypto
  change; XBUS-STP v1 test vectors are unchanged.
- Reproducible Windows artifact: per-file `SHA256SUMS`, a single manifest checksum,
  a CycloneDX SBOM, pinned pure-JS dependencies, and a normative artifact contract —
  no build toolchain required at install time.

### Included
- Durable broker, MCP tools, checkpoint hook, `xbus` CLI + `xclaude` launcher.
- Reversible user-scope install/uninstall with backup + rollback, a single canonical
  data root, and a transactional data-root migration on upgrade.
- Body-free observability surface (`xbus metrics` / `doctor --json`).

### Known limitations
Public Developer Preview · Windows-first (macOS/Linux implemented, not yet
runtime-validated) · same-machine, same-user only · Bedrock = deferred checkpoint
delivery (no idle wake) · at-most-once context presentation (no exactly-once
execution) · cross-user Windows unvalidated · XBUS-STP internally reviewed, **not
independently audited**.

## [Unreleased]

### Added
- **Model-visible duplicate prevention (§1).** `xbus_inbox` classifies each
  pending entry (`queued_not_injected` / `context_injected_unacknowledged` /
  `application_accepted` / `application_completed`) and includes the request body
  exactly once; a recovery pull returns metadata with `bodyIncluded:false`.
  Explicit `xbus_redeliver` is the only (audited, warned) way to re-show a body.
- **Explicit session readiness (§2).** Readiness (`initializing`,
  `ready_checkpoint`, `ready_live`, `degraded_*`, `incompatible`, `disconnected`)
  is tracked and reported separately from connection state and receive mode; a
  session is not injected a request it cannot yet acknowledge.
- **Reliability reaper (§4).** Periodic + on-demand sweep reclaims ack-timeouts
  (→ retry/dead-letter), acceptance-TTL expiries, and abandoned leases, with a
  per-session fairness cap.
- **Secure resource-pressure hardening (§3).** Handshake-completion timeout
  (slow-loris bound) plus a pressure test suite over XBUS-STP.
- **Performance benchmark (§5)** over the encrypted transport + a regression guard.
- **Isolated Windows packaging (§7).** Self-contained staging, checksums, SBOM,
  pinned runtime, and a content scanner — no build toolchain needed after install.
- **Public documentation layer (§9).** README, architecture, delivery semantics,
  security, privacy, providers, troubleshooting, compatibility, roadmap, and the
  standard community files.

### Security
- XBUS-STP custom secure transport integrated into every broker/client path
  (mutual auth, per-frame AES-256-GCM, replay/reorder rejection); internally
  reviewed, not independently audited.
- Migration downgrade guard: old code refuses a DB with a newer schema version.

### Notes
- Delivery is **at-most-once effective context injection**, **not** exactly-once
  execution. See [docs/delivery-semantics.md](docs/delivery-semantics.md).
- Windows-first; macOS/Linux implemented but not yet runtime-validated.
- On Bedrock, delivery is checkpoint-based; idle-wake is unsupported.
