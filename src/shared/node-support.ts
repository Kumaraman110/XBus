/**
 * Node.js support boundary (§8). The published `engines` range is ">=22.5 <25".
 * Node 25 is NOT yet validated by the clean-machine acceptance suite, so it is
 * outside the supported boundary until that proof exists. This guard reports an
 * ACTIONABLE error EARLY (at CLI/broker entry) rather than failing deep inside
 * installation or a test.
 */

/** Inclusive lower / exclusive upper bound on the Node MAJOR version. */
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR_AT_MIN_MAJOR = 5; // >= 22.5
export const MAX_NODE_MAJOR_EXCLUSIVE = 25;   // < 25 (Node 25 not yet validated)

export interface NodeSupport {
  ok: boolean;
  version: string;
  major: number;
  minor: number;
  /** Actionable message when unsupported (empty when ok). */
  message: string;
}

/** Parse a `process.version`-style string ("v22.5.1") into major/minor. */
export function parseNodeVersion(v: string): { major: number; minor: number } {
  const m = /^v?(\d+)\.(\d+)\./.exec(v);
  if (!m) return { major: 0, minor: 0 };
  return { major: Number(m[1]), minor: Number(m[2]) };
}

/** Evaluate a version string against the supported boundary (pure; testable). */
export function evaluateNodeSupport(versionString: string): NodeSupport {
  const { major, minor } = parseNodeVersion(versionString);
  const tooOld = major < MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor < MIN_NODE_MINOR_AT_MIN_MAJOR);
  const tooNew = major >= MAX_NODE_MAJOR_EXCLUSIVE;
  const ok = !tooOld && !tooNew;
  let message = '';
  if (tooOld) {
    message = `XBus requires Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR_AT_MIN_MAJOR} (you have ${versionString}). Install Node ${MIN_NODE_MAJOR} LTS or Node 24, then retry.`;
  } else if (tooNew) {
    message = `XBus does not yet support Node.js ${major}.x (you have ${versionString}). Supported: Node ${MIN_NODE_MAJOR} LTS through Node ${MAX_NODE_MAJOR_EXCLUSIVE - 1}. Node ${MAX_NODE_MAJOR_EXCLUSIVE}+ has not passed the clean-machine acceptance suite. Use Node ${MAX_NODE_MAJOR_EXCLUSIVE - 1} or Node ${MIN_NODE_MAJOR} LTS.`;
  }
  return { ok, version: versionString, major, minor, message };
}

/**
 * Assert the running Node is supported. On an unsupported version, prints the
 * actionable message to stderr and exits non-zero — EARLY, before install/test
 * machinery runs. Set `XBUS_ALLOW_UNSUPPORTED_NODE=1` to bypass (for maintainers
 * validating a new major); the bypass prints a visible warning and does not lie
 * about support status.
 */
export function assertSupportedNode(opts: { version?: string; exit?: (code: number) => never; warn?: (s: string) => void } = {}): NodeSupport {
  const version = opts.version ?? process.version;
  const warn = opts.warn ?? ((s: string) => process.stderr.write(s + '\n'));
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const support = evaluateNodeSupport(version);
  if (support.ok) return support;
  if (process.env.XBUS_ALLOW_UNSUPPORTED_NODE === '1') {
    warn(`[xbus] WARNING (unsupported Node bypassed via XBUS_ALLOW_UNSUPPORTED_NODE): ${support.message}`);
    return support;
  }
  warn(`[xbus] ${support.message}`);
  exit(1);
  return support; // unreachable when exit truly exits
}
