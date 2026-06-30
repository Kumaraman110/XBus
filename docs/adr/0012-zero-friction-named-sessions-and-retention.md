# ADR 0012 — Beta.4: zero-friction launch, required named sessions, and 15-day activity retention

**Status:** Accepted · **Date:** 2026-06-30 · beta.4 architecture note.
Extends the session model of ADR 0003 (identity/receipt authority) and ADR 0008
(split-brain one-owner); introduces a **schema version bump** justified under
ADR 0004 / ADR 0011 (see §3). The XBUS-STP v1 wire bytes, key schedule, and
vectors (ADR 0010 / `docs/secure-transport-spec.md`) are **UNCHANGED** — only the
schema component of the compatibility tuple moves.

This is the grounding architecture note required before beta.4 implementation. It
is written against the **actual** code at `main` (`8f0ae8b`), with file:line
citations, and **closes** the open design decisions so implementation has a single
source of truth.

---

## Context — the beta.4 objective

After one user-level install, from any directory, plain `claude` (no `xclaude.js`,
no `xbus start`) must: load XBus as a user-scope MCP + hooks integration; discover
or race-safely start exactly one broker; auto-register the session; obtain a
human-readable, unique, stable name (or fall into an interactive `pending_name`
state); become discoverable; and deliver messages at checkpoints — while a failed
XBus path never blocks Claude from starting. Separately, a session that has had no
**meaningful activity** for 15 exact days must expire: drop from discovery, release
its name, reject new sends, dead-letter its pending deliveries, and never resurrect
old bodies on re-registration.

Five frozen invariants constrain every change below:

- **I1** `compatibilityId xbus-p1-stp1-s5` (see §3 — this ADR moves it, with cause).
- **I2** every returned checkpoint body carries a valid injection id; no normal path
  re-presents a body (Layer-3, `delivery.ts`).
- **I3** non-ACK messages never enter the ACK-timeout requeue/dead-letter path
  (`reaper.ts:97`/`:105`).
- **I4** broker-owned trusted evidence; adapters cannot self-promote (PR #4 model).
- **I5** epoch/fencing + receipt authority (ADR 0003) — name is never identity.

---

## Current ground truth (verified in code)

- **`sessions`** (`migrations.ts:34–60`): PK `session_id`; `automatic_alias TEXT NOT
  NULL` (machine alias, always present); `project_id`; `state TEXT NOT NULL` carrying
  only `'connected' | 'disconnected'`; `readiness` enum (`readiness.ts:16–31`:
  `initializing | ready_checkpoint | ready_live | degraded_ack_unavailable |
  degraded_hook_unavailable | incompatible | disconnected`); `last_seen_at`,
  `last_checkpoint_at`; and **an already-existing but UNUSED `expires_at TEXT`** (null
  in every row).
- **`aliases`** (`migrations.ts:79–92`): `alias`, `alias_ci`, `scope
  ('global'|'project')`, `active INTEGER`, partial unique indexes `ux_alias_global`
  (`WHERE scope='global' AND active=1`) and `ux_alias_project`. This is the proven
  case-insensitive active-uniqueness pattern.
- **Migrations** (`migrations.ts`): append-only `MIGRATIONS` array; `SCHEMA_VERSION =
  MIGRATIONS.reduce(max version)` (`handshake.ts:14`); current **max = 5**;
  `runMigrations()` runs at boot (`host.ts`). Checksums auto-computed.
- **`compatibilityId(schema)`** = `` `xbus-p${PROTOCOL_VERSION}-stp${SECURE_TRANSPORT_VERSION}-s${schema}` ``
  (`build-identity.ts:51–53`); `WIRE_COMPATIBILITY_ID = compatibilityId(SCHEMA_VERSION)`
  (`handshake.ts:28`) is bound into the STP transcript.
- **`reaper.sweep()`** (`reaper.ts:69–75`) wraps `reapAckTimeouts()` +
  `reapAcceptanceTtl()` + `reclaimLeases()` in **one** `db.transaction`. The non-ACK
  guard is the `JOIN messages … m.requires_ack=1` filter (`:97`) plus a per-UPDATE
  `ackGuard` subquery (`:105`). `failure_category` is a free-form string;
  `SweepResult` is the counts interface (`:24–33`).
- **`store.register()`** (`store.ts:121–203`) is one transaction inserting `sessions`
  + `component_instances` + epoch + alias rows; split-brain guard at `:164–176`;
  returns a `SessionAuthority` `{ sessionId, instanceId, componentInstanceId, role,
  epoch, generation, fencingToken, connectionId }`. `registerAlias()` at `:250`.
- **`ensureBroker` does not exist as a shared function.** Fragments: MCP server's
  private connect-only `ensureBroker` (`mcp-server.ts:127–151`); CLI `cmdStart`
  calling `startBrokerHost` directly (`main.ts:287–308`); hook silently degrading if
  the broker is unreachable (`checkpoint-hook.ts:64`). Primitives to compose:
  `defaultEndpoint` (`transport.ts:18`), `probeExisting` (`singleton.ts:29`),
  `checkSingleton` (`singleton.ts:44`, the OS-atomic IPC-bind arbiter),
  `startBrokerHost` (`host.ts:46`), `pidIsAlive` (`state-file.ts:69`).
- **User-scope Claude config is untouched today.** `install()` (`install.ts:135–284`)
  writes only the plugin dir + data root, with atomic staging, backup, rollback,
  health-check; the plugin ships `.mcp.json` + `hooks/hooks.json` consumed via
  `--plugin-dir` by the `xclaude` launcher, **not** registered into the user's Claude
  config. `InstallManifest` is at `install-paths.ts:26–41`.
- **`errors.ts`** has no `RECIPIENT_SESSION_EXPIRED`. `FakeClock` (`shared/clock.ts`)
  provides `nowMs`/`nowIso`/`advance` for exact boundary tests.

---

## Decision 1 — accept the compatibility-tuple bump to `xbus-p1-stp1-s6` (§3 below)

This is the one gating, irreversible decision and it is taken **explicitly** (the only
item escalated to the owner; all others below were decided within beta.4 autonomy).
See §3 for the full justification.

## Decision 2 — name lifecycle is a NEW column, orthogonal to connection state and readiness

Add **`session_name_state TEXT NOT NULL DEFAULT 'unnamed'`** with values
`'unnamed' | 'pending' | 'active' | 'retired'`. Rationale (verified): `state`
carries only `connected|disconnected`, and `readiness` gates injection — overloading
either would entangle naming with delivery eligibility. `paused`/`dnd` are **already**
modelled elsewhere (`session_controls.receiving` at `migrations.ts:255–269`, and the
`blocked_peers` table) and are **not** added as state values. **`expired` is a
timestamp predicate** (`expired_at IS NOT NULL`), not a `state` value. The adapter
SDK's 14-state `SessionLifecycle` (`lifecycle.ts:11–25`) is adapter-side and projects
down to wire `Readiness` via `toReadiness()`; it is **not** the broker's persisted
state and is not touched.

## Decision 3 — required names: global-within-broker, case-insensitive, via a partial unique index

- **Scope = global within the broker.** There is no `user_id`/workspace column today,
  and the broker is already per-OS-user-per-dataDir (endpoint
  `\\.\pipe\xbus-<user>-<hash(dataDir)>`, `transport.ts`). So "global within the
  broker" *is* "per user." We do **not** invent an unbacked `workspace_identity`
  column. (If multi-workspace is ever needed, it is a later additive migration.)
- **Uniqueness via a partial unique index**, mirroring `aliases` exactly:

  ```sql
  CREATE UNIQUE INDEX ux_session_name_active
    ON sessions(normalized_session_name)
    WHERE session_name_state='active' AND normalized_session_name IS NOT NULL;
  ```

  SQLite serializes this inside the existing `store.register()` transaction
  (`store.ts:121–203`), giving race-safety for free — the same mechanism that already
  protects `registerAlias`. **No separate registry table** (it would duplicate the
  alias model and add a second coordination point).
- **Validation is its own zod schema** (`validateSessionName` in `schemas.ts`), NOT
  the alias validator: alias is `^[A-Za-z0-9_-]{1,128}$`; session name is the stricter
  `^[a-z0-9][a-z0-9._-]{1,47}$` after **NFC + casefold**, and additionally rejects
  reserved (`xbus`, `broker`, `admin`, `system`), generic (`session`, `agent`,
  `claude`, `default`, `test`, `new-session`), UUID-like, all-numeric, and
  path-like (`:`, `/`, `\`, drive-letter) names.
- **`automatic_alias` is never mutated** by the name flow — it remains the fallback
  routing handle. `session_name`/`normalized_session_name` are new, parallel columns.

## Decision 4 — `pending_name` is unroutable; activation and rename are atomic

A session whose name is unusable (none derivable, taken, reserved, generic, malformed,
or two sessions racing from the same dir) registers with `session_name_state='pending'`
and a `pending_name_expires_at` (~5-min reservation TTL, swept). A `pending` session is
**not discoverable, cannot be targeted, cannot receive queued messages, and never
claims a name silently** (no random numeric suffix without showing the user).
`renameSession`/name-selection is a single transaction: validate → CAS-acquire the new
name via `ux_session_name_active` → release the old → audit. A name addressed after
rename **fails clearly** (`UNKNOWN_RECIPIENT`), never silently re-routes. The name
check runs **inside** `store.register()`'s transaction so a uniqueness failure rolls the
whole register back — no orphaned epoch advance (preserves I5 + the split-brain guard).

## Decision 5 — 15-day retention reuses `expires_at`; meaningful-activity is a closed list

- **Reuse the existing unused `expires_at` column** for the 15-day deadline
  (`expires_at = last_meaningful_activity_at + 15d`). Add only **`expired_at`** (actual
  sweep timestamp) + **`expiration_reason`** + **`last_meaningful_activity_at`**. We do
  **not** `RENAME COLUMN` (avoids the SQLite ≥3.25 portability risk entirely; the column
  is null in all rows so reuse is safe).
- **Meaningful activity (refreshes `last_meaningful_activity_at`) — the authoritative,
  closed list:** initial registration; an explicit user name op (register-with-name /
  rename); `BrokerStore.send()` (`store.ts:331–390`); ACK / reject / reply / explicit
  redelivery (daemon delivery handlers + `DeliveryOps`, since `ack`/`reply`/`redeliver`
  live in the daemon path, not `store.ts`); a checkpoint pull **that actually injects a
  body** (`delivery.ts checkpointPull`, only when it injects — not empty pulls); an
  intentional pause/resume/DND control change.
- **Must NOT refresh (passive / liveness):** `signalReadiness()` (`store.ts:273` — it
  fires on every reconnect/init and would make idle sessions immortal — **decided: not
  meaningful**); `cleanupComponents()`; a non-first-time reconnect `register()`; bare
  `last_seen_at`/`last_checkpoint_at` liveness updates (kept decoupled); `doctor`/admin
  inspection from another process; and the reaper's own passes.
- The refresh is an idempotent `UPDATE sessions SET last_meaningful_activity_at=?,
  expires_at=? WHERE session_id=?` at the **end** of the relevant transactional op.

## Decision 6 — expiry sweep: one new pass in the existing reaper transaction

Add **`reapExpiredSessions()`** as a fourth step inside `reaper.sweep()`'s existing
transaction (`reaper.ts:69–75`), and a `sessionsExpired` count on `SweepResult`. Per
expired session (CAS-guarded on `expired_at IS NULL` for idempotence), all in one
transaction:

1. `UPDATE sessions SET expired_at=now, expiration_reason='recipient_inactive_15_days',
   readiness='disconnected', session_name_state='retired'` where `expires_at <= now AND
   expired_at IS NULL`. Setting `readiness='disconnected'` **before** the rest closes
   the "in-flight checkpoint races expiry" window (injection is readiness-gated).
2. Release the name: it leaves the `ux_session_name_active` index automatically when
   `session_name_state` flips off `'active'`, so the name is immediately reclaimable.
   Retire any matching live alias row (`aliases.active=0, retired_at=now`).
3. Dead-letter pending deliveries to that recipient: `UPDATE deliveries SET
   state='dead_letter', failure_category='recipient_inactive_15_days'` **only** for
   `state IN ('queued','retry_wait')`. This **must carry the same `requires_ack`
   discipline shape as `reaper.ts:97`** and must **not** touch `transport_written`
   leases or the ACK-timeout path — non-ACK messages are already terminal `completed`
   at injection time and are unreachable by construction (preserves I3).
4. Audit `SESSION_EXPIRED` (insert-only `audit_events`; safe metadata only).

**Tombstone = the expired `sessions` row itself** (it durably holds session name,
former session id, last meaningful activity, expiry time, and reason — body-free by
construction). We do **not** add a separate `session_tombstones` table or a tombstone
*message*: the row is the diagnostic record, and the dead-lettered deliveries are the
boundary markers in the existing dead-letter tooling. No message body, no secret, ever
enters it.

**Expired-recipient sends** fail fast: `store.send()` (after recipient resolution,
~`store.ts:349`, and **after** the idempotency short-circuit so retries don't silently
succeed) throws the new **`RECIPIENT_SESSION_EXPIRED`** error. It is **final /
non-retryable** — `retry.ts`/`delivery.ts`/`reaper.ts` are audited so an expired
recipient never re-queues. Re-registration creates a **new epoch** with a fresh
binding and **no resurrection** of the old queue (the old deliveries are terminal
`dead_letter`).

## Decision 7 — `ensureBroker()` composes existing primitives; never force-restarts an incompatible broker

New `src/broker/ensure.ts` exporting `ensureBroker(dataDir, opts?)` →
`{ endpoint, isRunning, launched } | { degraded, reason }`, used by the MCP server,
hooks, the CLI, and admin clients:

1. `defaultEndpoint(dataDir)` → resolve. 2. `probeExisting(endpoint, 1500ms)` → if
reachable, connect-and-return (with a **connect deadline** — `IpcClient.connect()` has
no timeout in the raw-socket phase, `client.ts:48`). 3. `checkSingleton(dataDir,
endpoint)` → `already_running | contended | stale_cleared | acquired`. 4. On
`acquired`/`stale_cleared`: wrap `startBrokerHost(opts)` (which itself does
`ensureDataDir → openDatabase → runMigrations → checkSingleton → daemon.start()
(binds) → writeStateFile`) — do **not** reimplement it. 5. On `contended`/`EADDRINUSE`
(lost race): **bounded exponential backoff + jitter**, then re-probe and connect —
never hard-fail, never tight-loop. 6. Recheck liveness via `pidIsAlive()` after a probe
timeout (crash-after-bind detection). 7. On `VERSION_INCOMPATIBLE`
(`checkCompatibility`, `handshake.ts:96`) **surface to the user; never force-kill**
(preserves I1/I5 and ADR 0008). The hook keeps its silent-degrade contract: if
`ensureBroker` fails, it returns `{exitCode:0, injected:0}` so Claude still starts.

## Decision 8 — user-scope config manager: transactional, ownership-tagged, runtime op separate from ensureBroker

A new transactional user-scope Claude config manager (invoked at install time, after
plugin staging) registers the XBus MCP server + lifecycle hooks into the user's Claude
config, with: dry-run, pre-install backup, atomic write, post-write validation,
rollback-on-failure, repair, conflict detection, idempotence, and **ownership-tagged**
entries so uninstall removes **only** what this install created (never the user's other
MCP servers/hooks). `InstallManifest` (`install-paths.ts:26–41`) gains
`mcpServerRegistration`, `hooksRegistration`, `userConfigPreInstallBackup?`, and an
`ownershipTag`; the manifest checksum must remain valid across the additions. Platform
config paths are abstracted (`~/.claude` on Windows; `~/Library/Application
Support/Claude` on macOS; `~/.config/claude` on Linux). This install-time op is kept
**separate** from the runtime `ensureBroker()` — user-scope config is initialized
before/independently of broker start.

---

## §3 — Schema bump justification (I1): `xbus-p1-stp1-s5 → -s6`

Beta.4's named sessions + retention require new `sessions` columns, which means a
**migration v6**, which by `SCHEMA_VERSION = max(MIGRATIONS.version)` (`handshake.ts:14`)
makes `compatibilityId = xbus-p1-stp1-s6`. This is **required and separately justified**
(the escape clause in the frozen-invariant list):

- **It is the designed, fail-closed behavior — not a regression of the mechanism.** The
  schema component exists precisely so a beta.3 client connecting to a beta.4-migrated DB
  is forced to upgrade rather than silently writing against a schema it does not know.
  `checkCompatibility` (`handshake.ts:108–114`): `client.schema(5) < broker.schema(6)`
  ⇒ verdict `upgrade_component` (fail-closed). Keeping the literal `-s5` while the DB is
  v6 would make the verdict `compatible` and let a beta.3 client corrupt v6 state — that
  would defeat the guard the string represents. The owner accepted the bump on this basis
  (2026-06-30).
- **No STP / protocol change.** `PROTOCOL_VERSION` and `SECURE_TRANSPORT_VERSION` are
  unchanged; the XBUS-STP v1 wire bytes, key schedule, transcript, AAD, and
  `tests/fixtures/stp-vectors.json` are byte-for-byte identical (ADR 0011 §"Security
  note"). Only the schema integer in the tuple moves — exactly what a schema migration is
  *supposed* to do.
- **Required code/test updates (tracked):** regenerate any `-s5`-pinned assertions and
  the packaged `provenance.json` to `-s6`; add a handshake test that a beta.3-schema
  client (schema 5) is rejected `upgrade_component` by a v6 broker; verify migration 5→6
  on a populated DB (NULL defaults, query coalescing).

---

## §4 — Invariant-collision guards (the watch-list during implementation)

| Beta.4 change | Frozen codepath | Guard |
|---|---|---|
| v6 migration | I1 (`SCHEMA_VERSION`→`compatibilityId`) | Accepted bump (§3); regen fixtures + add stale-client-rejected test. |
| expiry sweep dead-letters pending deliveries | I3 (`reaper.ts:97`/`:105` `requires_ack=1`) | New pass touches only `queued`/`retry_wait`; never `transport_written`/leases/ACK-timeout. Non-ACK already terminal — unreachable. |
| activity-refresh / name-state on `checkpointPull` | I2 (Layer-3, `delivery.ts:254–264`; `ReceiptStore.issue()` null-idempotency, `receipts.ts:50`) | Refresh is metadata-only; must not alter `issue()`-returns-null. Regression test: duplicate checkpoint → injection id once, null thereafter. |
| name uniqueness in `register()` | I5 (split-brain `store.ts:164–176`; broker-derived authority) | Check **inside** the txn via the DB index; never delays epoch assignment; `SessionAuthority` shape unchanged; name never becomes identity (`session_id` PK immutable). |
| expired-recipient send rejection | I5 + retry semantics | `RECIPIENT_SESSION_EXPIRED` thrown **after** idempotency short-circuit; **final/non-retryable** — audit `retry.ts`/`delivery.ts`/`reaper.ts`. |
| `ensureBroker` auto-start | I1 + I4 + ADR 0008 | Never trust IPC-supplied role; never force-restart an incompatible broker; exactly one broker per dataDir. |

---

## §5 — Composability with held PR #4 (adapter conformance)

PR #4 (`test/adapter-conformance-and-tier-enforcement`, HELD/open) adds
`evaluateRegistration(payload, manifest?)` **inside** `onRegister` (`daemon.ts:278`,
before `store.register()`), computing broker-owned `ValidationEvidence` →
`calculateMaximumTier()` and stashing an awarded tier in an in-memory `connAwarded`
map. Both feature sets edit the same two functions. Rules so the eventual two-parent
merge is clean (not a rework):

1. **Separate wire concerns:** session name in a **separate** optional
   `requestedSessionName` field on `RegisterPayload` (`commands.ts:54–64`); adapter
   identity in a **nested** `adapterRegistration` object (PR #4's). Never merge them.
2. **Preserve ordering:** `onRegister` → hello confirmed → (PR #4) `evaluateRegistration`
   reads `adapterRegistration` → (beta.4) name validation → `store.register()` → ack.
   Beta.4 must not move the `store.register()` call or change `RegisterInput`
   (`store.ts:26–40`) in a way that breaks PR #4's read.
3. **Preserve the ack contract (frozen by both):** `register_session_ack` keeps
   returning `{ sessionId, instanceId, componentInstanceId, role, epoch, generation }`
   (`daemon.ts:297`). Beta.4 ADDs optional `awardedSessionName` + `sessionNameState`;
   PR #4 ADDs optional `awardedTier`. All additive; clients ignore unknown fields.
4. **Schema separation (I4):** beta.4's `adapter_id`/`adapter_version`/`agent_type`
   (if added to `component_instances`, `migrations.ts:209–222`) are **manifest metadata,
   NOT evidence**. Beta.4 stores **no** adapter-supplied tier/support claim anywhere.
5. **Name-check failure timing:** a uniqueness failure after `SessionAuthority` is
   computed but before ack must roll back the whole register inside the same transaction
   (no orphaned epoch advance) — preserving the split-brain guard.

---

## §6 — Implementation order (dependencies first)

1. ~~Compat-tuple decision~~ (DONE — §3, accept `-s6`).
2. Migration v6 (columns + `ux_session_name_active` + reuse-not-rename `expires_at`);
   test 5→6 on a populated DB.
3. `validateSessionName` zod schema (distinct from the alias validator).
4. `register()` name path + `renameSession` (coordinate the payload split with PR #4
   per §5 *before* writing the wire field).
5. Activity-refresh wiring (Decision 5 list) + the I2 regression test.
6. Reaper `reapExpiredSessions()` + `RECIPIENT_SESSION_EXPIRED` + final/non-retryable
   send rejection.
7. `ensureBroker()` (independent of schema — parallelizable).
8. User-scope config manager + transactional install/uninstall/repair (independent —
   parallelizable).
9. Automatic registration + pending-name interaction in MCP/hook startup.

**Riskiest items (ranked):** R1 the compat bump (resolved, §3); R2 the name-release ↔
re-registration race (sweep releases the name in the same txn it sets `expired_at`; new
claim goes through `ux_session_name_active` so SQLite serializes — test concurrent
sweep+register under `FakeClock`); R3 reaper idempotence (CAS on `expired_at IS NULL`,
dead-letter only `queued`/`retry_wait`); R4 the meaningful-activity definition (Decision
5 closed list + per-site test); R5 Layer-3 injection-id idempotency (regression test);
R6 PR #4 merge collision (the §5 payload split).

---

## Cross-references

- ADR 0003 — identity & receipt authority (the session/epoch/receipt model this extends).
- ADR 0004 — version handshake (the compatibility-verdict mechanism §3 relies on).
- ADR 0008 — split-brain one-owner (the singleton/lock `ensureBroker` reuses).
- ADR 0011 — build-identity model (why a schema move is not an STP bump).
- `src/database/migrations.ts`, `src/broker/{store,reaper,delivery}.ts`,
  `src/protocol/{errors,commands,schemas,handshake}.ts`, `src/broker/singleton.ts`,
  `src/cli/install.ts` — the extension points cited throughout.
