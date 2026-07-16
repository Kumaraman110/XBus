# ADR 0029 — beta.9: frictionless operations (`agentel verify`, `release-check`, opt-in governance)

**Status:** Proposed (beta.9)
**Goal:** make install, verification, release, and governance usable WITHOUT manual environment
repair — no manual Node download, no PATH edit, no NVM. One command after cloning: `agentel verify`.

## Problem

Through beta.8, verifying a checkout required an operator to know that the machine's PATH `node`
(v25 here) is outside the supported floor `[22.13, 25)`, to locate a pinned Node 22, and to run
each gate through it by hand (the whole beta.8 acceptance was driven via a hand-pinned
`node22/node.exe` launcher). That is expert-only friction. It also meant a global preflight push
gate — designed for a different (dotnet) repo — intercepted this repo's pushes and demanded
evidence it could never legitimately produce.

## Decision

Three additions, all pure-Node, no new runtime dependencies, Windows-first.

### 1. Approved-runtime resolution (`src/tools/runtime-resolver.ts`)

A single PURE decision function resolves an APPROVED development runtime — a full Node dist
(interpreter **plus npm**) whose version is in `[22.13, 25)` — independent of global Node/npm/NVM/
PATH ordering. Precedence, highest first:

1. `AGENTEL_VERIFY_NODE` / `XBUS_VERIFY_NODE` — explicit path (operator/CI override).
2. repo-vendored dist `<repo>/.agentel/node/node[.exe]` — zero PATH dependence.
3. the CURRENT process runtime (`process.execPath`) IFF in-floor AND npm resolvable — the common
   clean-clone case (you already launched with an in-floor Node; reuse it, no download).
4. FAIL CLOSED with actionable remediation naming every avenue checked.

The product's BUNDLED `runtime/node.exe` is interpreter-only (no npm) and is deliberately NOT a
dev runtime — it runs the installed broker/CLI, it cannot `npm ci` or build.

**Runtime completeness (no-system-Node correctness).** `npm ci` / `npm audit` / build all run via
`node <npm-cli.js>` and need NO CLI shims. But the integration + acceptance test FIXTURES spawn
child processes that shell out to `npm`/`npx` BY NAME, so on a machine with no other Node, a runtime
resolved from an INCOMPLETE vendored dist (`node.exe` + `node_modules` but no `npm.cmd`/`npx.cmd`)
would pass deps+build and then fail deep inside the test shard with a confusing error. The resolver
therefore records `runtimeComplete` (are the platform shims present next to the binary?), and
`agentel verify` has a dedicated `runtime-completeness` stage that FAILS CLOSED upfront with an
actionable message ("vendor a COMPLETE dist, or set AGENTEL_VERIFY_NODE to a complete dist") when
the full test/acceptance run would otherwise hit it. With `--skip-acceptance` an incomplete dist is
accepted (no fixture spawns npm/npx). Empirically confirmed: the same integration shard that fails
under a partial vendored dist passes 415+/418 under a COMPLETE vendored dist with no system Node.

### 2. `agentel verify` (`src/tools/verify.ts`)

One command: resolve runtime → `npm ci` on it → build → full release gate (`verify:release`:
lint/typecheck/shard-coverage/all shards/packaging/deterministic-zip) → `npm audit --omit=dev` →
clean-machine + identity-reclaim acceptance → machine-readable report at `.agentel/verify-report.json`.

Every stage is tagged with a FAILURE CLASS so a caller knows WHY it failed without reading logs:
`environment | repo-policy | test | security | product | packaging`. Fails closed with a precise
per-class remediation. IDEMPOTENT: writes only under `.agentel/` (gitignored) + OS temp — a rerun
never dirties the tree.

### 3. `agentel release-check` (`src/tools/release-check.ts`)

Fast pre-tag readiness: confirms a clean tree, builds the artifact staging TWICE, proves the
deterministic ZIP is byte-identical across builds, and prints BOTH SHAs — the runtime-free SHA
(what a bare `verify:release` reports) and the **bundled-runtime SHA (the PUBLISHABLE asset)** when
`--bundled-node <vetted-node.exe>` is supplied (its bytes are checked against the pinned
`BUNDLED_NODE_SHA256`). Self-reports NOT READY on a dirty tree.

### 4. Opt-in governance (`src/tools/governance.ts`)

Governance is INERT unless a repo opts in with `.agentel/governance.json`. This is the deliberate
fix for the beta.8 cross-repo failure: a global hook must never silently gate an unrelated repo.

- **Reviewer discovery + install** — find a `code-reviewer.md` Stage-1 reviewer (env override →
  `.claude/agents/` → `agents/` → caller-supplied dirs) and install it into the repo's
  session-visible `.claude/agents/` so `subagent_type:'code-reviewer'` resolves NEXT session
  (agent defs load at session start). Idempotent (byte-identical → no rewrite).
- **Evidence emission** — after a PASSING `agentel verify` in a governed repo, stamp
  `.preflight/gate/<name>` files in the EXACT format the preflight `pre-push-gate` reads
  (`GATE=`/`HEAD=<sha>`/`TIMESTAMP=`/`SOURCE=agentel-verify`), so a governed repo's push gate
  recognizes a genuine AgenTel verification instead of demanding a foreign test run. It REFUSES to
  write evidence for a failing verify (no fabrication).

CLI surface: `agentel govern [status|install-reviewer]`.

## Compatibility

Additive only. No wire/on-disk/schema change (no migration). `xbus verify`/`xbus release-check`/
`xbus govern` work via the deprecated alias. No new production dependency (governance + verify use
only Node built-ins + the existing verify:release/packaging tools).

## What this does NOT do

- It does not download Node (the resolver LOCATES an approved runtime or fails closed with how to
  supply one; a future enhancement could fetch-and-pin into `.agentel/node/`).
- It does not modify any foreign framework's files; governance only reads its own opt-in config and
  writes its own repo's `.preflight/gate/` evidence.
- It does not change the product's runtime behavior, identity model, scheduler, or dashboard.
