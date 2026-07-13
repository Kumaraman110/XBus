/**
 * Default-browser launcher for the dashboard (beta.5 blocker #3; ADR 0015).
 *
 * Opens `http://127.0.0.1:<port>/#n=<nonce>` in the user's default browser, with a
 * DEBOUNCE so several sessions starting within seconds (the four-replica case) don't storm
 * tabs, and a HEARTBEAT check (`/alive`) so a second open focuses/relies on the already-open
 * dashboard instead of spawning another server. The nonce lives only in the URL fragment,
 * which is never sent to the server, never logged, never persisted (ADR 0018 D2) — so this
 * module logs "opened dashboard" WITHOUT the URL.
 *
 * `spawn` + `fetch` are injectable so tests drive the debounce/heartbeat logic without
 * actually opening a browser or binding a port.
 */
import { spawn as realSpawn } from 'node:child_process';

/** Injectable seam: launch a URL in the default browser. Resolves once handed off. */
export type OpenFn = (url: string) => void;

/** Default per-platform open. Detached + stdio-ignored so it never blocks the broker. */
export function defaultOpen(url: string): void {
  const plat = process.platform;
  const [cmd, args]: [string, string[]] = plat === 'win32'
    // `cmd /c start "" <url>` — the empty title arg is required so a quoted URL isn't treated
    // as the window title.
    ? ['cmd', ['/c', 'start', '', url]]
    : plat === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const c = realSpawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    // CRITICAL: a missing launcher binary (e.g. headless Linux with no xdg-open) does NOT
    // throw synchronously — spawn emits an ASYNC 'error' event, and a ChildProcess with no
    // 'error' listener throws on emit → an uncaught exception that would crash the broker/CLI.
    // Attach a no-op listener so a launch failure stays best-effort ("never affects the broker").
    c.on('error', () => { /* browser-open failed (binary missing / not permitted) — ignore */ });
    c.unref();
  } catch { /* best-effort: a synchronous spawn failure must never affect the broker either */ }
}

export interface BrowserOpenerConfig {
  /** Debounce window: a second openIfIdle within this many ms is suppressed. Default 5000. */
  debounceMs?: number;
  /** Injected opener (tests). Default: platform default-browser launch. */
  open?: OpenFn;
  /** Injected clock (ms). Default Date.now via a monotonic-ish counter is NOT used here — a
   *  real timestamp source is required; tests pass a fake. */
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Debounced browser opener. `openIfIdle(url)` opens at most once per debounce window; a
 * rapid burst (four sessions starting together) yields ONE tab. `forceOpen(url)` bypasses
 * the debounce (an explicit `xbus dashboard` re-open). Never throws.
 */
export class BrowserOpener {
  private readonly debounceMs: number;
  private readonly open: OpenFn;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private lastOpenedAt = -Infinity;

  constructor(cfg: BrowserOpenerConfig = {}) {
    this.debounceMs = cfg.debounceMs ?? 5000;
    this.open = cfg.open ?? defaultOpen;
    this.now = cfg.now ?? (() => Date.now());
    this.log = cfg.log ?? (() => {});
  }

  /** Open only if outside the debounce window. Returns true iff it actually opened. */
  openIfIdle(url: string): boolean {
    const t = this.now();
    if (t - this.lastOpenedAt < this.debounceMs) {
      this.log('dashboard open debounced (already opened recently)');
      return false;
    }
    this.lastOpenedAt = t;
    this.open(url);
    this.log('opened dashboard in default browser'); // NOTE: never log the URL (carries a nonce)
    return true;
  }

  /** Explicit re-open (e.g. `xbus dashboard`): bypasses the debounce, still stamps it. */
  forceOpen(url: string): void {
    this.lastOpenedAt = this.now();
    this.open(url);
    this.log('opened dashboard in default browser');
  }
}

/**
 * Heartbeat: is a dashboard already reachable at `baseUrl/alive`? Bounded by `timeoutMs` so a
 * dead port never hangs the caller. Uses injectable `fetchFn` (tests). Returns false on any
 * error/timeout (treat unreachable as "not alive" → the caller starts/open its own).
 */
export async function dashboardAlive(baseUrl: string, opts: { timeoutMs?: number; fetchFn?: typeof fetch } = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 1000;
  const f = opts.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(`${baseUrl}/alive`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
