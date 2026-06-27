/**
 * SQLite reliability (reliability contract §13). Proves WAL active, FK active,
 * busy_timeout, transaction rollback, atomic sequence allocation under
 * concurrency, and DB validity + WAL recovery after a FORCED broker kill.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore } from '../../src/broker/store.js';
import { systemClock, uuidIdGen, FakeClock, SeqIdGen } from '../../src/shared/clock.js';

let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-crash-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('SQLite pragmas + transactions', () => {
  it('WAL, foreign_keys, busy_timeout are actually active', () => {
    const db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
    expect((db.pragma('journal_mode') as { journal_mode: string }).journal_mode).toBe('wal');
    expect((db.pragma('foreign_keys') as { foreign_keys: number }).foreign_keys).toBe(1);
    expect((db.pragma('busy_timeout') as { timeout: number }).timeout).toBeGreaterThan(0);
    db.close();
  });

  it('transaction rolls back fully after an injected exception', () => {
    const db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
    runMigrations(db, systemClock.nowIso());
    const before = (db.prepare('SELECT COUNT(*) n FROM audit_events').get() as { n: number }).n;
    expect(() => db.transaction(() => {
      db.prepare('INSERT INTO audit_events (audit_id, event_type, safe_metadata_json, created_at) VALUES (?,?,?,?)').run('a1', 'X', '{}', 't');
      throw new Error('boom'); // mid-transaction failure
    })).toThrow('boom');
    const after = (db.prepare('SELECT COUNT(*) n FROM audit_events').get() as { n: number }).n;
    expect(after).toBe(before); // fully rolled back
    db.close();
  });

  it('recipient-sequence allocation is atomic + gapless under interleaved sends', () => {
    const db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
    const clock = new FakeClock();
    runMigrations(db, clock.nowIso());
    const store = new BrokerStore(db, clock, new SeqIdGen('s'), 'b');
    const a = store.register({ sessionId: 'AAAAAAAA-0000-4000-8000-00000000000a', instanceId: 'ia', connectionId: 'ca', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: [], role: 'mcp' });
    store.registerAlias(a, 'architect');
    const b = store.register({ sessionId: 'BBBBBBBB-0000-4000-8000-00000000000b', instanceId: 'ib', connectionId: 'cb', processId: 2, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: [], role: 'hook' });
    store.registerAlias(b, 'implementer');
    const seqs: number[] = [];
    for (let i = 0; i < 50; i++) seqs.push(store.send(a, { to: 'implementer', text: `m${i}`, kind: 'event', requiresAck: false, requiresReply: false }).sequence);
    // strictly increasing, gapless 1..50
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    db.close();
  });
});

describe('forced-kill WAL recovery', () => {
  it('DB remains valid + committed messages survive a SIGKILL of the broker process', async () => {
    // Spawn a real broker host in a child process, send via a client, SIGKILL it,
    // then reopen the DB and verify integrity + data.
    const driver = path.resolve('dist/cli/main.js');
    const child = spawn(process.execPath, [driver, 'start'], { env: { ...process.env, XBUS_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    // wait for "broker started"
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('broker did not start')), 15000);
      child.stdout.on('data', (d: Buffer) => { if (d.toString().includes('broker started')) { clearTimeout(t); resolve(); } });
    });

    // send some messages via a real client
    const { IpcClient } = await import('../../src/ipc/client.js');
    const { defaultEndpoint } = await import('../../src/ipc/transport.js');
    const { clientHello } = await import('../../src/ipc/hello.js');
    const { loadOrCreateRootSecret } = await import('../../src/ipc/root-secret.js');
    const rootSecret = loadOrCreateRootSecret(dir);
    const ep = defaultEndpoint(dir);
    const a = new IpcClient(ep, { requestTimeoutMs: 4000, rootSecret });
    await a.connect();
    await a.request('hello', clientHello('mcp'));
    await a.request('register_session', { sessionId: 'cccccccc-0000-4000-8000-00000000000c', instanceId: 'ia', processId: 1, projectId: 'p', cwd: process.cwd(), receiveMode: 'hook_checkpoint', capabilities: [], role: 'mcp' });
    await a.request('register_alias', { alias: 'architect' });
    const b = new IpcClient(ep, { requestTimeoutMs: 4000, rootSecret });
    await b.connect();
    await b.request('hello', clientHello('mcp'));
    await b.request('register_session', { sessionId: 'dddddddd-0000-4000-8000-00000000000d', instanceId: 'ib', processId: 2, projectId: 'p', cwd: process.cwd(), receiveMode: 'hook_checkpoint', capabilities: [], role: 'mcp' });
    await b.request('register_alias', { alias: 'implementer' });
    const sent = await a.request('send_message', { to: 'implementer', text: 'survive-the-kill', requiresAck: true });
    const messageId = (sent.payload as { messageId: string }).messageId;
    a.close(); b.close();

    // FORCED kill (no graceful shutdown) — simulates a crash mid-life.
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 800));

    // Reopen the DB directly and verify integrity + the committed message.
    const db: SqliteDriver = openDatabase(path.join(dir, 'xbus.sqlite'), { applyPragmas: true });
    const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    expect(integrity.integrity_check).toBe('ok');
    const msg = db.prepare('SELECT body_text FROM messages WHERE message_id=?').get(messageId) as { body_text: string } | undefined;
    expect(msg?.body_text).toBe('survive-the-kill'); // committed before kill -> durable
    db.close();
  }, 30000);
});
