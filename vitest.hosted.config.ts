/**
 * BETA.10 hosted-CI vitest config (Option A). Selects ONLY the hosted-safe INTEGRATION shards for
 * the Ubuntu GitHub-Actions lane, via an EXPLICIT include-list (fail-closed): a new/unclassified
 * integration test is NOT swept into the hosted run — it is simply not selected, and the drift guard
 * (tests/integration/hosted-scope-guard.test.ts, itself hosted-safe) fails loudly until it is
 * classified in tests/integration-scope.ts. This is the correction for the PR-gate failure where the
 * whole tests/integration/ dir ran on Ubuntu and the Windows/artifact shards (install-db-rollback,
 * artifact-first-install, installer, install-user-scope) failed.
 *
 * Scope: this config governs ONLY the hosted integration selection. The hosted job runs unit tests
 * separately via the unchanged `test:unit` (tests/unit is entirely OS-agnostic). The full
 * `test:integration` (whole dir) is UNCHANGED and remains the Windows/local/Reliability/Release lane
 * — the local-only shards are still collected, run, and required there; they are not skipped, the
 * hosted lane merely does not select them.
 *
 * Everything else (pool/forks/timeouts/setup/ssr) is inherited from the base vitest.config.ts so the
 * hosted run behaves identically to local for the shards it does run.
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';
import { HOSTED_SAFE_INTEGRATION } from './tests/integration-scope';

// Inherit everything from the base config (ssr/pool/forks/timeouts/setup) EXCEPT the broad
// include glob, then OVERRIDE include with the explicit hosted-safe allow-list. mergeConfig
// CONCATENATES arrays, so we must strip the base include first — otherwise the base
// `tests/**/*.test.ts` would leak back in and the hosted lane would run the whole tree (defeating
// the allow-list). Deleting base.test.include and setting it in the override yields exactly the 50.
const baseNoInclude = { ...base, test: { ...base.test } };
delete (baseNoInclude.test as { include?: unknown }).include;

export default mergeConfig(
  baseNoInclude,
  defineConfig({
    test: {
      // Explicit allow-list — ONLY these integration files run on the hosted Ubuntu lane.
      include: HOSTED_SAFE_INTEGRATION.map((f) => `tests/integration/${f}`),
    },
  }),
);
