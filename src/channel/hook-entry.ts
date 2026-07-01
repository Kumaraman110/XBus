/**
 * Checkpoint hook entrypoint. Configured as a Claude Code hook (UserPromptSubmit
 * and/or Stop). Reads the hook JSON from stdin, pulls + injects pending XBus
 * messages at the checkpoint, prints hookSpecificOutput on stdout, exits 0
 * (or 2 only when an opt-in bounded Stop-continuation is warranted).
 */
import { runCheckpoint, type HookInput } from './checkpoint-hook.js';
import { defaultEndpoint } from '../ipc/transport.js';
import { resolveDataDir } from './server.js';
import { loadOrCreateRootSecret } from '../ipc/root-secret.js';
import { ensureBrokerDefault } from '../broker/ensure.js';

export async function main(): Promise<void> {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  let hook: HookInput;
  try {
    hook = JSON.parse(input || '{}') as HookInput;
  } catch {
    hook = {};
  }

  const dataDir = resolveDataDir();
  const endpoint = defaultEndpoint(dataDir);
  const rootSecret = loadOrCreateRootSecret(dataDir);
  const autoContinue = process.env.XBUS_AUTO_CONTINUE_ON_STOP === '1';
  // Beta.4 (ADR 0012 D7): zero-friction broker auto-start. Best-effort + bounded;
  // if it degrades, runCheckpoint's own connect simply fails closed and the hook
  // returns {exitCode:0} — Claude is NEVER blocked on XBus.
  try { await ensureBrokerDefault(dataDir); } catch { /* runCheckpoint degrades */ }
  try {
    const result = await runCheckpoint(hook, { endpoint, rootSecret, autoContinueOnStop: autoContinue });
    if (result.stdout) process.stdout.write(result.stdout);
    process.exit(result.exitCode);
  } catch {
    // Never block Claude on an XBus hook failure.
    process.exit(0);
  }
}

if (process.argv[1] && process.argv[1].endsWith('hook-entry.js')) {
  void main();
}
