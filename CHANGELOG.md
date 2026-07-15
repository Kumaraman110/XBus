# Changelog

All notable changes to XBus are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is in
pre-1.0 Developer Preview, so the public surface may still change.

## [Unreleased]

## [0.1.0-beta.7] — Phase 3: frictionless runtime, professional console, session control, managed execution

The adoption/control/execution milestone. Five areas, all same-machine:

- **Bundled Node runtime** (ADR 0022): the Windows artifact ships an XBus-owned `runtime/node.exe`
  (pinned 22.23.1, in the `[22.13,25)` floor). Installed XBus launches the broker/CLI/hooks via
  the bundled runtime and **ignores system Node/PATH** — users never install/select/configure
  Node. It rides the existing atomic install swap + DB-snapshot rollback; `doctor` + provenance
  report the runtime version; the reproducible STORE zip stays byte-identical.
- **Professional dashboard** (ADR 0023, built with the official Anthropic **`frontend-design`**
  skill for the aesthetic direction + the **`dataviz`** skill for the validated delivery-state
  palette): a distinctive sci-fi operator console — delivery renders as **separate columns
  Queued | Delivered | ACK | Replied | Failed** (no combined string) as ≥3:1-contrast colored
  state pills; an **Internal sessions** filter hides `cli-*`/operator/installer sessions by
  default; friendly statuses + a keyboard drill-down; responsive + focus-visible +
  loading/empty/error states; pure-CSS depth/atmosphere/motion. Strict CSP preserved (external
  CSS/JS only, no inline styles, no remote fonts/images).
- **Title sync + session controls** (ADR 0024): the Claude-native `session_title` is captured
  OBSERVE-ONLY (documented SessionStart field) into `claude_title`, stored **separately** from
  the xbus alias (never routable, never claimed as a Claude-title change). Operator controls
  (bearer-gated, ownership-bounded): rename alias, pause/DND, pin/archive, remove-record (keeps
  the Claude transcript + audit history), stop managed sessions.
- **Idle wake + scheduling** (ADR 0025, opt-in): a `schedules`/`schedule_runs` scheduler mirrors
  the reaper with **exactly-once** execution across duplicate ticks and broker restart
  (`UNIQUE(schedule_id, scheduled_for)` claim + `ux_idem`); quiet-hours, wake/fire limits,
  concurrency, loop guards. A resident SessionStart **`asyncRewake`** rewaker accelerates
  delivery to an idle session by firing the documented wake (a body-free reminder — never a
  push, never keystrokes); the durable QUEUED delivery + pull path are the correctness floor.
  A sandboxed **managed background session** launcher (`claude --bg`, plan mode, restricted
  tools) is experimental + default-off, gated on a `--bg` spawn probe.
- **Federation/enterprise skeleton** (ADR 0026): compile-tested TypeScript interfaces + honest
  docs for a future LAN/relay/enterprise design — **experimental, unvalidated, not wired**;
  `isFederationEnabled()` is a hard `false`.

Additive **migration v9 (8 → 9)** — wire tuple `xbus-p1-stp1-s9`, a fail-closed whole-install
upgrade; existing beta.6 data migrates in place. Peer messaging, operator threads, exactly-once
delivery, dashboard auth, and ledger integrity are all preserved.

Hardening from the pre-ship adversarial review:

- **Scheduler `once` + quiet-hours no longer drops the message.** A one-time schedule blocked by
  a quiet window (or wake-limit / concurrency gate) is now **deferred** past the block and retried,
  never silently exhausted.
- **`stop_managed` is pid-recycling-safe.** It SIGTERMs only a child the broker still holds a live
  in-process handle for (pid + launch_key match); with no live handle it clears markers and does
  not kill a bare pid. A managed child's exit clears its markers so no dead session retains a
  killable pid (ADR 0024 §4 now describes the implemented guard).
- **`doctor node_runtime`** detects the bundled-runtime `command` by installed entry **path**, so
  it stays green after Claude Code strips the `_xbusOwner` tag on first run (no false-fail).
- **Concurrency guard** counts only in-flight (`claimed`) runs, so a keyed schedule keeps firing
  instead of wedging after its first fire.
- **`schedule_runs` retention**: the reaper prunes old terminal run rows (default 7-day horizon,
  exactly-once-safe) + covering indexes were added, so the run ledger can't grow unbounded.
- **Successful upgrades reclaim the plugin backup** (no per-upgrade accumulation of the bundled
  runtime on disk).
- **Dashboard rename errors** (name taken / invalid) return **400** with the actionable message
  instead of a suppressed 500.

## [0.1.0-beta.6] — Phase 2: threaded messaging + local-operator communication console

The communication-console milestone. The authenticated localhost dashboard becomes a
two-way console: from the browser you can select a routable Claude Code session, open or
reopen a **thread**, and send as the reserved **`local-operator`** actor — then watch the
request, acknowledgement, reply, retries and failures land in one ordered timeline, and
continue the conversation over multiple turns without copying message ids. Unread counts,
delivery state, and safe (idempotent) retry are all surfaced; a thread survives browser
reload, broker restart, and Claude-session restart because it is reconstructed from SQLite.

This is an **additive schema step (migration v8, 7 → 8)** — the wire compatibility tuple
moves to `xbus-p1-stp1-s8` (protocol + STP stay `1`) and, per ADR 0019, it is a controlled
whole-install upgrade: an s7 (beta.5.1) component meeting a v8 broker is fail-closed at the
handshake. Existing beta.5 data migrates in place (every legacy message is backfilled into a
coherent degenerate thread keyed on its `correlation_id`); install snapshots and restores the
DB on any failed upgrade, so a failed beta.6 install leaves a working s7 install.

- **Threads are first-class** (ADR 0017): new `threads` / `thread_participants` (an
  extensible N-party join-table) / `thread_sequences` tables + `thread_id` / `thread_sequence`
  / `author_type` on `messages`. `thread_id == correlation_id`; `parent_message_id` points at
  the exact turn answered; `thread_sequence` gives a single monotonic order across both
  directions. Peer send/ack/reply and exactly-once visible delivery are **unchanged** — a
  thread turn flows through the same lifecycle and injects identically to a peer message.
- **The `local-operator` principal** (ADR 0021): a single reserved, unmanaged, non-routable,
  **non-expiring** `sessions` row provisioned at broker start. It satisfies the
  `recipient_sequences → sessions` FK so a Claude reply routes back to the operator, holds
  no session authority (so it can never pull/ack/reply or impersonate a session), and is
  never surfaced as a routable target. Browser messages are **broker-stamped**
  `author_type='operator'` / `sender_session_id='local-operator'` — the browser never sets a
  sender/actor. `local-operator` is reserved so no real session can claim the name.
- **Console API + UI**: new bearer-token-gated `POST /api/thread`, `POST /api/thread/:id/send`,
  `POST /api/thread/:id/read` routes (forwarded to the single-writer broker loop — the
  dashboard's own DB handle stays physically read-only) and `GET /api/threads`,
  `/api/thread/:id` read projections, with live timeline/unread updates over the existing
  authenticated NDJSON fetch-stream. The static console UI ships as external assets under a
  strict CSP (no inline JS). Message text stays untrusted-peer content to the recipient
  (same fenced injection, same reserved-metadata rejection).

## [0.1.0-beta.5.1] — fix: doctor false-fails hook detection after first `claude` run

A detection-only patch; **no protocol, schema, wire, or messaging change** — the compatibility
tuple stays `xbus-p1-stp1-s7` and beta.5 data/installs are unaffected. `xbus doctor` decided the
`session_start_hook` check from the non-standard `_xbusOwner` handler property, but Claude Code
**strips unknown keys** when it re-serializes `~/.claude/settings.json` (which it does on the
first session after install). The hook stayed fully functional, yet doctor reported
`SessionStart hook NOT registered` — a false failure that drove users to "repair" a working hook.
`inspectUserScopeHooks` now also recognizes an XBus hook by its installed **entry path** (supplied
by `doctor` from the install manifest); the `_xbusOwner` tag remains authoritative for uninstall
*ownership* only, and a host-stripped hook now reports `registered:true, owned:false`. Foreign
untagged hooks are still never claimed. Regression covered in `tests/unit/user-scope-config.test.ts`.

## [0.1.0-beta.5] — control plane, Phase 1: session visibility

The control-plane milestone. Every new/resumed/continued/cleared/compacted/forked Claude
Code session automatically appears in one **authenticated localhost dashboard**, backed by
an **append-only, hash-chained SQLite audit ledger**. **The compatibility tuple moves
`xbus-p1-stp1-s6 → xbus-p1-stp1-s7`**: the application protocol and XBUS-STP wire
format/crypto are unchanged (both still `1`); only the database schema integer advances
`6 → 7` — a deliberate fail-closed bump, so an s6 (beta.4.1) component meeting an s7 broker
is rejected `upgrade_component` at the handshake. Beta.5 is a **whole-install upgrade**, not
mixed-version operation. **No new messaging semantics** — beta.4.1 request/ACK/reply is
unchanged. This is Phase 1 of the design merged in PR #10 (ADRs 0013–0020); threaded
messaging, operator-send, and title-sync are deferred to later phases.

### Added
- **SessionStart auto-registration (ADR 0013 D2).** A new `SessionStart` hook announces
  every lifecycle event (`startup`/`resume`/`clear`/`compact`, and forks as a `startup`
  with a new id) to the broker via a new `announce_session` frame → one broker transaction
  → authoritative visibility state + exactly one audit-ledger event. The hook is always
  **non-blocking**: malformed input, an incompatible Node, or a broker failure/timeout
  produces bounded stderr and exits 0 so Claude Code still starts.
- **Append-only, hash-chained audit ledger (ADR 0016/0020).** `ledger_events` +
  `ledger_anchors` with append-only triggers; each entry chains to the previous
  (`sha256(prev_hash ‖ canonical(fields))`) with a dense, gap-free `seq`. Written in the
  same transaction as each state mutation (no divergence); a ledger-specific failure aborts
  the op with the typed `AUDIT_PERSISTENCE_FAILED` (a deliberate availability tradeoff). A
  `verify` routine localizes any tamper/drop/bit-rot to the first bad seq.
- **Read-only localhost dashboard (ADR 0015/0018).** A broker-owned `127.0.0.1` HTTP server
  (loopback-only, refused otherwise) with a nonce→exchange→tab-token auth bootstrap
  (one-time nonce in memory + URL fragment only; atomic single-use TTL-bound
  `POST /auth/exchange`; short-lived bearer token never logged/persisted/in-URL/in-ledger),
  strict CSP, and a vanilla UI that is a pure client of the API. DB reads run **off the
  broker event loop** in a `worker_thread` with a physically read-only handle
  (`DatabaseSync({ readOnly: true })`) — writes/DDL/write-pragmas are rejected, and a
  pathological scan/hung client/worker crash cannot disrupt delivery.
- **Metadata-only dormant import (ADR 0013 D5)** of prior sessions from the transcript
  listing (never opens a transcript body), surfaced as unroutable `dormant` rows; and a
  **conservative aggregate unmanaged banner (ADR 0013 D6)** computed from non-invasive
  process counts (never reading a foreign process's env/memory).

### Changed
- **Runtime floor raised to Node `>=22.13 <25`** so the read-only dashboard worker can use
  `DatabaseSync({ readOnly: true })`. Product install + broker entry remain fail-closed
  below 22.13; the SessionStart hook stays fail-open (never blocks Claude).
- **Install rollback now snapshots the DB (ADR 0019 D4).** On any schema increase the
  installer takes a durable DB+WAL+SHM snapshot before the health check migrates the live
  DB; a health-check failure restores the verified pre-upgrade DB, so a failed upgrade
  leaves a working prior install rather than a forward-migrated DB with a rolled-back plugin.

## [0.1.0-beta.4.1] — session-registration robustness patch

A correctness patch for the beta.4 named-session registration path. **No protocol,
XBUS-STP, schema, or compatibility change** — `compatibilityId` remains
`xbus-p1-stp1-s6` and schema remains `6`. This is a beta.4 patch release; the beta.5
version is reserved for the localhost control-plane / lifecycle / audit-ledger /
threaded-messaging phase.

### Fixed
- **Automatic-alias prefix collision no longer fails registration.** The broker-minted
  fallback alias (`session-<8hex>`) is derived from only the first 8 hex characters of
  the `CLAUDE_CODE_SESSION_ID`. Two distinct sessions sharing that prefix mapped to the
  same alias, and the second registration hit a raw `UNIQUE constraint failed` that was
  surfaced to the peer as a mislabeled `DATABASE_ERROR "internal error"` — failing the
  whole registration. The fallback alias is now claimed collision-safely: the colliding
  session registers cleanly (still fully routable by its exact session id) and simply
  does not hold the shared convenience alias. Applied at all three fallback-alias sites
  (first registration, expired-resume, and rename-resume reactivation).

## [0.1.0-beta.4] — zero-friction launch, named sessions, and 15-day retention

The zero-friction adoption milestone (ADR 0012). **The compatibility tuple moves
`xbus-p1-stp1-s5 → xbus-p1-stp1-s6`**: the application protocol and XBUS-STP wire
format/crypto are unchanged (both still `1`), only the database schema integer
advances `5 → 6` — a deliberate fail-closed bump so older code refuses a
v6-migrated database. This is a product-version + provenance reconciliation of the
functional integration merged for beta.4; there is no protocol, XBUS-STP, or crypto
change beyond the schema component of the tuple.

### Added
- **Zero-friction launch (ADR 0012 D7).** `ensureBroker()` composes the existing
  connect-or-start primitives into one race-safe entry and never force-restarts an
  incompatible broker.
- **Required human-readable session names (ADR 0012 D2/D3/D4).** A session name is a
  new lifecycle column, orthogonal to connection state and readiness:
  global-within-broker, case-insensitive, enforced by a partial unique index. A
  `pending_name` session is unroutable; activation and rename are atomic.
- **15-day activity retention (ADR 0012 D5/D6).** Inactive sessions expire after 15
  days of no meaningful activity (a closed activity list) via one new pass in the
  existing reaper transaction; retention reuses `expires_at`.
- **User-scope config manager (ADR 0012 D8).** Transactional, ownership-tagged
  install/uninstall of the Claude MCP entry + hooks, with the runtime broker op kept
  separate from `ensureBroker()`.
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

## [0.1.0-beta.3] — Windows and delivery-correctness hotfix

A release-correctness update for the Windows first-user experience and checkpoint
delivery lifecycle. There is **no protocol, XBUS-STP, schema, crypto, or compatibility
ID change** (`compatibilityId xbus-p1-stp1-s5` remains unchanged). Broker lifecycle
behavior is corrected for non-ACK delivery and automatic checkpoint reinjection. Scope:

- **Install bootstrap corrected.** Install is **PATH-free by design** — there is no
  global `xbus` command. README / installation / quickstart now document the actual
  `node ./dist/cli/main.js install` source bootstrap (and installed-plugin absolute
  paths), and no longer claim PATH modification or lead with a bare `xbus install`.
  Added an `install.ps1` release-asset helper.
- **Install reliability fix.** The product version was duplicated across
  `package.json`, `XBUS_VERSION`, and `.claude-plugin/plugin.json`; a divergence made
  a clean install fail contract validation and roll back (leaving no plugin). All three
  are now reconciled and a version-consistency guard test prevents regressions.
- **Node support boundary.** `engines` is `>=22.5 <25`. **Node 25+ is not yet
  supported** (not validated by the clean-machine suite); the CLI/launcher now print an
  actionable unsupported-Node error early instead of failing deep.
- **Test isolation.** The integration suite can no longer launch the user's real Claude
  Code: the launcher refuses real-`claude` fallback in test mode, the harness clears
  inherited `CLAUDE_*` env and pins an isolated legacy data root (never the real
  `~/.claude/xbus`), and `npm test` is explicitly not an install step.
- **Fail-fast artifact gate.** The artifact-first suite asserts the installed plugin
  is complete immediately after install and stops (retaining the dir) on failure, so
  later MCP/hook/launcher tests never run against a missing plugin.
- **Dependency audit.** `npm audit` is clean (vitest upgraded to 4.x; the prior findings
  were all dev-only and never shipped — the packaged artifact bundles only `uuid` + `zod`).
- **Clean-machine acceptance.** New `npm run accept:clean-machine` runs the documented
  flow end-to-end (install → doctor → fake-host MCP init → broker → two-session
  send/ack/correlated-reply → stop → uninstall) using only installed files.
- **Windows Claude launcher resolution.** The launcher now resolves npm-installed
  Claude Code shims deterministically on Windows using
  `claude.cmd → claude.exe → claude.bat → claude`, never selects `claude.ps1`,
  and retains `CLAUDE_CODE_EXECPATH` as an explicit advanced override.
- **Non-ACK delivery lifecycle corrected.** Messages with `requires_ack=false`
  no longer receive ACK deadlines or enter ACK-timeout requeue/dead-letter handling.
  Fire-and-forget messages become terminal after successful checkpoint injection;
  non-ACK messages requiring a reply remain pending only for that correlated reply.
- **Checkpoint injection-ID invariant enforced.** An automatic checkpoint never
  returns a message body without a valid injection ID and never automatically
  re-presents an already-injected body in the same epoch. ACK-timeout escalation
  remains active for ACK-required messages, while explicit redelivery remains the
  only path that intentionally presents the body again under a new logical
  injection number.

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
