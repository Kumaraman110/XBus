# ADR 0019 — Beta.5: schema migration + compatibility

**Status:** Proposed · **Date:** 2026-07-12 · beta.5. Companion to ADR 0013/0016/0017.
Governed by the version-handshake + build-identity model (ADR 0004 / ADR 0011).

## Context

Beta.5 adds tables/columns (lifecycle states, dormant/unmanaged, title-sync,
`ledger_events`, `threads` + thread columns). Beta.4/beta.5 shipped
`compatibilityId = xbus-p1-stp1-s6`, schema 6. We must add schema safely, keep the
XBUS-STP wire frozen, keep beta.4/beta.4.1 request/ACK/reply interop, and fail closed on
downgrade.

## Decision

1. **Schema bump `6 → 7`, protocol + STP frozen at 1.** New migration step(s) in
   `migrations.ts` create the beta.5 tables/columns forward-only. `SCHEMA_VERSION`
   derives from the max migration version (existing `handshake.ts` computation), so
   `WIRE_COMPATIBILITY_ID` becomes **`xbus-p1-stp1-s7`** automatically. `PROTOCOL_VERSION`
   and `SECURE_TRANSPORT_VERSION` stay `1` — the wire bytes/key schedule/vectors
   (ADR 0010) are UNCHANGED. Only the schema component of the tuple moves, with cause,
   exactly as beta.4 moved s5→s6.

2. **Forward migration is additive.** New tables + `ALTER TABLE ADD COLUMN` with
   defaults; no destructive rewrite of `sessions`/`messages`/`aliases`. Existing rows
   get sensible defaults (e.g. `author_type='claude'`, `title_sync_state='none'`,
   `thread_id`/`thread_sequence` backfilled for existing messages by treating each as a
   degenerate thread, ADR 0017 §2). Runs inside the existing transactional migration
   runner; backup-before-migrate (existing install migration discipline) applies.

3. **Downgrade guard (fail closed).** The existing guard — old code refuses a DB whose
   schema is newer than the build (`migrations.ts`) — protects a beta.4/beta.4.1 binary
   that meets a v7 DB: it exits with an actionable message rather than corrupting data.
   The dashboard likewise refuses to serve a newer-than-build schema (ADR 0018 §6).

4. **Wire compatibility with beta.4/beta.4.1 peers.** Threads/lifecycle are additive
   optional frame fields + new capability-gated frames (ADR 0017 §2); existing
   register/send/ack/reply frames are byte-unchanged. A beta.4/beta.4.1 client talking to
   a beta.5 broker: registers and does request/ACK/reply exactly as before (its frames
   ignored-unknown-field tolerant); it simply doesn't use thread frames or the
   dashboard. A beta.5 client talking to an older broker: detects the missing thread
   capability and degrades to single-reply. The STP handshake key derivation is
   version-independent (ADR 0011), so mixed builds still handshake.

5. **Product version = `0.1.0-beta.5`.** Bumped across the authoritative surfaces
   (XBUS_VERSION, package.json, plugin.json, package-lock, version-consistency test,
   live-build test assertions, docs/templates) exactly as the beta.4→beta.5 reconcile
   did. The build-time consistency gate (`write-provenance.ts assertVersionConsistency`)
   enforces agreement. Artifact SHA changes (embedded version/commit) — expected.

6. **Never move beta.4/beta.4.1.** Beta.5 is a NEW tag `v0.1.0-beta.5` + a NEW prerelease.
   The `v0.1.0-beta.4` and `v0.1.0-beta.4.1` tags/releases and their assets are never
   retagged, moved, or overwritten.

## Compatibility matrix (summary)

| Client | Broker | Result |
| --- | --- | --- |
| beta.4/beta.4.1 | beta.5 | registers + request/ACK/reply OK; no threads/dashboard use |
| beta.5 | beta.4/beta.4.1 | degrades to single-reply (no thread capability) |
| beta.5 | beta.5 | full threads + dashboard + ledger |
| any | mismatched schema (newer on disk) | fail closed (downgrade guard) |

## Impact

- One schema increment (6→7), forward-only, backup-before-migrate, downgrade-guarded.
- Compatibility tuple `xbus-p1-stp1-s6 → xbus-p1-stp1-s7`; protocol/STP frozen.
- Migration + interop covered by tests (beta.5→beta.5 upgrade, mixed-build handshake,
  downgrade-refusal), mirroring the existing `beta3-to-beta4-upgrade` + build-identity
  interop tests.
