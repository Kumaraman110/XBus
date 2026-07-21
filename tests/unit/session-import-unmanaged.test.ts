/**
 * Dormant IMPORT (metadata-only) (beta.5 Phase 1; ADR 0013 D5, ADR 0020 Q1).
 * Proves: scanTranscripts reads ONLY the directory listing + stat (NEVER opens a transcript
 * body — asserted by spying on fs.readFileSync/openSync); importDormantSessions upserts
 * unroutable dormant rows + one ledger event each, is idempotent, and never downgrades an
 * existing session.
 *
 * NOTE (beta.10 Train B): the conservative aggregate UNMANAGED-detection helpers
 * (computeUnmanagedBanner / countLiveClaudeProcesses) and their tests were REMOVED with the
 * unmanaged-sessions dashboard feature (product decision — no data beats fabricated certainty).
 * Session-import (dormant metadata) is a SEPARATE, retained capability and is unaffected.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, type SqliteDriver } from '../../src/database/connection.js';
import { runMigrations } from '../../src/database/migrations.js';
import { BrokerStore } from '../../src/broker/store.js';
import { FakeClock, SeqIdGen } from '../../src/shared/clock.js';
import { scanTranscripts } from '../../src/broker/session-import.js';
import { verifyLedger } from '../../src/broker/ledger.js';

let dir: string; let projectsDir: string;
const SID1 = 'a1a1a1a1-0000-4000-8000-000000000001';
const SID2 = 'b2b2b2b2-0000-4000-8000-000000000002';

function seedTranscripts(): void {
  projectsDir = path.join(dir, 'projects');
  const slug = path.join(projectsDir, '-c--Users-me-repo');
  fs.mkdirSync(slug, { recursive: true });
  fs.writeFileSync(path.join(slug, `${SID1}.jsonl`), '{"type":"user"}\n{"type":"assistant"}\n');
  fs.writeFileSync(path.join(slug, `${SID2}.jsonl`), '{"type":"user"}\n');
  fs.writeFileSync(path.join(slug, 'not-a-uuid.jsonl'), 'junk'); // ignored (not a UUID)
  fs.writeFileSync(path.join(slug, `${SID1}.txt`), 'ignored'); // ignored (not .jsonl)
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-import-')); seedTranscripts(); });
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('scanTranscripts — metadata only', () => {
  it('lists <uuid>.jsonl files (skipping non-uuid + non-jsonl) with mtime, WITHOUT opening bodies', () => {
    const readFileSpy = vi.spyOn(fs, 'readFileSync');
    const openSpy = vi.spyOn(fs, 'openSync');
    const metas = scanTranscripts(projectsDir);
    expect(metas.map((m) => m.sessionId).sort()).toEqual([SID1, SID2].sort());
    for (const m of metas) { expect(m.lastSeenMs).toBeGreaterThan(0); expect(m.transcriptPath).toContain('.jsonl'); }
    // HONESTY CONTRACT: no transcript body was opened.
    const openedJsonl = readFileSpy.mock.calls.some((c) => String(c[0]).endsWith('.jsonl')) || openSpy.mock.calls.some((c) => String(c[0]).endsWith('.jsonl'));
    expect(openedJsonl).toBe(false);
  });

  it('a missing projects dir → empty (never throws)', () => {
    expect(scanTranscripts(path.join(dir, 'does-not-exist'))).toEqual([]);
  });
});

describe('importDormantSessions', () => {
  let db: SqliteDriver; let clock: FakeClock; let store: BrokerStore;
  beforeEach(() => {
    db = openDatabase(path.join(dir, 'x.sqlite'), { applyPragmas: true });
    clock = new FakeClock();
    runMigrations(db, clock.nowIso());
    store = new BrokerStore(db, clock, new SeqIdGen('imp'), 'b');
  });
  afterEach(() => { try { db.close(); } catch { /* ignore */ } });

  it('imports dormant, unroutable rows + one ledger event each; idempotent on re-run', () => {
    const metas = scanTranscripts(projectsDir);
    const r1 = store.importDormantSessions(metas);
    expect(r1.imported).toBe(2);
    const row = db.prepare('SELECT management_state AS m, identify_confidence AS c, session_name_state AS n, state AS s FROM sessions WHERE session_id=?').get(SID1) as { m: string; c: string; n: string; s: string };
    expect(row.m).toBe('dormant');
    expect(row.c).toBe('listing_only');
    expect(row.n).toBe('unnamed'); // no active name → not routable by name
    expect(row.s).toBe('disconnected');
    // one SESSION_IMPORTED ledger event per session; chain valid.
    const imported = (db.prepare(`SELECT COUNT(*) AS n FROM ledger_events WHERE event_type='SESSION_IMPORTED'`).get() as { n: number }).n;
    expect(imported).toBe(2);
    expect(verifyLedger(db).ok).toBe(true);
    // Re-run: both already known → skipped, no new rows/events.
    const r2 = store.importDormantSessions(metas);
    expect(r2.imported).toBe(0);
    expect(r2.skipped).toBe(2);
  });

  it('NEVER downgrades an existing (active) session', () => {
    // Register SID1 as a live mcp session first.
    const auth = store.register({ sessionId: SID1, instanceId: 'i', connectionId: 'c', processId: 1, projectId: 'p', cwd: '/', receiveMode: 'hook_checkpoint', capabilities: ['ack'], role: 'mcp' });
    store.announceSession(auth, { source: 'startup' });
    expect((db.prepare('SELECT management_state AS m FROM sessions WHERE session_id=?').get(SID1) as { m: string }).m).toBe('active');
    // Import must skip it (never flip active → dormant).
    const r = store.importDormantSessions(scanTranscripts(projectsDir));
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect((db.prepare('SELECT management_state AS m FROM sessions WHERE session_id=?').get(SID1) as { m: string }).m).toBe('active');
  });
});
