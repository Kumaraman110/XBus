/**
 * Global test setup (§6 + §8). Runs in every vitest worker, so child processes the
 * tests spawn with `{ ...process.env }` inherit these.
 *
 *  (1) XBUS_TEST_REQUIRE_FAKE_CLAUDE=1 — the xclaude launcher REFUSES to fall back to
 *      a real `claude` on PATH; a test must pass CLAUDE_CODE_EXECPATH pointing at a
 *      fake executable, or the launcher fails closed. This makes it impossible for the
 *      test suite to ever resolve or launch the user's real Claude Code.
 *  (2) Clear inherited Claude-related env so a developer's configured CLAUDE_CODE_EXECPATH
 *      / CLAUDE_CODE_SESSION_ID cannot leak the real executable into a test.
 *  (3) XBUS_ALLOW_UNSUPPORTED_NODE=1 — the dev suite may run on an unsupported Node
 *      (e.g. the maintainer's Node 25). The clean-machine acceptance (§10) runs on a
 *      SUPPORTED Node WITHOUT this bypass, which is the real release gate.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.XBUS_TEST_REQUIRE_FAKE_CLAUDE = '1';
delete process.env.CLAUDE_CODE_EXECPATH;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_CONFIG_DIR;
process.env.XBUS_ALLOW_UNSUPPORTED_NODE = '1';

// (4) Pin the legacy-data-root to an isolated EMPTY dir so NO test ever scans or
// migrates the developer's real ~/.claude/xbus (which would hang on a locked live DB
// or silently mutate real data). A test that wants to exercise migration sets its own
// XBUS_LEGACY_DATA_DIR explicitly. This is the global safety net.
if (!process.env.XBUS_LEGACY_DATA_DIR) {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-test-legacy-empty-'));
  process.env.XBUS_LEGACY_DATA_DIR = isolated;
}
