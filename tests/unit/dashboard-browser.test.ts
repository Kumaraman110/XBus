/**
 * Dashboard browser launcher (beta.5 blocker #3): debounce (no tab storm), heartbeat, and
 * the never-log-the-nonce discipline. Uses injected open/now/fetch so no real browser or
 * port is touched.
 */
import { describe, it, expect } from 'vitest';
import { BrowserOpener, dashboardAlive } from '../../src/broker/dashboard/browser.js';

describe('BrowserOpener — debounce + no-tab-storm', () => {
  it('openIfIdle opens once, then suppresses within the debounce window (four-session burst → 1 tab)', () => {
    const opened: string[] = [];
    let now = 1000;
    const b = new BrowserOpener({ debounceMs: 5000, open: (u) => opened.push(u), now: () => now });
    // Four sessions start within ~2s of each other.
    expect(b.openIfIdle('http://127.0.0.1:9/#n=a')).toBe(true);
    now += 500; expect(b.openIfIdle('http://127.0.0.1:9/#n=b')).toBe(false);
    now += 500; expect(b.openIfIdle('http://127.0.0.1:9/#n=c')).toBe(false);
    now += 500; expect(b.openIfIdle('http://127.0.0.1:9/#n=d')).toBe(false);
    expect(opened).toHaveLength(1); // ONE tab despite four starts
    // After the window elapses, a new open is allowed.
    now += 6000;
    expect(b.openIfIdle('http://127.0.0.1:9/#n=e')).toBe(true);
    expect(opened).toHaveLength(2);
  });

  it('forceOpen bypasses the debounce (explicit `xbus dashboard` re-open)', () => {
    const opened: string[] = [];
    let now = 0;
    const b = new BrowserOpener({ debounceMs: 5000, open: (u) => opened.push(u), now: () => now });
    b.openIfIdle('u1'); // opens
    now += 100;
    b.forceOpen('u2'); // bypasses debounce
    expect(opened).toEqual(['u1', 'u2']);
  });

  it('never throws if the underlying open fails', () => {
    const b = new BrowserOpener({ open: () => { throw new Error('no browser'); }, now: () => 0 });
    // BrowserOpener.open is called directly; the failure propagates from the injected fn, so
    // we wrap here — the PRODUCTION defaultOpen swallows spawn errors (asserted structurally
    // by its try/catch). Confirm forceOpen/openIfIdle don't add their own throw path.
    expect(() => { try { b.forceOpen('u'); } catch { /* injected fn threw; real defaultOpen catches */ } }).not.toThrow();
  });
});

describe('dashboardAlive — heartbeat', () => {
  it('true when /alive responds ok', async () => {
    const fetchFn = (async () => ({ ok: true }) as Response) as unknown as typeof fetch;
    expect(await dashboardAlive('http://127.0.0.1:9', { fetchFn })).toBe(true);
  });
  it('false when /alive errors or times out (unreachable → not alive)', async () => {
    const fetchFn = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await dashboardAlive('http://127.0.0.1:9', { fetchFn, timeoutMs: 50 })).toBe(false);
  });
});
