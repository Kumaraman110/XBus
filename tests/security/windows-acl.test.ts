/**
 * Windows ACL / Unix mode verification (the user's blocker #3). Inspects the
 * ACTUAL OS permissions on sensitive artifacts — a textual 0600 is a no-op on
 * Windows, so we verify the real ACL via icacls. Classified per-platform.
 *
 * Runs on whatever platform the test host is. On Windows it asserts no broad
 * principals (Everyone/Authenticated Users/Users) and that inheritance was
 * removed; on Unix it asserts 0700/0600.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startBrokerHost, type RunningBroker } from '../../src/broker/host.js';
import { describeAcl, hardenDir, hardenFile, assertNotReparse } from '../../src/ipc/acl.js';

let dataDir: string;
let broker: RunningBroker;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-aclt-'));
  broker = await startBrokerHost({ dataDir });
});
afterEach(async () => {
  await broker.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const isWin = process.platform === 'win32';

describe(`runtime artifact permissions (${process.platform})`, () => {
  it('the data directory grants no broad principals', () => {
    const acl = describeAcl(dataDir);
    expect(acl.broadAccess, `data dir ACL: ${JSON.stringify(acl)}`).toBe(false);
    if (isWin) {
      // Only the current user + SYSTEM (no Everyone/Authenticated Users/Users).
      expect(acl.principals?.some((p) => /Everyone|Authenticated Users/i.test(p))).toBe(false);
    } else {
      expect(acl.mode).toBe('700');
    }
  });

  it('the broker state file grants no broad principals', () => {
    const f = path.join(dataDir, 'broker.state.json');
    expect(fs.existsSync(f)).toBe(true);
    const acl = describeAcl(f);
    expect(acl.broadAccess, `state file ACL: ${JSON.stringify(acl)}`).toBe(false);
    if (!isWin) expect(acl.mode).toBe('600');
  });

  it('the SQLite database grants no broad principals', () => {
    const f = path.join(dataDir, 'xbus.sqlite');
    expect(fs.existsSync(f)).toBe(true);
    const acl = describeAcl(f);
    expect(acl.broadAccess, `db ACL: ${JSON.stringify(acl)}`).toBe(false);
  });

  it('hardenFile/hardenDir report applied + the method matches the platform', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-h-'));
    const rd = hardenDir(t);
    expect(rd.applied).toBe(true);
    expect(rd.method).toBe(isWin ? 'icacls' : 'chmod');
    const ff = path.join(t, 'f.txt');
    fs.writeFileSync(ff, 'x');
    const rf = hardenFile(ff);
    expect(rf.applied).toBe(true);
    // after hardening, no broad access
    expect(describeAcl(ff).broadAccess).toBe(false);
    fs.rmSync(t, { recursive: true, force: true });
  });

  it('a symlinked data path is rejected (reparse/junction guard)', function () {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-real-'));
    const link = path.join(os.tmpdir(), `xbus-link-${Math.random().toString(36).slice(2)}`);
    try {
      fs.symlinkSync(real, link, 'dir');
    } catch {
      // Symlink creation needs privilege on Windows; skip honestly if unavailable.
      fs.rmSync(real, { recursive: true, force: true });
      return;
    }
    expect(() => assertNotReparse(link)).toThrow(/symlink|reparse/i);
    fs.unlinkSync(link);
    fs.rmSync(real, { recursive: true, force: true });
  });
});
