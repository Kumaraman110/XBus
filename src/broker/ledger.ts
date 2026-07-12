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

/**
 * Canonical serialization of the hashed fields: a fixed field order with
 * sorted-key JSON, UTF-8. Identical on write and on verify (a test pins frozen
 * vectors), so the chain is reproducible across builds/platforms.
 */
export function canonicalLedgerPayload(row: {
  seq: number;
  eventType: string;
  actor: string;
  subject: LedgerSubject;
  payload: Record<string, unknown>;
  createdAt: string;
}): string {
  // Sort object keys deterministically (one level deep is sufficient for our safe,
  // flat payloads; nested objects are stringified with sorted keys too via replacer).
  const sortKeys = (_k: string, v: unknown): unknown => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>).sort().reduce((acc, k) => {
        acc[k] = (v as Record<string, unknown>)[k];
        return acc;
      }, {} as Record<string, unknown>);
    }
    return v;
  };
  return JSON.stringify(
    {
      seq: row.seq,
      eventType: row.eventType,
      actor: row.actor,
      subject: row.subject,
      payload: row.payload,
      createdAt: row.createdAt,
    },
    sortKeys,
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
    const canonical = canonicalLedgerPayload({
      seq: r.seq, eventType: r.eventType, actor: r.actor,
      subject: JSON.parse(r.subjectJson) as LedgerSubject,
      payload: JSON.parse(r.payloadJson) as Record<string, unknown>,
      createdAt: r.createdAt,
    });
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
