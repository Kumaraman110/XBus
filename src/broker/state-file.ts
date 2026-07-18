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
// Beta.10 Stage 0: liveness proof (recycled-PID fix). liveness-proof.ts imports `pidIsAlive`
// from this module; classifyLiveness/osProcessCreationTimeMs are only CALLED at runtime (never
// at module init), so the ESM cycle is safe.
import { classifyLiveness, type LivenessDeps } from './liveness-proof.js';

export interface BrokerStateFile {
  pid: number;
  processStartedAt: string;
  /** Beta.10 Stage 0 (recycled-PID fix): the OS process-CREATION time of `pid` at broker start,
   *  as epoch ms (culture/timezone-invariant). Distinct from `processStartedAt` (which is
   *  wall-clock `nowIso()` and NOT comparable to an OS re-read). Used by the liveness proof to
   *  detect a recycled PID. Optional + additive: absent on older state files, which then degrade
   *  to the handshake arm (never to "assume it's ours"). */
  processCreatedAt?: number;
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
 * Decide how to stop a broker WITHOUT killing an unrelated process (ADR-0007). The caller
 * first tries IPC shutdown; only if that fails AND the process is PROVEN to be our broker may
 * it force-kill.
 *
 * Beta.10 Stage 0 (recycled-PID fix): `pidIsAlive` alone is NOT proof — a hard-killed broker's
 * PID can be recycled to an unrelated same-user process. We require a positive liveness PROOF
 * (OS creation-time match or STP handshake) before returning `ipc`. This is the KILL path, so
 * the fail-closed direction is: an INCONCLUSIVE proof must NEVER lead to a signal.
 *
 * @param deps injectable liveness seams (tests); production passes none.
 */
export function classifyShutdown(dataDir: string, expectInstanceId?: string, deps?: LivenessDeps): ShutdownDecision {
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
  // PID is alive + owned by us + (optionally) instance matches — but is it REALLY our broker,
  // or a recycled PID? Require a positive liveness proof before permitting an IPC/forced stop.
  const verdict = classifyLiveness(s.pid, s.processCreatedAt ?? null, s.endpoint, deps);
  if (verdict === 'proven_dead_or_recycled') {
    // Alive PID but a DIFFERENT process (creation-time mismatch) — NOT our broker. Never signal it.
    // 'stale' in the reason lets cmdStop clean up the dead marker (the recorded broker is gone).
    return { action: 'none', reason: `stale state file: pid ${s.pid} is alive but is NOT our broker (process creation-time mismatch — recycled PID); safe to remove`, pid: s.pid };
  }
  if (verdict === 'inconclusive') {
    // Cannot prove it's our broker (old state file w/o marker AND handshake unavailable). KILL-path
    // fail-closed = DO NOT signal a process we cannot prove is ours (ADR-0007).
    return { action: 'refuse', reason: `cannot prove pid ${s.pid} is our broker (liveness inconclusive); refusing to signal (ADR-0007 fail-closed)`, pid: s.pid };
  }
  // PROVEN our live broker: IPC is the normal path; forced kill is eligible AFTER an IPC attempt.
  return { action: 'ipc', reason: 'broker liveness proven; request graceful IPC shutdown', pid: s.pid };
}
