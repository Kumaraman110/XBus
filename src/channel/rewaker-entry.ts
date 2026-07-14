/**
 * Process entry for the RESIDENT idle-wake rewaker (beta.7 Phase 3, ADR 0025).
 *
 * Registered as a SessionStart hook with `async: true, asyncRewake: true` (see hooks/hooks.json).
 * Claude Code launches it in the BACKGROUND at SessionStart; it polls the broker for an eligible
 * queued delivery to THIS session and, on the first one, prints a body-free reminder + exits 2 —
 * the documented asyncRewake wake. Fail-open: any error → exit 0 (no wake; delivery still drains
 * on the next real checkpoint — the durable floor). It NEVER carries a body or injects keystrokes.
 */
import { defaultEndpoint } from '../ipc/transport.js';
import { resolveDataDir } from './server.js';
import { loadOrCreateRootSecret } from '../ipc/root-secret.js';
import { runRewaker, type RewakerInput } from './rewaker.js';

export async function main(): Promise<void> {
  // Read stdin fully; a broken/absent stream must not throw.
  let raw = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
  } catch { /* degrade below */ }
  let input: RewakerInput;
  try { input = JSON.parse(raw || '{}') as RewakerInput; } catch { input = {}; }

  const dataDir = resolveDataDir();
  const endpoint = defaultEndpoint(dataDir);
  let rootSecret: Buffer;
  try { rootSecret = loadOrCreateRootSecret(dataDir); }
  catch { process.exit(0); } // no secret → no wake (never block Claude)

  try {
    const r = await runRewaker(input, { endpoint, rootSecret });
    if (r.exitCode === 2 && r.reminder) {
      // The documented asyncRewake system reminder — body-free, on stdout.
      process.stdout.write(r.reminder + '\n');
      process.exit(2);
    }
    process.exit(0);
  } catch {
    process.exit(0); // fail-open
  }
}

if (process.argv[1] && process.argv[1].endsWith('rewaker-entry.js')) {
  void main();
}
