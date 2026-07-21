# CI scope — what hosted GitHub Actions runs, and what stays local (beta.10)

Hosted CI (`.github/workflows/ci.yml`) exists so stable-1.0 verification does not depend
EXCLUSIVELY on the local multi-agent gate. It runs the **hosted-safe** subset on a clean ephemeral
Ubuntu runner under the approved Node (`22.13.x`, within the `>=22.13 <25` floor).

## Runs in hosted CI
- `npm ci` (locked install), `typecheck`, `lint`, `build`
- `test:unit` — pure/unit shards (entirely OS-agnostic; whole `tests/unit` dir)
- HOSTED-SAFE **integration** shards ONLY — the broker/store/delivery/migration/dashboard-server
  shards that are OS-agnostic and use a temp SQLite DB + in-process broker (no admin, no real
  network, no `.cmd`, no artifact assembly, no real install). Selected by an **explicit allow-list**,
  NOT the whole `tests/integration` dir (see Enforcement below).
- `npm audit --omit=dev --audit-level=high`

## Enforcement (how the hosted scope is made exact — beta.10 Option A)
The hosted lane does NOT run `npm run test:integration` (whole dir). It runs
`npx vitest run --config vitest.hosted.config.ts`, whose `include` is the explicit
`HOSTED_SAFE_INTEGRATION` list in `tests/integration-scope.ts` (the single source of truth: every
integration test is classified `HOSTED_SAFE` or `LOCAL_ONLY` + reason). This is **fail-closed**: a
new/unclassified integration test is NOT selected on the hosted lane, and the drift guard
`tests/integration/hosted-scope-guard.test.ts` (itself hosted-safe) FAILS until it is classified —
so a test can never silently fall into an undefined category. The full `test:integration` (whole
dir) is UNCHANGED and remains the Windows / Reliability / Release-Engineer lane: the local-only
shards below are still collected, run, and required there — they are not skipped; the hosted lane
merely does not select them.

## Deliberately NOT in hosted CI (documented exclusions)
- **Windows-only tests** — the secure-IPC ACL suite (`icacls`, named-pipe DACLs) and any
  Windows-path assertion. The product is Windows-first; these are validated locally + by the
  Reliability Tester on Windows. (A future `windows-latest` matrix leg can add them; out of scope
  for the initial hosted gate.)
- **Broker/process/managed-child tests** — anything that spawns a real long-lived broker or a
  managed child process, or depends on process-creation-time / recycled-PID liveness. These are
  timing/OS-sensitive and are covered by the Reliability harness; a hosted runner would be flaky.
- **Artifact / release acceptance** — `package:win`, `package:release-zip`, `verify:release`,
  `accept:clean-machine`, downloaded-artifact install, and reproducibility (build-twice) checks
  remain LOCAL + Release-Engineer-run. Hosted CI must NOT build or mutate release artifacts, and
  must NOT publish — packaging/reproducibility is a separately gated release step bound to an exact
  reviewed SHA, not a per-push CI action.
- **Real-browser Playwright acceptance** — the dashboard E2E runs against a live broker + browser;
  kept in the Dashboard-Builder / Reliability lane (could later move to a hosted browser matrix,
  out of scope now).

## Safety properties (statically reviewed)
- `permissions: contents: read` only — no write/packages/id-token; a compromised step cannot push,
  publish, or mint tokens.
- No `secrets.*` referenced by any step — the gate needs none, so there is no secret to leak.
- `push`/`pull_request` on `main` only; `concurrency` cancels superseded runs.
- Runs in an ephemeral runner with no access to any developer's `~/.claude` — the golden beta.9
  install is physically unreachable from CI.
- CI does not run `postbuild` provenance as a release input; `build` produces `dist/` for tests only.
