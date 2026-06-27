#!/usr/bin/env node
/**
 * `xclaude` — launch Claude Code with the installed XBus plugin enabled.
 *
 * This is the entry point referenced by package.json `bin.xclaude`
 * (`dist/launcher/xclaude.js`). It does NOT reimplement Claude; it spawns the
 * user's `claude` with `--plugin-dir <installed XBus plugin>` and forwards every
 * user-supplied argument verbatim.
 *
 * Guarantees:
 *  - works from any directory; does NOT change the cwd; requires no project files;
 *  - preserves user args (passed through argv, which the OS quotes correctly —
 *    we never build a shell string);
 *  - fails with actionable guidance if XBus is not installed or the broker is
 *    unhealthy;
 *  - NEVER puts the root secret into argv or the child environment.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readInstallManifest, defaultInstallRoot, resolveDataDir } from './install-paths.js';

function fail(msg: string): never {
  process.stderr.write(`xclaude: ${msg}\n`);
  process.exit(1);
}

function resolvePluginDir(): string {
  // Prefer an explicit override (testing / non-default installs).
  const override = process.env.XBUS_PLUGIN_DIR;
  if (override) {
    if (!fs.existsSync(path.join(override, '.claude-plugin', 'plugin.json'))) {
      fail(`XBUS_PLUGIN_DIR=${override} does not contain a .claude-plugin/plugin.json`);
    }
    return override;
  }
  // Otherwise read the install manifest written by `xbus install`.
  const root = defaultInstallRoot();
  const manifest = readInstallManifest(root);
  if (!manifest) {
    fail(`XBus is not installed (no manifest under ${root}).\n  Run: xbus install\n  Or set XBUS_PLUGIN_DIR to a plugin directory.`);
  }
  const pluginDir = manifest.pluginDir;
  if (!fs.existsSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'))) {
    fail(`installed plugin dir is missing or corrupt: ${pluginDir}\n  Re-run: xbus install`);
  }
  return pluginDir;
}

export function buildClaudeArgs(pluginDir: string, userArgs: string[]): string[] {
  // --plugin-dir first, then the user's own args (verbatim). If the user already
  // passed --plugin-dir we still add ours; Claude accepts multiple.
  return ['--plugin-dir', pluginDir, ...userArgs];
}

/** Quote one argument for cmd.exe so spaces/special chars survive intact. */
export function cmdQuoteArg(arg: string): string {
  // Double-quote if it contains whitespace or cmd metacharacters; escape any
  // embedded double-quotes by doubling, and caret-escape the cmd specials that
  // survive inside quotes is unnecessary for /c with a quoted token.
  if (arg === '') return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '""') + '"';
}

function main(): void {
  const userArgs = process.argv.slice(2);
  const pluginDir = resolvePluginDir();
  const claudeBin = process.env.CLAUDE_CODE_EXECPATH || 'claude';
  const args = buildClaudeArgs(pluginDir, userArgs);

  // Activation is explicit + visible.
  process.stderr.write(`xclaude: launching Claude Code with XBus plugin: ${pluginDir}\n`);

  // Pass through the environment but ensure no XBus secret is injected here.
  // (The broker reads its secret from the ACL-protected data dir, never via env.)
  const env = { ...process.env };
  delete (env as Record<string, string>).XBUS_ROOT_SECRET; // defensive: never propagate a secret via env
  // Canonical data root (spec §5): pin the child's XBUS_DATA_DIR to the SAME root
  // every other component resolves (env override → installed manifest dataDir →
  // default), so the Claude session's MCP server + hooks talk to the broker on the
  // installed data dir — not a divergent default. A user-set XBUS_DATA_DIR wins.
  env.XBUS_DATA_DIR = resolveDataDir();

  // Windows: a .cmd/.bat shim (e.g. claude.cmd) cannot be spawned directly
  // (EINVAL); route it through cmd.exe with each token explicitly quoted so
  // spaces/special chars survive intact. Everything else spawns directly (Node
  // quotes argv itself). We never build a shell string for the non-batch path.
  const isWinBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(claudeBin);
  let child;
  if (isWinBatch) {
    // `cmd /s /c "<line>"`: with /s, cmd strips exactly one leading and one
    // trailing quote from the whole line and runs the remainder verbatim. So we
    // quote every token (preserving embedded spaces — e.g. a plugin dir under
    // "...\install root\plugin") AND wrap the whole line in an extra outer pair.
    const line = '"' + [claudeBin, ...args].map(cmdQuoteArg).join(' ') + '"';
    child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], { stdio: 'inherit', env, cwd: process.cwd(), windowsVerbatimArguments: true });
  } else {
    child = spawn(claudeBin, args, { stdio: 'inherit', env, cwd: process.cwd() });
  }
  child.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') {
      fail(`could not find the 'claude' executable. Install Claude Code, or set CLAUDE_CODE_EXECPATH.`);
    }
    fail(`failed to launch claude: ${e.message}`);
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

// Run only as the CLI entry (argv[1] is the compiled launcher).
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('launcher/xclaude.js')) {
  main();
}

// Silence unused import in type-only builds.
void os;
