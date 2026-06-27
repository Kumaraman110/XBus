/**
 * Injectable clock + id generation (dependency injection for determinism).
 * Production uses the real clock + uuid v7; tests inject fakes.
 */
import { v7 as uuidv7 } from 'uuid';

export interface Clock {
  /** Milliseconds since epoch. */
  nowMs(): number;
  /** ISO-8601 string for the current instant. */
  nowIso(): string;
}

export interface IdGen {
  /** Time-ordered unique id (UUIDv7 in production). */
  next(): string;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

export const uuidIdGen: IdGen = {
  next: () => uuidv7(),
};

/** Deterministic clock for tests: starts at `start`, advances explicitly. */
export class FakeClock implements Clock {
  private t: number;
  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }
  nowMs(): number {
    return this.t;
  }
  nowIso(): string {
    return new Date(this.t).toISOString();
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}

/** Deterministic, seeded id generator for tests. */
export class SeqIdGen implements IdGen {
  private n = 0;
  constructor(private readonly prefix = 'id') {}
  next(): string {
    this.n += 1;
    return `${this.prefix}-${this.n.toString().padStart(8, '0')}`;
  }
}
