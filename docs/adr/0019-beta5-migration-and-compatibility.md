# ADR 0019 — Beta.5: schema migration + compatibility

**Status:** Proposed · **Date:** 2026-07-12 · beta.5. Companion to ADR 0013/0016/0017.
Governed by the version-handshake + build-identity model (ADR 0004 / ADR 0011).

## Context

Beta.5 adds tables/columns (lifecycle states, dormant/unmanaged, title-sync,
`ledger_events`, `threads` + thread columns). Beta.4/beta.4.1 shipped
`compatibilityId = xbus-p1-stp1-s6`, schema 6. We must add schema safely, keep the
XBUS-STP wire frozen, and **fail closed** on any version mismatch.

**Correction (2026-07-12, review-directed): there is NO mixed-version interop.** The
current handshake requires an **equal schema version** — `checkCompatibility` in
`src/protocol/handshake.ts:99-120` returns `upgrade_component` (`ok:false`) when
`client.schemaVersion < broker.schemaVersion` and `restart_broker`/`upgrade_broker`
otherwise; only **equal** schema + overlapping protocol yields `compatible`. So a
beta.4.1 (s6) component **cannot register or exchange messages** with a beta.5 (s7)
broker — it is rejected at the handshake, before registration. An earlier draft of this
ADR wrongly claimed s6↔s7 request/ACK/reply interop and capability-gated degradation;
**those claims are removed.** Phase 1 does **not** redesign the compatibility protocol —
it keeps the existing equal-schema fail-closed rule and treats the s6→s7 move as a
**whole-install upgrade**, not a mixed-version coexistence.

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

3. **Downgrade guard (fail closed) — TWO layers.** (a) At **DB open**, old code refuses a
   DB whose schema is newer than the build (`migrations.ts` max-version guard): a
   beta.4.1 (s6) binary meeting a v7 DB exits with an actionable message rather than
   corrupting data. (b) At the **handshake**, `checkCompatibility` rejects a schema
   mismatch in EITHER direction with a typed verdict (`upgrade_component` /
   `restart_broker`) — a component never registers against a broker of a different
   schema. The dashboard likewise refuses to serve a newer-than-build schema (ADR 0018 §6).

4. **No mixed-version operation — beta.5 upgrade is ONE controlled user-level operation.**
   There is no s6-component-with-s7-broker mode. Because the handshake fails closed on a
   schema mismatch (D3b), the only supported transition is a **whole-install upgrade**,
   performed as a single atomic-as-possible sequence by `xbus install` (user scope):

   1. **Stop the old broker** (graceful `xbus stop`; the running s6 broker must exit so
      the s7 broker can bind the singleton — ADR 0013's "stop before upgrade").
   2. **Back up** the data root (DB + WAL) and the user-scope config (`~/.claude.json`,
      `~/.claude/settings.json`) — the existing install backup-before-migrate discipline,
      extended to cover the DB (so a failed migration can be fully restored).
   3. **Install** the beta.5 plugin + hooks + broker binary (ownership-tagged, user scope).
   4. **Migrate 6→7** inside the transactional migration runner (D2), on the backed-up DB.
   5. **Restart** the (now s7) broker; sessions re-register at their next SessionStart /
      first tool call and handshake as s7↔s7.

   **Older components fail closed with `upgrade_component`** until they are themselves the
   upgraded s7 build — there is no partial/mixed fleet. If any step fails, the backup
   (step 2) restores the prior s6 state (see ADR 0016 install/migration rollback + the
   migration-rollback tests). This is deliberately NOT a protocol redesign: it reuses the
   existing equal-schema handshake and the existing migration/backup machinery.

5. **Product version = `0.1.0-beta.5`.** Bumped across the authoritative surfaces
   (XBUS_VERSION, package.json, plugin.json, package-lock, version-consistency test,
   live-build test assertions, docs/templates) exactly as the beta.4→beta.5 reconcile
   did. The build-time consistency gate (`write-provenance.ts assertVersionConsistency`)
   enforces agreement. Artifact SHA changes (embedded version/commit) — expected.

6. **Never move beta.4/beta.4.1.** Beta.5 is a NEW tag `v0.1.0-beta.5` + a NEW prerelease.
   The `v0.1.0-beta.4` and `v0.1.0-beta.4.1` tags/releases and their assets are never
   retagged, moved, or overwritten.

## Compatibility matrix (summary) — fail-closed, no mixed operation

| Component schema | Broker schema | `checkCompatibility` verdict | Result |
| --- | --- | --- | --- |
| s6 (beta.4.1) | s7 (beta.5) | **`upgrade_component` (ok:false)** | component **rejected at handshake**; must upgrade to beta.5 |
| s7 (beta.5) | s6 (beta.4.1 still running) | **`restart_broker` (ok:false)** | stop+restart so the s7 broker runs migrations |
| s7 | s7 | `compatible` | normal operation |
| any | DB newer than build (on open) | fail closed | `migrations.ts` refuses to open; exit with guidance |

There is **no row where different schema versions exchange messages**. The transition
from an all-s6 install to an all-s7 install is the controlled upgrade (Decision 4), not a
coexistence.

## Impact

- One schema increment (6→7), forward-only, backup-before-migrate, downgrade-guarded at
  BOTH DB-open and handshake.
- Compatibility tuple `xbus-p1-stp1-s6 → xbus-p1-stp1-s7`; protocol/STP frozen; **no
  compatibility-protocol redesign in Phase 1.**
- Tests: 6→7 forward migration (additive, on a backed-up DB); handshake fail-closed both
  directions (`upgrade_component` for s6-client↔s7-broker, `restart_broker` for
  s7-client↔s6-broker) — table-driven against `checkCompatibility`; DB-open downgrade
  refusal; and the whole-install upgrade sequence (stop→backup→install→migrate→restart)
  with a **rollback test** proving a failed migration restores the s6 backup. Mirrors the
  existing `beta3-to-beta4-upgrade` + build-identity interop tests, minus any mixed-version
  message-exchange case (which the handshake forbids).
