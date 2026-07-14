# ADR 0025 — Beta.7: idle wake + scheduling (opt-in managed execution)

**Status:** Accepted for Phase-3 build · **Date:** 2026-07-14 · beta.7 · builds on ADR 0021
(operator send / `local-operator`), the reaper (periodic-tick model), and the beta.6 delivery
lifecycle (exactly-once). Synthesized from the design-panel judge verdict.

## Documented Claude Code facts + the load-bearing caveat

- Delivery is **pull-only**: the broker NEVER pushes a message between turns; a message reaches
  the model only when the session's checkpoint hook pulls at a checkpoint.
- **`asyncRewake`** on a `type:command` hook is the documented external-influence surface: the
  hook runs in the background and, **on exit code 2, wakes Claude with a system reminder**.
  `--bg`/`--print`/`--session-id`/`--resume`/`--max-turns`/`--max-budget-usd`/`--permission-mode`
  are documented headless flags.
- **LOAD-BEARING UNVERIFIED:** whether a SessionStart-attached `asyncRewake` hook stays
  *resident* and can wake a *truly idle* session with no further events — and whether a `--bg`
  child runs SessionStart+checkpoint hooks — is **NOT proven by the docs**. Both are therefore
  **gated behind a recorded `doctor` spawn-probe**; the durable floor (below) guarantees
  correctness regardless of the probe result. XBus never claims the broker pushes into a
  conversation, and never claims `-p`/`--bg` hook behavior it hasn't spawn-tested.

## Decision — a two-layer, honest design

1. **FLOOR (always correct, no wake dependency):** the scheduler / a peer send always calls
   `store.operatorSend` → a durable **QUEUED** delivery. It drains whenever the target next hits
   ANY real checkpoint via the EXISTING pull path (`checkpointPull` → `markInjected` →
   `additionalContext` inside the untrusted-peer fence). Exactly-once-visible is the beta.6
   machinery (`markInjected` + `ux_recipseq`). This alone satisfies "the message is processed
   once" — the wake only reduces latency.

2. **ACCELERATOR (the honest wake):** a NEW, THIRD user-scope hook `rewaker.js` attached at
   **SessionStart** (resident, launched once), exec-form `asyncRewake:true`. It connects via
   `IpcClient` and waits for the broker to signal that THIS session has an *eligible* QUEUED
   delivery (readiness `acceptsInjection` true AND auto-delivery not paused/dnd/manual). On
   eligibility it **exits 2** → the documented `asyncRewake` system reminder → the session takes
   a turn → its existing checkpoint hook pulls the body. The rewaker NEVER carries the body; the
   reminder text is only "XBus has a pending delivery; a checkpoint will present it." (Rejected:
   overloading the Stop checkpoint hook with `asyncRewake` — it conflates async-background with
   synchronous injection and cannot wake a session already idle at a completed Stop.)

3. **SCHEDULER** (`src/broker/scheduler.ts`, mirrors the reaper): a pure `tick(DB, now)` on an
   unref'd `setInterval` (`schedulerIntervalMs`, 0 disables; `runSchedulerTick()` twin of
   `runReaperSweep` for FakeClock tests). Per due schedule, ONE savepoint-reentrant
   `db.transaction`: **CLAIM** (`INSERT OR IGNORE schedule_runs`, `UNIQUE(schedule_id,
   scheduled_for)` — a duplicate tick's loser no-ops) → **GATES** (paused / quiet-hours /
   wake-limit / concurrency / recipient-expired → `state='skipped'` + advance `next_run` PAST
   the block) → **SEND** (`store.operatorSend` with `idempotencyKey='sched:'||id||':'||scheduled_for`
   — `ux_idem` makes a restart re-fire a no-op) → **ADVANCE** (`next_run`/`last_run`/`fires_used`,
   `exhausted` when `max_fires` reached or `kind='once'`).

4. **EXACTLY-ONCE across duplicate tick + broker restart:** `schedule_runs.UNIQUE` prevents a
   double-CLAIM; `ux_idem` prevents a double-SEND; the single atomic transaction makes
   CLAIM+SEND+ADVANCE all-or-nothing. Crash-before-commit → full rollback (message included) →
   clean redo. Crash-after-commit → `next_run` advanced + both UNIQUEs prevent re-fire. Schedules
   are durable WAL rows; on restart `runMigrations` is a checksum no-op, the daemon reconstructs
   the unref'd scheduler timer, and the first tick is a pure re-evaluation needing no recovery
   pass. No `claim_expires_at` lease (redundant under the atomic claim).

5. **MANAGED LAUNCH** (`delivery_mode='managed_spawn'`, **default OFF, EXPERIMENTAL, gated on a
   recorded `--bg` spawn probe**): reuse the `xclaude` launcher seam (`resolveClaudeExecutable`
   + Windows cmd/PATHEXT quoting) to run `claude --bg` (NEVER `-p`) `--session-id <preminted UUID
   recorded to sessions BEFORE spawn to close the register race>` `--plugin-dir <installed
   pluginDir>` `--max-turns/--max-budget-usd` (from `managed_budget_json`) `--permission-mode
   plan` `--append-system-prompt 'process the single pending XBus message and reply; do NOT
   create schedules or spawn work'` `--allowedTools 'mcp__xbus__xbus_inbox,xbus_ack,xbus_reply'`.
   Env: `XBUS_DATA_DIR` pinned, no secret in env/argv. Register `pid` → managed_*; the spawned
   session's own hooks drain the already-QUEUED message on the same pull path. If the installed
   CLI lacks `--bg` or hooks don't fire, **degrade to `enqueue_only`** (never silently drop).

6. **Loop-prevention + budgets:** `min_interval_ms` floor (rejected below at creation),
   `origin_guard` (a scheduled message may not create schedules), `wake_limit_per_day` +
   `wakes_today`, a session-level cross-schedule wake throttle, `max_fires`, `concurrency_key`,
   `timeout_ms`, pause/cancel (CAS on `state`), quiet-hours (advance `next_run` PAST the window,
   DST/tz deterministic + RNG-free). Every lifecycle transition appends an audit + ledger event.

## Acceptance (proves both goal criteria honestly)

- **Idle wake processes one message without a dummy prompt:** with the wake gated behind the
  recorded doctor probe, prove from the `receipts`/`deliveries` rows + the transcript that a
  message enqueued to an idle session is delivered + acked/replied exactly once, with an EMPTY
  stdin prompt (no synthetic user turn). If the probe shows the resident asyncRewake does not
  fire on this host, the FLOOR still delivers on the session's next real checkpoint — reported
  honestly, never claimed as a broker push.
- **A scheduled task survives broker restart + completes once; a duplicate tick/schedule causes
  no duplicate:** kill the broker mid-tick (before/after commit), restart, assert exactly one
  `schedule_runs` row for the slot + one message via `ux_idem` + `next_run` advanced.

## Consequences

- Positive: opt-in managed execution with rigorous exactly-once, honest wake (never faking a
  push), and hard loop/budget guards. Correctness never depends on the unverified wake.
- Negative / accepted: the resident-rewaker wake + managed-spawn are experimental, gated on a
  host probe, and default-off; the durable floor is the guarantee.
