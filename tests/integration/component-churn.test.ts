/**
 * Component churn (ADR 0003 §6): a long-lived session whose ephemeral hook fires
 * at MANY checkpoints must not accumulate live components or credentials, and DB
 * growth must be bounded + cleanup deterministic. 1000 synthetic checkpoints with
 * a FAKE clock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore } from '../../src/broker/store.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';

let dir: string;
let db: SqliteDriver;
let clock: FakeClock;
let store: BrokerStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-churn-'));
  db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
  clock = new FakeClock();
  runMigrations(db, clock.nowIso());
  store = new BrokerStore(db, clock, new SeqIdGen('c'), 'broker-churn');
});
afterEach(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('component churn (1000 ephemeral hook checkpoints, fake clock)', () => {
  it('bounded live components, no credential accumulation, deterministic cleanup', () => {
    const SID = 'dddd0000-0000-4000-8000-00000000000d';
    // The long-lived MCP component stays on one connection.
    store.register({ sessionId: SID, instanceId: 'mcp', connectionId: 'mcp-conn', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: [], role: 'mcp' });

    const N = 1000;
    for (let i = 0; i < N; i++) {
      // Each checkpoint = an ephemeral hook component on a fresh connection that
      // immediately "completes" (its connection closes).
      const conn = `hook-conn-${i}`;
      store.register({ sessionId: SID, instanceId: `hook-${i}`, connectionId: conn, processId: 2, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: [], role: 'hook' });
      clock.advance(1000); // 1s between checkpoints
      // The ephemeral hook connection is gone after the invocation. Cleanup runs
      // periodically; the only persistently-live connection is the MCP server.
      if (i % 50 === 49) {
        store.cleanupComponents({ liveConnectionIds: new Set(['mcp-conn']), retentionMs: 60_000 });
      }
    }
    // Final cleanup pass.
    store.cleanupComponents({ liveConnectionIds: new Set(['mcp-conn']), retentionMs: 60_000 });

    // Bounded live components: only the MCP server remains live.
    expect(store.liveComponentCount()).toBe(1);

    // DB growth bounded: historical component rows pruned past retention (60s);
    // with 1s spacing over 1000s, only the recent ~retention window survives +
    // the live mcp row. Far below N.
    const total = (db.prepare('SELECT COUNT(*) n FROM component_instances').get() as { n: number }).n;
    expect(total).toBeLessThan(120); // ~retention window, not 1001
    expect(total).toBeGreaterThanOrEqual(1);

    // No context-injection credential accumulation (none were issued here, but
    // assert the table didn't balloon from registration churn).
    const inj = (db.prepare('SELECT COUNT(*) n FROM context_injections').get() as { n: number }).n;
    expect(inj).toBe(0);

    // Determinism: a second identical cleanup is a no-op (idempotent).
    const before = store.liveComponentCount();
    store.cleanupComponents({ liveConnectionIds: new Set(['mcp-conn']), retentionMs: 60_000 });
    expect(store.liveComponentCount()).toBe(before);
  });

  it('completed (closed) components retain NO authority — only live components count', () => {
    const SID = 'eeee0000-0000-4000-8000-00000000000e';
    store.register({ sessionId: SID, instanceId: 'mcp', connectionId: 'mcp-conn', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: [], role: 'mcp' });
    for (let i = 0; i < 10; i++) {
      store.register({ sessionId: SID, instanceId: `hook-${i}`, connectionId: `h-${i}`, processId: 2, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: [], role: 'hook' });
    }
    // All hook connections gone; cleanup closes them.
    store.cleanupComponents({ liveConnectionIds: new Set(['mcp-conn']) });
    expect(store.liveComponentCount()).toBe(1);
    const liveHooks = db.prepare(`SELECT COUNT(*) n FROM component_instances WHERE role='hook' AND state='live'`).get() as { n: number };
    expect(liveHooks.n).toBe(0);
  });
});
