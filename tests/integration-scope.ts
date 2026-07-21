/**
 * BETA.10 hosted-CI scope classification (Option A). SINGLE SOURCE OF TRUTH for which integration
 * tests run on the hosted Ubuntu lane vs stay local-Windows/Release-only.
 *
 * Every file in tests/integration/ MUST appear in exactly one of the two lists below; the guard
 * test (tests/integration/hosted-scope-guard.test.ts) FAILS if any integration test is unclassified
 * or classified twice — so a NEW integration test cannot silently fall into an undefined category.
 *
 * The hosted vitest config (vitest.hosted.config.ts) includes ONLY HOSTED_SAFE — an explicit
 * include-list (FAIL-CLOSED): a new/unclassified test is simply NOT run on the hosted lane and the
 * guard fails loudly, rather than being swept into the hosted run where it could re-break CI.
 *
 * Classification rubric (docs/ci-scope.md): HOSTED_SAFE = OS-agnostic, temp-SQLite + in-process
 * broker/store/delivery/migration/dashboard-server, no admin, no real network, no `.cmd`, no
 * artifact assembly/validation, no real install/migration/rollback dir, no real long-lived broker/
 * managed-child/recycled-PID timing, no real-browser. Everything else is LOCAL_WINDOWS_OR_RELEASE_ONLY
 * (still collected + run + required on the Windows / Reliability / Release-Engineer lanes via the
 * full `test:integration` — it is NOT skipped there; the hosted lane merely does not SELECT it).
 *
 * Cross-validated against the real Ubuntu CI run 29801162604: every HOSTED_SAFE entry PASSED on
 * Ubuntu; the four real failures (artifact-first-install, install-db-rollback, installer,
 * install-user-scope) are all LOCAL; the four never-run files (bundled-installer[-acceptance],
 * bundled-runtime, xclaude-launcher) are Windows-only describe.runIf(isWin) and are LOCAL.
 */

/** Runs on the hosted Ubuntu lane (and locally). OS-agnostic, in-process, no artifact/Windows deps. */
export const HOSTED_SAFE_INTEGRATION: readonly string[] = [
  'activation-diagnose.test.ts',
  'adapter-conformance.test.ts',
  'adapter-registration-enforcement.test.ts',
  'beta3-to-beta4-upgrade.test.ts',
  'beta4-pr4-composition.test.ts',
  'beta4-pr4-expiry-award.test.ts',
  'broker-durability.test.ts',
  'broker-flow.test.ts',
  'build-identity.test.ts',
  'collections-api.test.ts',
  'component-churn.test.ts',
  'content-scan.test.ts',
  'd7-ledger-atomicity.test.ts',
  'dashboard-no-unmanaged.test.ts',
  'dashboard-server.test.ts',
  'dashboard-server-error-resilience.test.ts',
  'dashboard-thread-endpoints.test.ts',
  'dashboard-ui.test.ts',
  'data-migration.test.ts',
  'deadletter-cancel.test.ts',
  'epoch-fencing.test.ts',
  'hook-mcp-coordination.test.ts',
  'hosted-scope-guard.test.ts',
  'identity-map-lifecycle.test.ts',
  'inbox-dedup.test.ts',
  'injection-id-retry.test.ts',
  'injection-ledger.test.ts',
  'ledger-operability.test.ts',
  'legacy-cli-dataroot.test.ts',
  'mcp-checkpoint-activity.test.ts',
  'meaningful-activity.test.ts',
  'metrics-counters.test.ts',
  'non-ack-redelivery.test.ts',
  'operator-console-e2e.test.ts',
  'operator-redeliver.test.ts',
  'ownership-atomicity.test.ts',
  'ownership-primitive.test.ts',
  'reliability-matrix.test.ts',
  'remove-record-no-orphan.test.ts',
  'reply-pending-orphan.test.ts',
  'scheduling-states.test.ts',
  'session-expiry.test.ts',
  'session-identity-reclaim.test.ts',
  'session-identity-reclaim-fix.test.ts',
  'session-names.test.ts',
  'session-readiness.test.ts',
  'shard-coverage.test.ts',
  'stage0-d7-ledger.test.ts',
  'stale-socket-recovery.test.ts',
  'status-identity.test.ts',
  'version-handshake.test.ts',
];

/**
 * Stays on the local-Windows / Reliability / Release-Engineer lane (run there via full
 * `test:integration`). Each entry has a reason tied to a docs/ci-scope.md exclusion class.
 */
export const LOCAL_ONLY_INTEGRATION: ReadonlyArray<{ file: string; reason: string }> = [
  { file: 'artifact-first-install.test.ts', reason: 'Artifact/release + real broker spawn + Windows .cmd launcher (failed on Ubuntu).' },
  { file: 'broker-client-churn-survival.test.ts', reason: 'Broker/managed-child timing repro (real dashboard broker + worker_thread + socket churn).' },
  { file: 'broker-shutdown.test.ts', reason: 'Recycled-PID / process-creation-time liveness classification (definitional exclusion).' },
  { file: 'bundled-installer.test.ts', reason: 'Windows-only describe.runIf(isWin): runs install.ps1 via PowerShell.' },
  { file: 'bundled-installer-acceptance.test.ts', reason: 'Artifact + Windows-only: assembles a real package-win artifact then install.ps1 e2e.' },
  { file: 'bundled-runtime.test.ts', reason: 'Artifact assembly: buildPackage stages runtime/node.exe + SHA256SUMS; needs dist/.' },
  { file: 'cli-scripts.test.ts', reason: 'Artifact/release: runs package:win CLI child to emit a real artifact; needs dist/.' },
  { file: 'clean-profile-lifecycle.test.ts', reason: 'Broker/process + process-creation-time liveness (spawns a real broker host).' },
  { file: 'control-plane-e2e.test.ts', reason: 'Broker/managed-child: real long-lived broker + live dashboard HTTP + worker_thread + real socket.' },
  { file: 'dashboard-agent-controls-e2e.test.ts', reason: 'Broker/managed-child: spawns a real long-lived broker host.' },
  { file: 'doctor-activation-contract.test.ts', reason: 'Spawns the compiled dist CLI child (doctor --json); needs dist/.' },
  { file: 'degraded-secret-startup.test.ts', reason: 'Broker/process: spawns real child processes of compiled dist entrypoints.' },
  { file: 'four-replica-matrix.test.ts', reason: 'Broker/managed-child: real long-lived broker + real IPC; 120s budget, timing-sensitive.' },
  { file: 'idle-wake.test.ts', reason: 'Broker/managed-child: real long-lived broker + rewaker on real wall-clock polling.' },
  { file: 'install-db-rollback.test.ts', reason: 'Real install() + snapshot/migrate/rollback dir; needs dist/ (failed on Ubuntu).' },
  { file: 'install-user-scope.test.ts', reason: 'Real install() (validateArtifact + icacls) + launches installed entry (failed on Ubuntu).' },
  { file: 'installer.test.ts', reason: 'Real install/uninstall + spawns compiled CLI child; needs dist/ (failed on Ubuntu).' },
  { file: 'packaging.test.ts', reason: 'Artifact/release: buildPackage release-artifact assembly; CI must not mutate artifacts.' },
  { file: 'perf-objectives.test.ts', reason: 'Broker/process + p95 latency assertions; flaky on loaded hosted runners.' },
  { file: 'production-start-e2e.test.ts', reason: 'Broker/managed-child: real broker child via installed CLI + dashboard HTTP.' },
  { file: 'release-zip.test.ts', reason: 'Artifact/release: package:release-zip + build-twice reproducibility.' },
  { file: 'session-start-hook-e2e.test.ts', reason: 'Broker/managed-child: spawns the compiled dist hook child + real long-lived broker.' },
  { file: 'session-start-lifecycle.test.ts', reason: 'Broker/process: real long-lived BrokerDaemon + real IPC round-trips.' },
  { file: 'singleton.test.ts', reason: 'Broker/process + recycled/stale-PID liveness: real brokers, 10-way race, ACL hardening.' },
  { file: 'split-brain.test.ts', reason: 'Broker/process: real long-lived broker + real IPC sessions + connection-close timing.' },
  { file: 'sqlite-crash.test.ts', reason: 'Broker/process + kill-timing: spawns dist CLI broker child + SIGKILL WAL recovery.' },
  { file: 'xclaude-launcher.test.ts', reason: 'Artifact-first install + .cmd/where.exe/cmd.exe launcher (Windows-only).' },
];
