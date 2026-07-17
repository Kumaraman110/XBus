/**
 * Beta.9 (ADR 0029): the bootstrap's download-error CLASSIFIER turns raw socket/TLS/proxy errors
 * into concise, fail-closed, actionable remediation (never a raw stack, never a TLS bypass). This
 * unit-tests the pure classifier exported from scripts/agentel.mjs.
 */
import { describe, it, expect } from 'vitest';
// scripts/agentel.mjs is Node-built-ins-only and guards its main() to invoke-directly, so importing
// it here is side-effect-free.
// @ts-expect-error — .mjs script without types; we only use its exported pure functions.
import { classifyDownloadError, offlineRemediation } from '../../scripts/agentel.mjs';

const URL = 'https://nodejs.org/dist/v22.23.1/node-v22.23.1-win-x64.zip';
function err(code: string, message?: string): Error & { code?: string } {
  const e = new Error(message ?? code) as Error & { code?: string };
  e.code = code;
  return e;
}

describe('bootstrap download-error classification', () => {
  it('every message names all three offline alternatives (cache / vendor / AGENTEL_VERIFY_NODE)', () => {
    const rem = offlineRemediation();
    expect(rem).toMatch(/\.agentel[\\/]cache/i);
    expect(rem).toMatch(/\.agentel[\\/]node/i);
    expect(rem).toContain('AGENTEL_VERIFY_NODE');
  });

  it('classifies ECONNRESET (and points at the offline alternatives, not a stack)', () => {
    const m = classifyDownloadError(err('ECONNRESET', 'read ECONNRESET'), URL);
    expect(m).toMatch(/ECONNRESET/);
    expect(m).toMatch(/reset/i);
    expect(m).toContain('AGENTEL_VERIFY_NODE');
    expect(m).not.toMatch(/\bat \w+.*:\d+:\d+/); // no stack frames
  });

  it('classifies a "socket hang up" as the ECONNRESET class', () => {
    const m = classifyDownloadError(err('', 'socket hang up'), URL);
    expect(m).toMatch(/reset|socket hang up/i);
    expect(m).toContain('.agentel');
  });

  it('classifies ECONNREFUSED', () => {
    const m = classifyDownloadError(err('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:9'), URL);
    expect(m).toMatch(/ECONNREFUSED/);
    expect(m).toMatch(/refused/i);
    expect(m).toContain('AGENTEL_VERIFY_NODE');
  });

  it('classifies ETIMEDOUT', () => {
    const m = classifyDownloadError(err('ETIMEDOUT'), URL);
    expect(m).toMatch(/ETIMEDOUT/);
    expect(m).toMatch(/timed out/i);
  });

  it('classifies TLS/certificate errors and explicitly refuses to disable verification', () => {
    const m = classifyDownloadError(err('DEPTH_ZERO_SELF_SIGNED_CERT', 'unable to verify the first certificate'), URL);
    expect(m).toMatch(/TLS|certificate/i);
    expect(m).toMatch(/NOT disable/i);
  });

  it('passes a PROXY_UNSUPPORTED message through unchanged (already a full remediation)', () => {
    const full = `PROXY_UNSUPPORTED: HTTPS_PROXY is set (http://p:8080)\n${offlineRemediation()}`;
    const m = classifyDownloadError(err('', full), URL);
    expect(m).toBe(full);
  });

  it('falls back to a described-cause message (still actionable) for an unknown code', () => {
    const m = classifyDownloadError(err('EWEIRD', 'something odd'), URL);
    expect(m).toContain('EWEIRD');
    expect(m).toContain('AGENTEL_VERIFY_NODE');
    expect(m).toMatch(/Could not download/i);
  });
});
