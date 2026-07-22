# ADR 0037 — beta.11: reliable durable-identity reclaim for resumed sessions + honest activation + dashboard

**Status:** Accepted (beta.11). Application-level only — **no schema change** (stays schema 11 /
wire `xbus-p1-stp1-s11`; all additive/back-compatible). Preserves credential ownership, name
uniqueness, IPC auth, ledger atomicity, and exactly-once delivery.

## Problem — a resumed session did not reclaim its durable identity

A previously-named Claude Code session (`AccountLookUp`, disconnected) was resumed after upgrading to
beta.10; the resumed session got a NEW Claude session id, landed name=none / pending / hook-only, and
`xbus_rename AccountLookUp` returned a blanket `XBUS_SESSION_NAME_TAKEN`. It should have automatically
reclaimed the disconnected predecessor's durable logical identity (name + inbox + reply-pending
authority) by presenting the persisted owner secret.

Investigation (source + reproduced) found **four independent defects**, all surfacing as
`NAME_TAKEN` / no-reclaim, plus two activation-honesty defects. None required a schema change.

## Root causes + decisions

### C1 — name-anchor mismatch (the user's case): reclaim was never *attempted*
The owner secret is keyed `(projectId, normalize(NAME))`. On resume the MCP server re-derives its
requested name from the **workspace suggestion** (`server.ts`), which is never a user-chosen name like
`AccountLookUp`; and `SESSION_NAME` was only ever *read*, never persisted. So the resume looked the
secret up under the wrong anchor, presented no secret, and `resolveReclaim` was never entered.

**Decision:** persist the awarded/renamed name as a durable-NAME reverse index keyed
`(projectId, agentType)` (`owner-secret-store.ts`: `saveDurableName` / `resolveDurableName`; name only,
never the secret; last-writer-wins by `updatedAt`). On launch the requested-name precedence becomes
**`SESSION_NAME` env → recovered durable name → workspace suggestion** (`server.ts`), so the resume
re-requests the name it actually holds → `loadOwnerSecret` hits → the broker reclaims automatically.
`mcp-server.ts` persists the durable name on award and on rename. Multi-identity caveat: the reverse
index holds one name per `(projectId, agentType)`; a second same-type identity in one workspace falls
back to the workspace suggestion / an explicit `SESSION_NAME` and lands `pending` exactly as before
(the by-name secret store still holds every identity's secret).

### C2 — stale-`live` liveness gate: reclaim of a *crashed* predecessor was refused
`resolveReclaim` refused when `hasLiveMcp(incumbent)` saw a raw `state='live'` mcp component. A
graceful disconnect flips that to `'closed'` (`daemon.onConnClose`), but a hard crash / OOM /
recycled-PID leaves it `'live'`, so a *correct* secret-bearing reclaim of a genuinely dead predecessor
was refused until the 15-day reaper.

**Decision:** gate on **proven** liveness (`hasProvenLiveMcp`, reusing `classifyLiveness`): a
*connected* session with a live mcp component is authoritatively live (never OS-probed — the open
connection is the proof); a *disconnected* session whose mcp row is still `'live'` is cross-checked
against the OS — `proven_dead_or_recycled` → allow the reclaim, `proven_live_broker` or `inconclusive`
→ refuse (fail-closed: never evict a possibly-live incumbent, ADR 0027 D3). The credential check is
unchanged — a wrong/absent secret never reclaims.

### C3 — rename had no secret-gated reclaim: the manual escape hatch also failed
`renameSession` threw a blanket `NAME_TAKEN` against a disconnected durable owner — even a deliberate
manual retry could not recover the name until the reaper.

**Decision:** `rename_session` accepts an OPTIONAL `ownerSecret` (additive wire field; older brokers
ignore it). When the name is held by a different session, `renameSession` runs the same gates as
`resolveReclaim`: valid `owner_secret_hash` + not-proven-live → release the dead/dormant incumbent's
name ownership (through the one release primitive) so this session takes it; wrong secret →
`RECLAIM_CREDENTIAL_INVALID`; secret-less → `NAME_TAKEN` with a precise reason; proven-live → refused.

### C4 — upgrade dataDir relocation stranded the credentials (defense-in-depth)
The beta.9.1→beta.10 upgrade can move the data dir (`~/.claude/xbus` → `<installRoot>/install/data`).
The runtime-DB migration only runs when `decideMigration` returns `migrate`; a legacy root holding
ONLY the credential files (no runtime DB) classifies as "empty" and is not migrated, stranding the
reclaim credentials. (This was *not* the reported user's trigger — `NAME_TAKEN` proved same-dataDir —
but it is a real edge.)

**Decision:** `carryDurableCredentials` copies `owner-secrets.json` + `durable-names.json` from the
legacy root into the canonical one **independent of the migrate verdict**, merging per-entry and never
regressing a fresher canonical record (newer `updatedAt` wins). Best-effort; secrets only ever copied
between the two ACL-protected roots, never logged.

### Discriminated reclaim outcome (UX)
`resolveReclaim` returns a discriminated result; `register` and `rename` surface a precise
`reclaimOutcome` — `reclaim-succeeded` / `credential-missing` / `credential-invalid` / `anchor-mismatch`
/ `predecessor-live` / `unrelated-owns` — instead of collapsing everything into `NAME_TAKEN`.

## Activation honesty

- **Session-id skew (false hook-only):** `diagnoseActivationOnce` keyed on the raw hook-supplied
  session id, but a resumed session's hook keys on `CLAUDE_CODE_SESSION_ID` while the mcp registered
  under the canonical id — so a genuinely connected session was mis-diagnosed `PLUGIN_NOT_LOADED` /
  `DEGRADED_HOOK_ONLY`. **Fix:** resolve the raw id through `physical_session_map` to its canonical id
  before classifying (no map edge → resolves to itself); the once-only audit keys on the canonical id.
- **Misleading remedy under persistent activation:** the plugin-absent remedy always said "run
  `xclaude`", even when `enabledPlugins.xbus=true` means a plain `claude` should load the plugin.
  **Fix:** `classifyActivation` takes a `persistentEnabled` signal; when true the remedy is "start a
  NEW session" (persistent config only affects newly-launched processes), not a launcher switch. The
  Stop hook reads `isPersistentEnabled()` (best-effort, golden-boundary-safe settings path).

## Dashboard

- **Real estate:** the UI was capped at 1080px; grown to `min(1600px, 94vw)` with a full-width roster
  table and a side-by-side console/roster layout on wide viewports.
- **Constellation (three.js companion view):** a new tab renders the same live `/api/sessions` data
  spatially — durable identities as state-colored `InstancedMesh` nodes, project-grouped
  `LineSegments` edges, force-directed relaxation, `OrbitControls`. The dense 2D console stays the
  default operational surface. three.js **r0.185 is vendored same-origin** under
  `static/vendor/three` (the dashboard CSP is `script-src 'self'` — no CDN, fully offline) and
  **lazy-loaded** only when the tab is first opened (the 2D console + headless API never parse the
  WebGL lib); the render loop stops when the tab is hidden. An `importmap` DATA block (CSP-safe under
  `script-src 'self'`) resolves OrbitControls' bare `three` import.
- The reported **"No routable sessions"** dropdown was a *downstream* symptom (a disconnected session
  is `routable:false` by design); fixing reclaim makes resumed sessions reconnect → routable. No
  dashboard routing-logic change was needed.

## Durability (the "session token expires → re-authenticate" friction)
Durable identity already survives expiry — expiry is **dormancy** (ADR 0033): the reaper keeps
`name_ownership.name_state='active'` with the `owner_secret_hash` intact. Combined with C1/C4 (the
credential is now reachable on resume), the credential holder reclaims automatically after expiry with
**no manual re-authentication**.

## Non-goals
No schema/protocol/compat change; no cross-machine / multi-user / federation / RBAC / Codex. Reviewer-
gated. Builder does not self-approve.
