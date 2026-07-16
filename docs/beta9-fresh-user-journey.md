# Fresh-user journey — verified behavior (beta.9)

This document records the fresh-user path **only from behavior directly verified** during beta.9
development on a Windows host (real Node 22.23.1; and, where noted, a global Node 25 first on PATH
and a no-system-Node configuration). It is not aspirational — each step below was run.

The one-command entry point is `agentel verify`. The product is Windows-first and PATH-free: there
is no global `agentel` on PATH; you invoke the CLI as `node <checkout>/dist/cli/main.js <cmd>` (or
via the installed launcher). `xbus`/`xclaude` remain working deprecated aliases.

## 1. Clone → verify (the TRUE one-command entry point)

From a fresh clone, with only an unsupported Node (e.g. global Node 25) on PATH, ONE command:

```
git clone <repo> && cd <repo>
node scripts/agentel.mjs verify
```

`scripts/agentel.mjs` is the committed bootstrap (Node built-ins only; imports nothing from
`dist/`). It runs under any Node without the product floor, then provisions a COMPLETE approved
Node 22/24 runtime (env override `AGENTEL_VERIFY_NODE` → pre-vendored `.agentel/node` → download the
pinned official Node ZIP into `.agentel/cache`, verify its committed SHA-256, extract atomically
into `.agentel/node`), runs `npm ci` + `npm run build` on it, then re-execs the real `agentel
verify` under it. No admin / NVM / PATH edit / manual download; offline once cached; concurrency-safe;
recovers from interrupted downloads/extractions; fails closed with exact proxy/TLS remediation.

(If you already have an approved Node 22/24 and a built `dist/`, `node dist/cli/main.js verify`
works directly — but the bootstrap above is the fresh-clone path that needs nothing preinstalled.)

`agentel verify` then runs, in order, each stage tagged with a failure CLASS:

| Stage | Class | What it does |
|---|---|---|
| resolve-approved-runtime | environment | Locate an approved Node (full dist + npm, in `[22.13, 25)`) with NO dependence on global Node/npm/NVM/PATH order. Precedence: `AGENTEL_VERIFY_NODE` → vendored `.agentel/node/` → the current in-floor process → fail closed. |
| runtime-completeness | environment | Confirm the resolved dist ships the `npm`/`npx` CLI shims the test fixtures spawn by name. Fails closed upfront (not deep in a shard) if an incomplete dist would be used for the full run. |
| npm ci | environment | Install deps on the approved runtime. |
| build (tsc) | repo-policy | Compile. |
| release-gate (verify:release) | repo-policy / test / packaging | lint, typecheck, shard-coverage, all test shards (unit/security/integration/e2e/adapter-sdk), packaging, deterministic-ZIP. |
| npm audit --omit=dev | security | Dependency vulnerability scan. |
| clean-machine acceptance | product | install → doctor → two-session send/ack/reply → durable-identity reclaim → uninstall, through INSTALLED files. |
| governance evidence | repo-policy | (opt-in repos only) stamp `.preflight/gate/` evidence after a pass. |

On success it prints the reproducible artifact SHA-256 and writes `.agentel/verify-report.json`
(a machine-readable report). It fails closed with a precise, class-tagged remediation.

**Verified:**
- **Global Node 25 first on PATH** — `agentel verify` runs (the entry Node-floor guard exempts
  `verify`/`release-check`/`govern`), the resolver rejects Node 25 and selects an approved Node 22,
  and the full gate passes 6/6 (release-gate 15/15, 914+ tests, npm audit 0, clean-machine + reclaim
  PASS).
- **Fresh clone, no system Node, one command** — `node scripts/agentel.mjs verify` launched under
  Node 25 in a clean copied checkout (no `dist/`, no `node_modules/`, empty `.agentel/`) PROVISIONS
  a complete approved Node 22 (SHA-verified pinned ZIP → atomic extract), installs, builds, and
  completes all verify stages. Proven by `scripts/accept-bootstrap.mjs` (15 checks): fresh-clone
  provision, offline cached run, corrupted-ZIP rejection, wrong-SHA rejection, partial-extraction
  recovery, incomplete-runtime fail-closed, `AGENTEL_VERIFY_NODE` override, and writes-only-under-
  `.agentel`.
- **Repo stays clean** — verify writes only under gitignored `.agentel/`; `git status` after a run
  shows no tracked changes.
- **Idempotent / reproducible** — two separate `agentel release-check` runs print an identical
  artifact SHA-256.

## 2. install → doctor → start → two sessions → message → restart → recover → dashboard → uninstall

The clean-machine acceptance (`scripts/clean-machine-accept.mjs`, driven by `agentel verify`)
exercises this end to end through INSTALLED files with a fake host (never the real `claude`):

- **install** (PATH-free) → all required installed files present.
- **doctor** → green (installed-plugin contract valid).
- **start / launcher** → resolves the installed plugin; uses the bundled runtime.
- **two sessions** → register aliases; session A sends to B; B receives once, acks, replies; A
  gets the correlated reply. (Verified: TWO_SESSION_EXCHANGE_PASS.)
- **restart / recover identity** → recipient killed with a queued message; a successor under a NEW
  session id auto-reclaims the durable name + inherits the stranded inbox and acks/replies exactly
  once, with no sender resend. (Verified: IDENTITY_RECLAIM_ACCEPT_PASS, through the installed MCP +
  broker over stdio, and also against the extracted release artifact via its own bundled node.)
- **dashboard** → serves the control-plane view (Queued/Delivered/ACK/Replied/Failed columns);
  read-only worker opens the DB with a physically read-only handle.
- **uninstall** → removes only manifest-owned files; unrelated files + data preserved by default.

## 3. What still requires a human (not agent-verifiable)

- A **real interactive Claude Code** session for the `/clear` + compact live legs of the lifecycle
  (the automated proof covers the same session-id-change reclaim path with a scripted host).
- **Publishing**, downloading the published asset + SHA compare, reinstalling the download, and the
  **repo rename** — outward-facing GitHub actions.

These are enumerated with exact commands in the release runbook.

## Notes

- Windows needs `System32` on PATH for `npm run-script` to spawn `cmd.exe`; a literally-empty PATH
  is not a real machine and is not supported. "No system Node" means no Node on PATH, not empty PATH.
- A vendored `.agentel/node/` must be a COMPLETE Node dist (include `npm.cmd`/`npx.cmd`), or the
  runtime-completeness stage will fail closed with that exact guidance before the test shards run.
