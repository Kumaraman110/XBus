/**
 * Dashboard auth bootstrap — the nonce → exchange → tab-token flow (ADR 0018 D2).
 *
 * BROKER-OWNED, IN-MEMORY ONLY. Neither the nonce nor the tab token is ever written to
 * disk, the ledger, or a log; the nonce travels ONLY in the URL fragment (never sent to
 * the server), and the tab token travels ONLY in an `Authorization: Bearer` header. We
 * store HASHES (sha256) of both, so even a memory dump of this store doesn't reveal a
 * usable credential without the original secret. Single instance, lives with the broker
 * process; cleared on broker stop.
 *
 * Threat model (ADR 0018): loopback is shared across local OS users, so the token — not
 * the loopback bind — is the boundary for `/api/*`. The one-time nonce lets the broker
 * hand a freshly-opened tab an authenticator without a durable URL secret or a cookie.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../../shared/clock.js';

/** CSPRNG token, URL-safe base64url, 32 bytes (256 bits). */
export function mintSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Constant-time compare of two hex digests (equal length). */
function hashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

interface NonceRecord { hash: string; expiresAt: number; consumedAt: number | null; }
interface TokenRecord { hash: string; expiresAt: number; }

export interface AuthConfig {
  /** One-time nonce TTL (ms). Default 60s (ADR 0018 D2). */
  nonceTtlMs?: number;
  /** Tab-token TTL (ms). Default 30 min (ADR 0018 D2). */
  tokenTtlMs?: number;
}

/**
 * The broker-owned auth store. Runs on the WRITER side (broker loop) — /auth/exchange is
 * the ONE mutating route, and it mutates only THIS ephemeral store (no product state).
 */
export class DashboardAuth {
  private readonly nonces = new Map<string, NonceRecord>();   // key = nonce hash
  private readonly tokens = new Map<string, TokenRecord>();   // key = token hash
  private readonly nonceTtlMs: number;
  private readonly tokenTtlMs: number;

  constructor(private readonly clock: Clock, cfg: AuthConfig = {}) {
    this.nonceTtlMs = cfg.nonceTtlMs ?? 60_000;
    this.tokenTtlMs = cfg.tokenTtlMs ?? 30 * 60_000;
  }

  /**
   * Mint a one-time nonce for a browser-open. Returns the CLEARTEXT nonce (to place in the
   * URL fragment); only its hash is retained. CSPRNG + short TTL + single-use.
   */
  mintNonce(): string {
    this.sweep();
    const nonce = mintSecret(16);
    this.nonces.set(sha256(nonce), { hash: sha256(nonce), expiresAt: this.clock.nowMs() + this.nonceTtlMs, consumedAt: null });
    return nonce;
  }

  /**
   * Atomically consume a nonce and, on success, issue a short-lived tab token. Returns the
   * cleartext token + expiry, or null if the nonce is unknown / expired / already consumed.
   * The consume is a compare-and-set on `consumedAt` (single-use): a second exchange of the
   * same nonce finds consumedAt set → null (mirrors the SQL `UPDATE … WHERE consumed_at IS
   * NULL` affected-row CAS in ADR 0018 D2). Because node is single-threaded and this runs on
   * the broker loop, the check-then-set has no interleaving window.
   */
  exchange(nonce: string): { token: string; expiresAt: number } | null {
    if (typeof nonce !== 'string' || nonce.length === 0) return null;
    this.sweep();
    const key = sha256(nonce);
    const rec = this.nonces.get(key);
    const now = this.clock.nowMs();
    if (!rec || rec.consumedAt !== null || rec.expiresAt <= now) return null;
    if (!hashEquals(rec.hash, key)) return null; // defense-in-depth (constant time)
    rec.consumedAt = now; // CAS: single-use
    const token = mintSecret(32);
    this.tokens.set(sha256(token), { hash: sha256(token), expiresAt: now + this.tokenTtlMs });
    return { token, expiresAt: now + this.tokenTtlMs };
  }

  /** Validate a bearer tab token (constant-time, TTL-checked). No side effects. */
  validateToken(token: string | undefined): boolean {
    if (typeof token !== 'string' || token.length === 0) return false;
    const key = sha256(token);
    const rec = this.tokens.get(key);
    if (!rec) return false;
    if (rec.expiresAt <= this.clock.nowMs()) { this.tokens.delete(key); return false; }
    return hashEquals(rec.hash, key);
  }

  /** Drop expired nonces + tokens (bounded memory). Called on each mint/exchange. */
  private sweep(): void {
    const now = this.clock.nowMs();
    for (const [k, v] of this.nonces) if (v.expiresAt <= now || (v.consumedAt !== null && v.consumedAt + this.nonceTtlMs <= now)) this.nonces.delete(k);
    for (const [k, v] of this.tokens) if (v.expiresAt <= now) this.tokens.delete(k);
  }

  /** Diagnostics only — counts, never the secrets themselves. */
  stats(): { nonces: number; tokens: number } {
    return { nonces: this.nonces.size, tokens: this.tokens.size };
  }
}
