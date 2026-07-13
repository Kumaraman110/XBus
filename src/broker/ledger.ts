/**
 * Append-only, hash-chained AUDIT LEDGER (beta.5 Phase 1; ADR 0016 / ADR 0020 Q4).
 *
 * `ledger_events` is an audit PROJECTION, written in the SAME transaction as each
 * authoritative state mutation (ADR 0020 Q3), so it can never diverge from state. It
 * is NOT the source of truth for routing state (the mutable tables are). Bodies and
 * secrets are NEVER stored here — only ids, states, counts, and hashes.
 *
 * Each row chains to the previous: entry_hash = sha256(canonical(fields) ‖ prev_hash),
 * with a dense, gap-free `seq`. A ledger-specific failure (constraint / trigger /
 * corruption) aborts the whole op with AUDIT_PERSISTENCE_FAILED — a deliberate
 * availability tradeoff (no-divergence over availability for an audit ledger).
 *
 * The hash is computed in TypeScript (not a SQL trigger) because a trigger cannot
 * cheaply read the previous row's hash + compute sha256; triggers here only enforce
 * append-only (reject UPDATE/DELETE). See migration v7.
 */
import { createHash } from 'node:crypto';
import type { SqliteDriver } from '../database/connection.js';
import type { Clock, IdGen } from '../shared/clock.js';
import { XBusError, XBusErrorCode } from '../protocol/errors.js';

/** 64 zero hex chars — the genesis `prev_hash` for the first event. */
export const LEDGER_GENESIS_HASH = '0'.repeat(64);

export interface LedgerSubject {
  sessionId?: string;
  threadId?: string;
  messageId?: string;
}

/** Thrown by the recursive canonicalizer when a value cannot be canonically encoded
 *  (undefined, non-finite number, function, symbol, bigint). Callers convert it to
 *  AUDIT_PERSISTENCE_FAILED on write, or treat it as a chain break on verify. */
export class LedgerCanonicalizationError extends Error {}

/**
 * Recursively canonicalize a JSON-ish value to a deterministic string, UTF-8:
 *  - object keys sorted at EVERY depth (not just the top level),
 *  - arrays preserved in order,
 *  - strings/finite-numbers/booleans/null encoded as standard JSON,
 *  - UNSUPPORTED values REJECTED (throw) rather than silently coerced: `undefined`,
 *    `NaN`/`±Infinity`, functions, symbols, bigints. (Plain `JSON.stringify` would drop
 *    `undefined`, coerce non-finite numbers to `null`, and ignore functions — hiding a
 *    bug in the hashed content. ADR 0020 Q4 requires the canonicalization to reject them.)
 * For the flat, safe payloads we actually store (ids/states/counts/hashes) the output is
 * byte-identical to sorted-key JSON, so frozen vectors stay stable across builds.
 */
function canonicalize(value: unknown, at: string): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new LedgerCanonicalizationError(`non-finite number at ${at}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    // Reject SPARSE arrays: a hole reads as `undefined` here but JSON.stringify emits
    // `null`, so canonicalize(x) would differ from canonicalize(JSON.parse(stringify(x)))
    // — a silent write-vs-verify hash divergence. Fail loud instead.
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) throw new LedgerCanonicalizationError(`sparse array hole at ${at}[${i}]`);
    }
    return '[' + value.map((v, i) => canonicalize(v, `${at}[${i}]`)).join(',') + ']';
  }
  if (t === 'object') {
    // ONLY plain objects (prototype Object.prototype or null) are canonicalized structurally.
    // A Date / class instance / any object with a custom `toJSON` serializes via JSON.stringify
    // to something OTHER than its own-enumerable-key view (e.g. `new Date()` → an ISO string,
    // but Object.keys(date) === []), so canonicalize(live) would differ from
    // canonicalize(JSON.parse(stringify(live))) — a permanent spurious chain break on verify.
    // Reject them at WRITE time (fail loud) rather than silently corrupt the chain. Our safe
    // payloads are flat ids/states/counts/hashes, so this never rejects a legitimate value.
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new LedgerCanonicalizationError(`non-plain object at ${at}`);
    }
    if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
      throw new LedgerCanonicalizationError(`object with custom toJSON at ${at}`);
    }
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(obj).sort()) {
      const v = obj[k];
      // A present key whose value is `undefined` is ambiguous (JSON.stringify would drop
      // the whole key) — reject it so the hashed content is unambiguous.
      if (v === undefined) throw new LedgerCanonicalizationError(`undefined value at ${at}.${k}`);
      parts.push(JSON.stringify(k) + ':' + canonicalize(v, `${at}.${k}`));
    }
    return '{' + parts.join(',') + '}';
  }
  // undefined / function / symbol / bigint
  throw new LedgerCanonicalizationError(`unsupported ${t} at ${at}`);
}

/**
 * Canonical serialization of the hashed fields: sorted-key JSON at every depth, UTF-8.
 * Identical on write and on verify (a test pins frozen vectors), so the chain is
 * reproducible across builds/platforms. Throws LedgerCanonicalizationError on an
 * un-encodable value (see canonicalize).
 */
export function canonicalLedgerPayload(row: {
  seq: number;
  eventType: string;
  actor: string;
  subject: LedgerSubject;
  payload: Record<string, unknown>;
  createdAt: string;
}): string {
  return canonicalize(
    {
      seq: row.seq,
      eventType: row.eventType,
      actor: row.actor,
      subject: row.subject,
      payload: row.payload,
      createdAt: row.createdAt,
    },
    '$',
  );
}

/** Compute the entry hash for a row given the previous row's entry hash. */
export function computeEntryHash(prevHash: string, canonical: string): string {
  return createHash('sha256').update(prevHash + canonical, 'utf8').digest('hex');
}

/**
 * Append one event to `ledger_events`, chained to the current tip. MUST be called
 * inside the caller's `db.transaction(...)` (so it shares the state mutation's fate).
 * Throws XBusError(AUDIT_PERSISTENCE_FAILED) on any ledger-specific failure, which
 * rolls back the whole transaction (no state-without-audit).
 */
export function ledgerAppend(
  db: SqliteDriver,
  ids: IdGen,
  clock: Clock,
  eventType: string,
  actor: string,
  subject: LedgerSubject,
  payload: Record<string, unknown>,
): void {
  try {
    // Current tip: highest seq (and its entry_hash) among live rows, else the newest
    // anchor (a pruned prefix's trust root), else genesis. Dense: nextSeq = tip + 1.
    const tip = db
      .prepare('SELECT seq, entry_hash AS entryHash FROM ledger_events ORDER BY seq DESC LIMIT 1')
      .get() as { seq: number; entryHash: string } | undefined;
    let prevSeq: number;
    let prevHash: string;
    if (tip) {
      prevSeq = tip.seq;
      prevHash = tip.entryHash;
    } else {
      const anchor = db
        .prepare('SELECT anchor_seq AS anchorSeq, anchor_hash AS anchorHash FROM ledger_anchors ORDER BY anchor_seq DESC LIMIT 1')
        .get() as { anchorSeq: number; anchorHash: string } | undefined;
      if (anchor) { prevSeq = anchor.anchorSeq; prevHash = anchor.anchorHash; }
      else { prevSeq = 0; prevHash = LEDGER_GENESIS_HASH; }
    }
    const seq = prevSeq + 1;
    const createdAt = clock.nowIso();
    const subjectJson = JSON.stringify(subject);
    const payloadJson = JSON.stringify(payload);
    const canonical = canonicalLedgerPayload({ seq, eventType, actor, subject, payload, createdAt });
    const entryHash = computeEntryHash(prevHash, canonical);
    db.prepare(
      'INSERT INTO ledger_events (event_id, seq, event_type, actor, subject_json, payload_json, created_at, prev_hash, entry_hash) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(ids.next(), seq, eventType, actor, subjectJson, payloadJson, createdAt, prevHash, entryHash);
  } catch (e) {
    if (e instanceof XBusError) throw e;
    throw new XBusError(
      XBusErrorCode.AUDIT_PERSISTENCE_FAILED,
      'audit ledger append failed; the operation was aborted to avoid state without an audit record',
    );
  }
}

export interface LedgerVerifyResult {
  ok: boolean;
  checked: number;
  /** First broken seq (expected vs actual), when ok=false. */
  firstBreak?: { seq: number; expectedPrev: string; actualPrev: string; recomputed: string; stored: string };
}

/**
 * Recompute the whole chain in seq order and verify: (a) dense/gap-free from the
 * newest anchor below the surviving prefix (or genesis), (b) each prev_hash links to
 * the prior entry_hash, (c) each entry_hash matches recomputation. Reports the FIRST
 * break so tampering / a dropped row / bit-rot is localized. (ADR 0020 Q4.)
 */
export function verifyLedger(db: SqliteDriver): LedgerVerifyResult {
  const rows = db
    .prepare('SELECT seq, event_type AS eventType, actor, subject_json AS subjectJson, payload_json AS payloadJson, created_at AS createdAt, prev_hash AS prevHash, entry_hash AS entryHash FROM ledger_events ORDER BY seq ASC')
    .all() as Array<{ seq: number; eventType: string; actor: string; subjectJson: string; payloadJson: string; createdAt: string; prevHash: string; entryHash: string }>;
  if (rows.length === 0) return { ok: true, checked: 0 };
  // Genesis pointer for the surviving prefix: the newest anchor strictly below the
  // minimum remaining seq (a pruned boundary), else the true genesis.
  const minSeq = rows[0]!.seq;
  const anchor = db
    .prepare('SELECT anchor_seq AS anchorSeq, anchor_hash AS anchorHash FROM ledger_anchors WHERE anchor_seq < ? ORDER BY anchor_seq DESC LIMIT 1')
    .get(minSeq) as { anchorSeq: number; anchorHash: string } | undefined;
  let expectedPrev = anchor ? anchor.anchorHash : LEDGER_GENESIS_HASH;
  let expectedSeq = anchor ? anchor.anchorSeq + 1 : 1;
  for (const r of rows) {
    // A row whose subject/payload JSON was corrupted into non-parseable text (bit-rot, a
    // direct file edit, a partial write) is EXACTLY what verify must localize — so a parse
    // failure is a chain BREAK at this seq, never an uncaught throw out of verify. Same for
    // a canonicalization failure (a value that can't be re-canonicalized). Report the first
    // such break with a sentinel recomputed hash so the caller sees ok:false + the seq.
    let canonical: string;
    try {
      canonical = canonicalLedgerPayload({
        seq: r.seq, eventType: r.eventType, actor: r.actor,
        subject: JSON.parse(r.subjectJson) as LedgerSubject,
        payload: JSON.parse(r.payloadJson) as Record<string, unknown>,
        createdAt: r.createdAt,
      });
    } catch {
      return {
        ok: false,
        checked: r.seq - minSeq,
        firstBreak: { seq: r.seq, expectedPrev, actualPrev: r.prevHash, recomputed: 'unparseable', stored: r.entryHash },
      };
    }
    const recomputed = computeEntryHash(r.prevHash, canonical);
    if (r.seq !== expectedSeq || r.prevHash !== expectedPrev || recomputed !== r.entryHash) {
      return {
        ok: false,
        checked: r.seq - minSeq,
        firstBreak: { seq: r.seq, expectedPrev, actualPrev: r.prevHash, recomputed, stored: r.entryHash },
      };
    }
    expectedPrev = r.entryHash;
    expectedSeq = r.seq + 1;
  }
  return { ok: true, checked: rows.length };
}
