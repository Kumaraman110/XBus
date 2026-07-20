# CI scope — what hosted GitHub Actions runs, and what stays local (beta.10)

Hosted CI (`.github/workflows/ci.yml`) exists so stable-1.0 verification does not depend
EXCLUSIVELY on the local multi-agent gate. It runs the **hosted-safe** subset on a clean ephemeral
Ubuntu runner under the approved Node (`22.13.x`, within the `>=22.13 <25` floor).

## Runs in hosted CI
- `npm ci` (locked install), `typecheck`, `lint`, `build`
- `test:unit` — pure/unit shards
- `test:integration` — the broker/store/delivery/migration/dashboard-server integration shards that
  are OS-agnostic and use a temp SQLite DB + in-process broker (no admin, no real network)
- `npm audit --omit=dev --audit-level=high`

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
