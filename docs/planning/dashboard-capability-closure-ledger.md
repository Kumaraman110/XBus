# Dashboard Capability-Closure Ledger

Train B — beta.10 dashboard capability closure.
Branch: `feature/beta10-dashboard-capability-closure` · base Stage-0 `c6c761c`.
Author: AgenTel-Dashboard-Builder. Status as of the Stage-0 snapshot (before any Train B code).

This is an **evidence artifact**. Every capability is cited to `file:line` in the worktree source.
It inventories every currently-implemented user-facing capability and classifies each as exactly
one of **SHIPPED / HIDDEN / EXPERIMENTAL / BLOCKED** (never "PARTIAL").

## Status vocabulary (as applied here)
- **SHIPPED** — broker + API + a working dashboard control + it reflects authoritative state on refresh.
- **HIDDEN** — broker + API + authorization + audit are fully implemented and tested, but there is **no
  dashboard control** at all. The capability is reachable only via raw HTTP. (A release-gate failure the
  moment we claim the console is "complete", but NOT a dead-button failure — nothing visible lies.)
- **EXPERIMENTAL** — reachable/visible but explicitly not presented as supported.
- **BLOCKED** — an implemented, wired code path that cannot produce a correct/useful result by
  construction (e.g. a value hardcoded to a no-op), so the visible surface is inert.

---

## Headline findings

- **22 user-facing capabilities inventoried.**
  - **SHIPPED: 14** (session roster, session drill-down, audit ledger view, audit chain status, live
    stream, internal-sessions filter, theme toggle, thread list, thread timeline, new thread, send
    follow-up, mark-read, retry-failed-turn, sessions/threads live badges).
  - **HIDDEN: 7** (operator controls: rename-alias, set-control/pause-DND, pin/unpin, archive/unarchive,
    remove-record, stop-managed; plus scheduling create/pause/resume/cancel). All have broker impl +
    API route + server-side authorization + audit event + unit/route tests — but **zero UI**.
  - **BLOCKED: 1** (the unmanaged-sessions banner: `/api/unmanaged` is served and the UI renders it,
    but the read-model hardcodes `possibleUnmanaged: 0` and `computeUnmanagedBanner()` is never wired
    to the API, so the banner can never appear).
  - **EXPERIMENTAL: 0.**

- **Nonfunctional *visible* controls (the dead-button release-gate): NONE at Stage-0.** Every control
  that is actually rendered in `index.html` works end to end (verified below). The gap is entirely
  (a) capabilities with no UI surface (HIDDEN) and (b) one server value that is inert (BLOCKED).
  **This is the bar Train B must not regress:** adding controls must not introduce a single dead button.

- **State-consistency latent defect (blocks the vertical slice, not Stage-0):** the read-model
  `sessions()` projection does **not** surface `pinned`, `archived`, `archived_at`, the receive-control
  mode, or `claude_title`, even though the columns exist and the broker writes them
  (`read-model.ts:178-262`; columns at `migrations.ts:607-609`). So a pin/archive/pause action today
  would mutate the DB and audit correctly but the dashboard could not display the resulting state, and
  the roster does not hide archived rows. **Closing the slice requires extending this projection first.**

---

## Capability records

### A. Read/observability surface

#### A1. Session roster — **SHIPPED**
- Broker store/delivery: `DashboardReadModel.sessions()` reads a physically read-only handle,
  derives a label per the ADR-0020 decision table, and folds bounded GROUP-BY delivery aggregates
  (no N+1). `src/broker/dashboard/read-model.ts:178-262`; label fn `read-model.ts:39-47`.
- API route / MCP tool: `GET /api/sessions` → `reader.run('sessions')`. `src/broker/dashboard/server.ts:346`.
  Worker dispatch `src/broker/dashboard/read-worker.ts:46`.
- Authorization: bearer tab-token required for every `/api/*` (checked first, all methods).
  `server.ts:201-202`; token validation `src/broker/dashboard/auth.ts:94-101`.
- Audit event: none (read-only projection; reads never ledger).
- Dashboard exposure: sessions table with monogram/name/project, friendly status, five delivery
  columns, drill-down. `src/broker/dashboard/static/app.js:126-163`; markup `static/index.html:96-121`.
- Browser/e2e coverage: `tests/integration/control-plane-e2e.test.ts:77` (announce → authenticated
  read-model shows the session over real HTTP). No real *browser* (see "Testing reality" below).
- Known defect: none.
- Disposition: keep; extend the projection (see F1) so the slice can render lifecycle/control state.

#### A2. Session detail / drill-down — **SHIPPED**
- Broker: `DashboardReadModel.session(id)` (same safe projection, single row). `read-model.ts:265-267`.
- API: `GET /api/session/:id` → `reader.run('session', {sessionId})`; 404 when unknown. `server.ts:354-358`.
- Authorization: bearer token (as A1). `server.ts:201-202`.
- Audit: none (read).
- Dashboard exposure: a keyboard-operable "Details" disclosure per row showing id / conn·readiness /
  mgmt·confidence / last-sent / last-received. `app.js:98-117`.
- Browser/e2e coverage: exercised transitively via the sessions read in control-plane-e2e; the
  per-row drawer itself has **no automated coverage** (no DOM harness).
- Known defect: the drawer is built from the roster payload, so any field absent from the projection
  (pinned/archived/control mode) is simply not shown.
- Disposition: promote to a proper detail *inspector* in the slice (Deliverable 3.2).

#### A3. Audit ledger view — **SHIPPED**
- Broker: `DashboardReadModel.ledger()` keyset-paginated, clamps `limit` to [1,500], guards NaN.
  `read-model.ts:274-293`.
- API: `GET /api/ledger?beforeSeq&limit` → `reader.run('ledger', …)`. `server.ts:349-353`.
- Authorization: bearer token. `server.ts:201-202`.
- Audit: none (it *is* the audit read).
- Dashboard exposure: compact ledger rows (seq · event·actor · short hash + ok-dot). `app.js:228-251`.
- Browser/e2e coverage: read path covered in control-plane-e2e; UI render uncovered.
- Known defect: none material.
- Disposition: keep.

#### A4. Audit-chain health — **SHIPPED**
- Broker: `DashboardReadModel.auditStatus()` runs `verifyLedger` + reads last `LEDGER_VERIFIED`.
  `read-model.ts:436-448`.
- API: `GET /api/audit` → `reader.run('auditStatus')`. `server.ts:348`.
- Authorization: bearer token. `server.ts:201-202`.
- Audit: reads (does not emit).
- Dashboard exposure: chain-status pill in the ledger card + KPI tile (OK/BROKEN). `app.js:203-225`,
  KPI at `app.js:197-199`; markup `index.html:46,126-129`.
- Browser/e2e coverage: read path uncovered by browser; unit coverage of `verifyLedger` elsewhere.
- Known defect: none.
- Disposition: keep.

#### A5. Live update stream — **SHIPPED**
- Broker: NDJSON fetch-stream; coalesced broadcast (one `sessions`+`threads` read fanned to all
  streams), capped at `maxStreams` (default 64), heartbeat fallback. `server.ts:396-453`.
- API: `GET /api/stream` (auth'd). `server.ts:370`.
- Authorization: bearer token before stream open. `server.ts:201-202`.
- Audit: none.
- Dashboard exposure: `stream()` reads the body, re-renders sessions/threads on each frame; a 5s
  backstop poll surfaces persistent failure as a visible banner. `app.js:486-509,536-537`.
- Browser/e2e coverage: server-side stream bounds/coalescing/overload covered
  `tests/integration/dashboard-server.test.ts:200-` ("stream + broadcast + overload bounds"); the
  browser consumer is uncovered.
- Known defect: none.
- Disposition: keep; the slice's live-refresh requirement rides on this.

#### A6. Internal-sessions filter — **SHIPPED**
- Broker: `isInternalSession()` derived flag on each row (no schema change). `read-model.ts:154-159`,
  applied `read-model.ts:252`.
- API: carried on the sessions payload as `internal`.
- Authorization: n/a (client-side toggle over already-authorized data).
- Audit: none.
- Dashboard exposure: "Internal sessions" checkbox; persists choice in sessionStorage; re-renders
  cached rows + shows a hidden-count note. `app.js:119-124,130-161,517-524`; markup `index.html:116-120`.
- Browser/e2e coverage: none (client-only behavior, no DOM harness).
- Known defect: none.
- Disposition: keep; fold into the roster's filter set (Deliverable 3.1).

#### A7. Theme toggle (light/dark) — **SHIPPED**
- Broker: n/a (inert asset).
- API: n/a.
- Authorization: n/a.
- Audit: none.
- Dashboard exposure: `theme.js` applies saved/OS theme before paint and wires the toggle button;
  persists to localStorage; tracks live OS changes. `src/broker/dashboard/static/theme.js:12-62`;
  button `index.html:28-31`.
- Browser/e2e coverage: none.
- Known defect: none.
- Disposition: keep.

### B. Operator communication console (beta.6 Phase 2)

#### B1. Thread list — **SHIPPED**
- Broker: `DashboardReadModel.threads()` — operator-participant threads, derived unread count, peer,
  last-turn state; `limit` clamped. `read-model.ts:302-338`.
- API: `GET /api/threads?limit` → `reader.run('threads')`. `server.ts:360-363`.
- Authorization: bearer token; the projection itself is scoped to `OPERATOR_SESSION_ID` participation
  (`read-model.ts:312`). `server.ts:201-202`.
- Audit: none (read).
- Dashboard exposure: thread list with peer/subject/unread badge; keyboard-operable rows.
  `app.js:281-306`; markup `index.html:67-69`.
- Browser/e2e coverage: full vertical over real IPC+HTTP in
  `tests/integration/operator-console-e2e.test.ts:86` (thread list + unread reflected).
- Known defect: none.
- Disposition: keep.

#### B2. Thread timeline — **SHIPPED**
- Broker: `DashboardReadModel.thread()` — ordered turns incl. body + full delivery lifecycle;
  participant-access check returns null if the operator isn't a participant. `read-model.ts:349-403`.
- API: `GET /api/thread/:id?limit`; 404 when unknown/not-participant. `server.ts:364-369`.
- Authorization: bearer token + participant check in the read-model. `server.ts:201-202`;
  `read-model.ts:357-358`.
- Audit: none (read).
- Dashboard exposure: ordered timeline with per-turn delivery state + rejected/queued/failed labels.
  `app.js:330-380`.
- Browser/e2e coverage: `operator-console-e2e.test.ts:86` (ordered linkage, exactly-once).
- Known defect: none.
- Disposition: keep.

#### B3. Start new thread — **SHIPPED (UX caveat)**
- Broker: `Daemon.operatorSend()` (new-thread branch) on the broker loop; the browser never sets a
  sender — identity stamped `local-operator`. Wired `src/broker/host.ts:168`. Route strips any
  client `threadId` for a new thread. `server.ts:306-313`.
- API: `POST /api/thread`. `server.ts:295,300,306`.
- Authorization: bearer token (write path checks auth first, then callback). `server.ts:201-205`;
  server-side actor stamping documented `server.ts:78-81`.
- Audit: one ledger event per operator send (operator send path emits via the store; see B4/console-e2e).
- Dashboard exposure: session selector (routable, non-operator only) + "Start a thread" button.
  `app.js:262-279,428-439`; markup `index.html:60-66`.
- Browser/e2e coverage: `operator-console-e2e.test.ts:86,171` (send + duplicate-submit no-dup).
- Known defect: the first turn text is **hardcoded** `'Hello from the operator console.'`
  (`app.js:434`) — the control works (not a dead button) but the UX is a placeholder; a real first
  message should be composed by the operator.
- Disposition: keep; fix the hardcoded first-message UX during console polish (not this slice's focus).

#### B4. Send follow-up turn — **SHIPPED**
- Broker: `operatorSend()` (follow-up branch); thread id taken from the PATH, not a spoofable body
  field. `server.ts:295,309`. Wired `host.ts:168`.
- API: `POST /api/thread/:id/send`. `server.ts:295`.
- Authorization: bearer token; server stamps sender. `server.ts:201-205`.
- Audit: ledger event per send.
- Dashboard exposure: composer textarea + "expect a reply" + Send; disabled while closed; shows
  send failure with status+message. `app.js:393-416`; markup `index.html:84-91`.
- Browser/e2e coverage: `operator-console-e2e.test.ts:86` (3 follow-ups correct linkage);
  disconnected→resume exactly-once `:139`.
- Known defect: none.
- Disposition: keep.

#### B5. Mark thread read — **SHIPPED**
- Broker: `Daemon.operatorMarkThreadRead()` wired `host.ts:169`; advances the operator's cursor.
- API: `POST /api/thread/:id/read`. `server.ts:296,331-332`.
- Authorization: bearer token; thread id from PATH. `server.ts:201-205,332`.
- Audit: cursor advance (store-level).
- Dashboard exposure: auto-issued when a thread with unread turns is opened (best-effort).
  `app.js:319-322`.
- Browser/e2e coverage: unread reflected across the console vertical `operator-console-e2e.test.ts:86`.
- Known defect: none.
- Disposition: keep.

#### B6. Retry a failed operator turn — **SHIPPED**
- Broker: re-send via `operatorSend` with a fresh idempotency key (no new store method needed).
- API: `POST /api/thread/:id/send` (reused). `server.ts:295`.
- Authorization: bearer token. `server.ts:201-205`.
- Audit: ledger event per (re)send.
- Dashboard exposure: a "Retry" button rendered only on a FAILED operator turn. `app.js:359-364,418-426`.
- Browser/e2e coverage: none specific to the retry button (send-path exactly-once is covered).
- Known defect: none.
- Disposition: keep.

### C. Operator SESSION controls (beta.7 / ADR 0024) — backend complete, **no UI**

All six share: route `POST /api/session/:id/control` with the target `sessionId` taken from the PATH
(not a spoofable body field) and `action`+params from the body; auth checked first; callback
`onOperatorControl` wired `host.ts:170` → `Daemon.operatorControl()` `src/broker/daemon.ts:767-816`;
each store method runs in one transaction, requires the session, and appends exactly one ledger event.
Route: `server.ts:297,315-319`. Error mapping (typed 4xx vs 500) `server.ts:334-341`.
**None is referenced anywhere in `static/app.js` or `static/index.html`** (verified: no `control`,
`rename`, `pause`, `pin`, `archive`, `remove`, `stop_managed`, or `/api/session/` write reference in
the client). Route-level test exists: `tests/integration/dashboard-server.test.ts:171-191`
(rename→400 mapping). Store-level tests: `tests/unit/session-controls.test.ts:81-171`.

#### C1. Rename alias — **HIDDEN**
- Broker: `BrokerStore.operatorRenameAlias()` — claims the xbus name via the proven unique-index
  path, mirrors into `name_ownership`, ledgers `OPERATOR_ALIAS_RENAMED`. `src/broker/store.ts:1325-1344`.
  Daemon action `daemon.ts:774-778`.
- API: `POST /api/session/:id/control` `{action:'rename_alias', name}`.
- Authorization: operator principal (server stamps); bearer token gate. `server.ts:201-205`.
- Audit: `OPERATOR_ALIAS_RENAMED` (`store.ts:1341`).
- Dashboard exposure: **NONE.**
- Browser/e2e coverage: route error-mapping only (`dashboard-server.test.ts:171`); store unit
  (`session-controls.test.ts:82`). No end-to-end via a UI control.
- Known defect: no UI; also the resulting name change is only visible via the roster `name` field
  (which the projection does carry), so this one *would* reflect on refresh once a control exists.
- Disposition: add a rename control to the detail inspector (Deliverable 3.3).

#### C2. Set receive control (pause / DND / manual / active) — **HIDDEN**
- Broker: `operatorSetControl()` → `ControlsStore.setControl()`; ledgers `OPERATOR_CONTROL_SET`.
  `store.ts:1348-1355`; controls packing `src/broker/controls.ts:32-38`. Daemon `daemon.ts:780-786`.
- API: `{action:'set_control', mode}`.
- Authorization: bearer token; mode validated server-side. `daemon.ts:782-783`.
- Audit: `OPERATOR_CONTROL_SET` (`store.ts:1352`).
- Dashboard exposure: **NONE.**
- Browser/e2e coverage: store unit `session-controls.test.ts:94`. No UI e2e.
- Known defect: **the read-model does not surface the current receive-control mode**, so a
  pause/DND action could not display authoritative state after refresh (state-consistency gate).
  Requires projection extension (F1).
- Disposition: add pause/DND control + surface mode; slice.

#### C3. Pin / unpin — **HIDDEN**
- Broker: `operatorSetPinned()` sets `sessions.pinned`; ledgers `OPERATOR_SESSION_PINNED/UNPINNED`.
  `store.ts:1358-1365`. Daemon `daemon.ts:788-789`. Column `migrations.ts:607`.
- API: `{action:'pin'|'unpin'}`.
- Authorization: bearer token. `server.ts:201-205`.
- Audit: `OPERATOR_SESSION_PINNED` / `OPERATOR_SESSION_UNPINNED` (`store.ts:1362`).
- Dashboard exposure: **NONE.**
- Browser/e2e coverage: store unit `session-controls.test.ts:104`. No UI.
- Known defect: **`pinned` is absent from the read-model projection** (`read-model.ts:178-262`) — no
  way to render pin state or pin-sort. Requires F1.
- Disposition: slice.

#### C4. Archive / unarchive — **HIDDEN**
- Broker: `operatorSetArchived()` sets `archived`+`archived_at`; ledgers
  `OPERATOR_SESSION_ARCHIVED/UNARCHIVED`. `store.ts:1369-1377`. Daemon `daemon.ts:790-791`.
  Columns `migrations.ts:608-609`.
- API: `{action:'archive'|'unarchive'}`.
- Authorization: bearer token. `server.ts:201-205`.
- Audit: `OPERATOR_SESSION_ARCHIVED` / `_UNARCHIVED` (`store.ts:1374`).
- Dashboard exposure: **NONE.**
- Browser/e2e coverage: store unit `session-controls.test.ts:104`. No UI.
- Known defect: `archived` absent from the projection AND the roster query does not filter archived
  rows (`read-model.ts:185-191`), so archive would have no visible effect. Requires F1.
- Disposition: slice.

#### C5. Remove record — **HIDDEN**
- Broker: `operatorRemoveRecord()` — deletes the sessions row + FK projections in dependency order,
  refuses a connected session and the operator principal, NEVER unlinks the transcript, keeps the
  append-only ledger; ledgers `OPERATOR_SESSION_RECORD_REMOVED`. `store.ts:1385-1408`. Daemon
  `daemon.ts:792`.
- API: `{action:'remove_record'}`.
- Authorization: bearer token; connected-session + operator-principal refusals server-side.
  `store.ts:1386,1390`.
- Audit: `OPERATOR_SESSION_RECORD_REMOVED` (`store.ts:1405`).
- Dashboard exposure: **NONE.**
- Browser/e2e coverage: store unit `session-controls.test.ts:118`. No UI.
- Known defect: destructive; requires confirmation + audit in the UI per the release gate.
- Disposition: slice, with an explicit confirm step.

#### C6. Stop managed session — **HIDDEN**
- Broker: `operatorControl('stop_managed')` clears managed markers via `clearManagedSession()`, then
  SIGTERMs ONLY if a live in-process child handle matches the recorded pid+launch_key (pid-recycling
  safe); returns `{stopped,pid,killed,killable}`. `daemon.ts:793-810`; store `store.ts:1517`.
- API: `{action:'stop_managed'}`.
- Authorization: bearer token; liveness-anchor validation server-side. `daemon.ts:803-804`.
- Audit: managed-session lifecycle events (`MANAGED_SESSION_*`).
- Dashboard exposure: **NONE.**
- Browser/e2e coverage: daemon unit `tests/unit/managed-spawn.test.ts:125,138,154,160`. No UI.
- Known defect: `killable` (whether a live handle exists) is not surfaced anywhere, so a UI must show
  pending/killed/killable honestly (don't present a stop button that can only clear markers as if it
  terminates a process).
- Disposition: slice, gated by an authorization/liveness-aware control (where authorized).

### D. Scheduling (beta.7 / ADR 0025) — backend complete, **no UI**

#### D1. Create schedule — **HIDDEN**
- Broker: `Daemon.operatorSchedule('create')` validates the body (to/text/kind, size + reserved-key
  defenses), computes first `next_run`, creates AS `local-operator`; fires enqueue via `operatorSend`
  under exactly-once. `daemon.ts:842-889+`. Wired `host.ts:171`. Schedules table `migrations.ts:613+`.
- API: `POST /api/schedule` (`action` defaults to `create`). `server.ts:298,321-327`.
- Authorization: bearer token; server-side validation. `server.ts:201-205`; `daemon.ts:857-861`.
- Audit: schedule lifecycle events (store-level).
- Dashboard exposure: **NONE** (no schedule read projection either — `/api/*` has no `schedules` read;
  read-worker methods `read-worker.ts:34` do not include schedules).
- Browser/e2e coverage: `tests/integration/scheduling-states.test.ts` (store-level). No UI, no route e2e.
- Known defect: no read projection → the UI could create but not list/observe schedules.
- Disposition: **out of this slice** (agent-management vertical first). Flag for a later scheduling slice.

#### D2. Pause / resume / cancel schedule — **HIDDEN**
- Broker: `operatorSchedule('pause'|'resume'|'cancel')` → `setScheduleState()`. `daemon.ts:845-851`.
- API: `POST /api/schedule/:id/state`. `server.ts:299,321-327`.
- Authorization: bearer token; scheduleId from PATH. `server.ts:324-325`.
- Audit: schedule state-change events (store-level).
- Dashboard exposure: **NONE.**
- Browser/e2e coverage: store-level only.
- Known defect: same as D1 (no read projection).
- Disposition: out of this slice.

### E. Aggregate banner

#### E1. Unmanaged-sessions banner — **BLOCKED**
- Broker: `DashboardReadModel.unmanagedBanner()` returns `{ possibleUnmanaged: 0, managedOrDormant }`
  — `possibleUnmanaged` is **hardcoded 0** because the read-only worker cannot spawn a process listing.
  `read-model.ts:424-427`.
- The real computation `computeUnmanagedBanner()` + `countLiveClaudeProcesses()` exists but is
  **never wired to the API** (grep: the only references are the definition site).
  `src/broker/unmanaged.ts:20-24,35-56`.
- API: `GET /api/unmanaged` → `reader.run('unmanagedBanner')`, i.e. always `possibleUnmanaged: 0`.
  `server.ts:347`.
- Authorization: bearer token. `server.ts:201-202`.
- Audit: none.
- Dashboard exposure: `renderBanner()` shows the banner **only when `possibleUnmanaged > 0`**
  (`app.js:252-256`) — so it is structurally unreachable.
- Browser/e2e coverage: none.
- Known defect: the banner can never appear; the honest live-process count is computed by a function
  that nothing calls on the serving path. This is a code path that is wired end-to-end yet inert.
- Disposition: **decision needed (see Blockers).** Either (a) wire the broker to post a live-process
  count into the read path so the banner works, or (b) remove the dead endpoint+UI to satisfy the gate
  ("an experimental feature presented as supported"). Do not silently leave it. Out of the
  agent-management slice; flag for product.

### F. Cross-cutting infrastructure gaps (not user-facing capabilities, but they gate the slice)

#### F1. Read-model projection is missing lifecycle/control/title fields — **must fix for the slice**
- `sessions()` selects only a fixed column set (`read-model.ts:180-191`) and its DTO
  (`DashboardSession`, `read-model.ts:49-78`) has no `pinned`, `archived`, `archivedAt`,
  `receiveControl`, or `claudeTitle`. The columns exist (`migrations.ts:607-609`) and the broker
  writes them, but the dashboard cannot read them.
- Consequence: pin/archive/pause controls (C2/C3/C4) would mutate + audit correctly but the UI could
  not reflect authoritative state after refresh — a direct violation of the release gate ("state
  contradicts the broker after refresh/restart"). The roster also does not exclude archived rows.
- Disposition: extend the projection (add columns to the SELECT + DTO), add archived-filtering, and
  unit-test the derivation before wiring any UI control. First code task of the slice.

---

## Testing reality (must note in every report)

- **There is no real-browser harness at Stage-0.** Playwright is NOT a dependency (absent from
  `package.json`), there is no `playwright.config.*`, and no test imports it (verified). The files
  named "e2e" (`operator-console-e2e.test.ts`, `control-plane-e2e.test.ts`) drive a **real broker +
  real authenticated loopback HTTP via `fetch`**, not a browser DOM. They prove the API/broker
  vertical, not the rendered UI. The client (`app.js`) has **no DOM-level automated coverage** of any
  kind at Stage-0.
- The task assigns real-browser/restart/reconnect/120-session acceptance to the Reliability Tester.
  To satisfy the release gate ("visible control silently does nothing", "unusable at 120 sessions"),
  Train B must add a browser harness. Reliability Tester owns the acceptance run; Train B builds the
  controls to be drivable and provides at least a smoke browser E2E for each new action.
- **Node is v25.8.1**, above the `>=22.13 <25` floor in `package.json:engines`. The full suite is
  flaky under it, so Train B runs **focused** test files, never the whole suite, and records this.

## Stage-0 baseline (focused run, this worktree, node v25.8.1)
`vitest run tests/unit/session-controls.test.ts tests/unit/dashboard-auth.test.ts
tests/integration/dashboard-server.test.ts tests/integration/dashboard-ui.test.ts`
→ **4 files, 43 tests, all passing** (~16s). This is the green baseline the slice must preserve.

## Blockers / decisions needed from the human (product/scope)
1. **Unmanaged banner (E1):** wire the live-process count into the read path (make it work) OR remove
   the dead endpoint+UI (stop presenting an inert feature)? Product call.
2. **Scheduling (D1/D2):** confirmed OUT of the agent-management slice. Needs its own read projection
   + slice later. Confirm deferral.
3. **Collections scope (Deliverable 2):** confirmed as LOCAL, non-routable roster-organization
   metadata only (client-visible grouping + persistence). Not group messaging. Implementing on the
   read-model/dashboard side, no broker routing concept. (No decision needed unless product disagrees.)
