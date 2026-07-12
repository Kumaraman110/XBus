/**
 * Beta.5 Phase 1 — SessionStart hook NON-BLOCKING guarantee (ADR 0013 D2 / I5).
 *
 * The hook must NEVER block Claude: a missing session id, an unreachable/failing broker,
 * or a timeout all degrade to `{announced:false, reason}` (and, in main(), exit 0). These
 * unit tests exercise runSessionStart's degradation paths directly (no broker running),
 * and assert it resolves — never rejects. (The exit-0 wrapper in main() and the real
 * end-to-end announce are covered by the integration suite.)
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { runSessionStart } from '../../src/channel/session-start-hook.js';

const SID = 'ffff0001-0000-4000-8000-000000000001';

describe('SessionStart hook — non-blocking degradation', () => {
  it('no session id (env unset + no input) → degrades, does not throw', async () => {
    const prev = process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    try {
      const r = await runSessionStart({}, { endpoint: 'nonexistent-endpoint', rootSecret: Buffer.alloc(32) });
      expect(r.announced).toBe(false);
      expect(r.reason).toBe('no-session-id');
    } finally {
      if (prev !== undefined) process.env.CLAUDE_CODE_SESSION_ID = prev;
    }
  });

  it('broker unreachable → degrades to broker-unreachable, resolves (never rejects)', async () => {
    // Point at an endpoint with no listener. On win32 this is a named pipe that does not
    // exist; on posix a socket path that was never bound. connect() fails → degrade.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-ssh-'));
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\xbus-nope-${Math.random().toString(36).slice(2)}`
      : path.join(dir, 'nope.sock');
    try {
      const r = await runSessionStart({ session_id: SID, source: 'startup' }, { endpoint, rootSecret: Buffer.alloc(32), requestTimeoutMs: 500 });
      expect(r.announced).toBe(false);
      expect(r.reason).toBe('broker-unreachable');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('resolves within a bounded time even against a dead endpoint (no hang)', async () => {
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\xbus-nope-${Math.random().toString(36).slice(2)}`
      : `/tmp/xbus-nope-${Math.random().toString(36).slice(2)}.sock`;
    const start = Date.now();
    const r = await runSessionStart({ session_id: SID, source: 'resume' }, { endpoint, rootSecret: Buffer.alloc(32), requestTimeoutMs: 500 });
    const elapsed = Date.now() - start;
    expect(r.announced).toBe(false);
    expect(elapsed).toBeLessThan(4000); // bounded — the hook cannot stall Claude startup
  });
});
