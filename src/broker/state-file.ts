/**
 * Broker state file (ADR 0007). Records enough identity to SAFELY target the
 * broker for shutdown/restart without ever killing an unrelated process.
 *
 * Written atomically with restrictive permissions. The normal shutdown path is
 * an authenticated IPC request; forced termination is a fallback that runs ONLY
 * after multiple identity checks pass.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hardenFile } from '../ipc/acl.js';

export interface BrokerStateFile {
  pid: number;
  processStartedAt: string;
  brokerInstanceId: string;
  buildId: string;            // compatibility tuple (legacy field; stable across the release line)
  /** §8 (ADR 0011): the EXACT build id + commit, so a stale broker is
   *  distinguishable from a newer one (the compatibility `buildId` alone cannot,
   *  being identical across the line). Optional for back-compat with older state files. */
  exactBuildId?: string;
  sourceCommit?: string;
  endpoint: string;
  /** Hash of the owning OS user (never the raw username in logs). */
  ownerIdentityHash: string;
  /** Beta.5 Phase 1: the loopback dashboard HTTP port + URL, when the broker started one
   *  (ADR 0015 single-instance). Optional + additive — absent on a broker with no dashboard
   *  and on older state files. `xbus dashboard` reads these to reach/open the running UI. */
  dashboardPort?: number;
  dashboardUrl?: string;
}

export function stateFilePath(dataDir: string): string {
  return path.join(dataDir, 'broker.state.json');
}

export function ownerIdentityHash(): string {
  const u = os.userInfo();
  return createHash('sha256').update(`${u.username}:${u.uid}`, 'utf8').digest('hex').slice(0, 16);
}

/** Atomic write with user-only perms (Unix 0600; Windows ACL via hardenFile). */
export function writeStateFile(dataDir: string, state: BrokerStateFile): void {
  const target = stateFilePath(dataDir);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
  // Real restriction: chmod (Unix) is meaningful; on Windows we must set the ACL
  // explicitly since the renamed file inherits the dir ACL (a 0600 mode is a no-op).
  try { hardenFile(target); } catch { /* best effort; dir is already hardened */ }
}

export function readStateFile(dataDir: string): BrokerStateFile | null {
  try {
    const raw = fs.readFileSync(stateFilePath(dataDir), 'utf8');
    const s = JSON.parse(raw) as BrokerStateFile;
    if (typeof s.pid === 'number' && typeof s.brokerInstanceId === 'string') return s;
    return null;
  } catch {
    return null;
  }
}

export function removeStateFileIfOwned(dataDir: string, brokerInstanceId: string): void {
  const s = readStateFile(dataDir);
  if (s && s.brokerInstanceId === brokerInstanceId) {
    try { fs.unlinkSync(stateFilePath(dataDir)); } catch { /* ignore */ }
  }
}

/** Is the PID a live process? (signal 0 probes without killing.) */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process; EPERM = exists but not signalable (still alive).
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ShutdownDecision {
  /** 'ipc' = ask the broker to shut down over IPC (normal). 'none' = nothing to
   *  stop. 'forced-eligible' = identity verified, forced kill is permitted. */
  action: 'ipc' | 'none' | 'forced-eligible' | 'refuse';
  reason: string;
  pid?: number;
}

/**
 * Decide how to stop a broker WITHOUT killing an unrelated process. The caller
 * first tries IPC shutdown; only if that fails AND identity is verified may it
 * force-kill. This function classifies the state-file situation.
 */
export function classifyShutdown(dataDir: string, expectInstanceId?: string): ShutdownDecision {
  const s = readStateFile(dataDir);
  if (!s) return { action: 'none', reason: 'no broker state file; nothing to stop' };
  if (s.ownerIdentityHash !== ownerIdentityHash()) {
    return { action: 'refuse', reason: 'broker state file owned by a different OS user; refusing to signal', pid: s.pid };
  }
  if (!pidIsAlive(s.pid)) {
    return { action: 'none', reason: `stale state file (pid ${s.pid} not running); safe to remove`, pid: s.pid };
  }
  if (expectInstanceId && s.brokerInstanceId !== expectInstanceId) {
    return { action: 'refuse', reason: 'broker instance id mismatch; refusing to signal a possibly-unrelated process', pid: s.pid };
  }
  // PID is alive + owned by us + (optionally) instance matches. IPC is the normal
  // path; if the broker is hung, forced kill is eligible AFTER an IPC attempt.
  return { action: 'ipc', reason: 'broker reachable; request graceful IPC shutdown', pid: s.pid };
}
