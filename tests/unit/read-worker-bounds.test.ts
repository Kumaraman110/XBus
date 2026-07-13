/**
 * Read-worker reliability bounds (beta.5 blocker #5). Uses an injected FakeWorker to drive
 * message/error/exit/timeout deterministically — no real thread, no flakiness. Proves:
 *   - timeout terminates + replaces the wedged worker;
 *   - a worker-GENERATION guard: an OLD worker's late error/exit can't fail a NEW worker's calls;
 *   - a bounded in-flight queue rejects overflow with ReadOverloadedError (→503 backpressure);
 *   - restart-race + recovery: after a crash, the next run() spawns a fresh worker and succeeds.
 */
import { describe, it, expect } from 'vitest';
import { WorkerReadExecutor, ReadOverloadedError, type WorkerLike, type ReadResponse } from '../../src/broker/dashboard/read-worker.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A controllable fake worker: capture posted requests, emit responses/errors/exits on demand. */
class FakeWorker implements WorkerLike {
  posted: Array<{ id: number; method: string; args?: unknown }> = [];
  terminated = 0;
  private msgCb: ((m: ReadResponse) => void) | null = null;
  private errCb: ((e: Error) => void) | null = null;
  private exitCb: ((code: number) => void) | null = null;
  postMessage(v: unknown): void { this.posted.push(v as { id: number; method: string }); }
  on(event: 'message' | 'error' | 'exit', cb: (arg: never) => void): void {
    if (event === 'message') this.msgCb = cb as (m: ReadResponse) => void;
    else if (event === 'error') this.errCb = cb as (e: Error) => void;
    else this.exitCb = cb as (code: number) => void;
  }
  terminate(): Promise<number> { this.terminated += 1; return Promise.resolve(0); }
  // test drivers:
  reply(id: number, result: unknown): void { this.msgCb?.({ id, ok: true, result }); }
  fail(id: number, error: string): void { this.msgCb?.({ id, ok: false, error }); }
  emitError(e: Error): void { this.errCb?.(e); }
  emitExit(code: number): void { this.exitCb?.(code); }
}

/** Build an executor whose spawnWorker hands out fakes we keep references to. */
function harness(opts: { timeoutMs?: number; maxInFlight?: number } = {}) {
  const workers: FakeWorker[] = [];
  const exec = new WorkerReadExecutor('C:/x.sqlite', {
    ...opts,
    spawnWorker: () => { const w = new FakeWorker(); workers.push(w); return w; },
  });
  return { exec, workers };
}

describe('WorkerReadExecutor bounds', () => {
  it('a normal read resolves via the worker message', async () => {
    const { exec, workers } = harness();
    const p = exec.run('sessions');
    expect(workers).toHaveLength(1);
    workers[0]!.reply(workers[0]!.posted[0]!.id, [{ sessionId: 's' }]);
    await expect(p).resolves.toEqual([{ sessionId: 's' }]);
  });

  it('TIMEOUT terminates + replaces the wedged worker; the next read uses a FRESH worker', async () => {
    // Real (short) timeout — fake timers deadlock the async settle path here.
    const { exec, workers } = harness({ timeoutMs: 20 });
    const p1 = exec.run('ledger'); // never replied → will time out
    expect(workers).toHaveLength(1);
    await expect(p1).rejects.toThrow(/timed out/);
    expect(workers[0]!.terminated).toBe(1); // wedged worker terminated
    // Next read spawns a NEW worker (worker[0] was dropped).
    const p2 = exec.run('sessions');
    expect(workers).toHaveLength(2);
    workers[1]!.reply(workers[1]!.posted[0]!.id, ['ok']);
    await expect(p2).resolves.toEqual(['ok']);
  });

  it("an OLD worker's late error/exit CANNOT reject a NEW worker's in-flight calls (generation guard)", async () => {
    // Trigger the first worker's replacement WITHOUT a timeout race on the second call: crash
    // worker[0] mid-flight (deterministic), which drops it; the next run() spawns worker[1].
    const { exec, workers } = harness({ timeoutMs: 10_000 });
    const p1 = exec.run('ledger');
    workers[0]!.emitError(new Error('boom')); // worker[0] crashes → its call rejects, worker dropped
    await expect(p1).rejects.toThrow(/crashed/);
    // Call 2 on the FRESH worker[1], still in flight.
    const p2 = exec.run('sessions');
    expect(workers).toHaveLength(2);
    // The OLD worker[0] now emits a SECOND late error + non-zero exit (arriving after replacement).
    workers[0]!.emitError(new Error('late crash'));
    workers[0]!.emitExit(1);
    // p2 must NOT be rejected by the old worker's late events (generation guard).
    let settled = false;
    void p2.then(() => { settled = true; }, () => { settled = true; });
    await sleep(20);
    expect(settled).toBe(false);
    // The fresh worker replies → p2 resolves normally.
    workers[1]!.reply(workers[1]!.posted[0]!.id, ['fresh']);
    await expect(p2).resolves.toEqual(['fresh']);
  });

  it('a FLOOD beyond maxInFlight rejects with ReadOverloadedError (503 backpressure)', async () => {
    const { exec, workers } = harness({ maxInFlight: 3 });
    const inflight = [exec.run('sessions'), exec.run('sessions'), exec.run('sessions')];
    // The 4th exceeds the cap → typed overload error, synchronously rejected.
    await expect(exec.run('sessions')).rejects.toBeInstanceOf(ReadOverloadedError);
    // Draining one frees a slot → a new read is accepted again.
    workers[0]!.reply(workers[0]!.posted[0]!.id, ['a']);
    await inflight[0];
    const p = exec.run('sessions');
    workers[0]!.reply(workers[0]!.posted[workers[0]!.posted.length - 1]!.id, ['b']);
    await expect(p).resolves.toEqual(['b']);
    // settle the rest
    workers[0]!.reply(workers[0]!.posted[1]!.id, ['x']); workers[0]!.reply(workers[0]!.posted[2]!.id, ['y']);
    await Promise.allSettled(inflight);
  });

  it('RECOVERY: after a worker crash, pending calls reject but the next call self-heals on a fresh worker', async () => {
    const { exec, workers } = harness();
    const p1 = exec.run('sessions');
    workers[0]!.emitError(new Error('boom')); // crash mid-flight
    await expect(p1).rejects.toThrow(/crashed/);
    // Next call spawns a fresh worker (self-heal) and succeeds.
    const p2 = exec.run('sessions');
    expect(workers).toHaveLength(2);
    workers[1]!.reply(workers[1]!.posted[0]!.id, ['recovered']);
    await expect(p2).resolves.toEqual(['recovered']);
  });

  it('close() rejects in-flight calls and terminates the worker', async () => {
    const { exec, workers } = harness();
    const p = exec.run('sessions');
    await exec.close();
    await expect(p).rejects.toThrow(/closing/);
    expect(workers[0]!.terminated).toBe(1);
    await expect(exec.run('sessions')).rejects.toThrow(/closed/);
  });
});
