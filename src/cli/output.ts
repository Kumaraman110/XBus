/**
 * CLI output helpers. Human-readable by default; --json emits structured output.
 * Every failure suggests one safe next action. Never prints raw stack traces by
 * default.
 */
import { isXBusError } from '../protocol/errors.js';

export interface CliResult {
  human: string;
  json: unknown;
  exitCode: number;
}

const NEXT_ACTION: Record<string, string> = {
  XBUS_UNKNOWN_RECIPIENT: 'Recipient not found. Run: xbus sessions',
  XBUS_AMBIGUOUS_RECIPIENT: 'Recipient is ambiguous. Use a qualified alias (project/alias) or the exact session ID.',
  XBUS_BROKER_UNAVAILABLE: 'Broker unavailable. Run: xbus doctor',
  XBUS_SESSION_FENCED: 'This session was superseded by a newer instance. Restart the session.',
  XBUS_INVALID_ALIAS: 'Alias is invalid. Use ASCII letters, digits, "_" or "-" (max 128).',
};

export function errorResult(e: unknown): CliResult {
  if (isXBusError(e)) {
    const next = NEXT_ACTION[e.code] ?? 'Run: xbus doctor';
    return {
      human: `Error: ${e.message}\n${next}`,
      json: { ok: false, ...e.toWire(), nextAction: next },
      exitCode: 1,
    };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { human: `Error: ${msg}\nRun: xbus doctor`, json: { ok: false, message: msg }, exitCode: 1 };
}

export function emit(result: CliResult, asJson: boolean): never {
  if (asJson) process.stdout.write(JSON.stringify(result.json, null, 2) + '\n');
  else process.stdout.write(result.human + '\n');
  process.exit(result.exitCode);
}

export function formatSessions(sessions: Array<Record<string, unknown>>): string {
  if (sessions.length === 0) return 'No XBus sessions are currently registered.';
  // §2: Connection (socket attached?), Receive mode (HOW it takes delivery) and
  // Readiness (is it SAFE to inject now?) are SEPARATE columns — never conflated.
  const header = ['Alias', 'Project', 'Connection', 'Receive mode', 'Readiness', 'Last checkpoint', 'Queued', 'Unacked'];
  // Session rows arrive as loosely-typed wire data (Record<string, unknown>); the
  // displayed fields are scalar by contract (strings/numbers/null). Cast each to
  // its expected primitive so String() coerces a known base type, not a possible
  // object (no-base-to-string) — same idiom as the DB-row casts elsewhere.
  const rows = sessions.map((s) => [
    String((s.alias as string | undefined) ?? ''),
    String((s.project as string | undefined) ?? '').slice(0, 18),
    String((s.connection as string | undefined) ?? ''),
    String((s.receiveMode as string | undefined) ?? ''),
    String((s.readiness as string | undefined) ?? 'unknown'),
    s.lastCheckpoint ? String(s.lastCheckpoint as string).slice(11, 19) : '-',
    String((s.queued as number | undefined) ?? 0),
    String((s.unacknowledged as number | undefined) ?? 0),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  return [fmt(header), fmt(widths.map((w) => '-'.repeat(w))), ...rows.map(fmt)].join('\n');
}

/** §1 — short human table for `xbus metrics` (the --json form is the full shape). */
export function formatMetrics(m: {
  broker: { instanceId: string; buildId: string; uptimeMs: number; secureTransport: boolean };
  transport: { connections: { active: number; max: number }; buffer: { bytesInUse: number; budgetBytes: number }; handshakes: { ok: number; authFailed: number; protoMismatch: number; timedOut: number }; refusals: { connLimit: number; rateLimit: number }; frames: { preHandshakeRejected: number; secureOpenFailed: number } };
  deliveries: Record<string, number>;
  reaper: { sweepsTotal: number; lastSweepAt: string | null; totals: { ackTimedOut: number; deadLettered: number; expired: number; leasesReclaimed: number } };
  sessions: { byReadiness: Record<string, number> };
  injections: { total: number; redeliveries: number };
}): string {
  const h = m.transport.handshakes; const f = m.transport.frames; const rf = m.transport.refusals;
  const dl = (s: string) => m.deliveries[s] ?? 0;
  const rt = m.reaper.totals;
  const ready = Object.entries(m.sessions.byReadiness).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ') || '(none)';
  return [
    'XBus metrics',
    `  broker:       ${m.broker.buildId} instance=${m.broker.instanceId} uptime=${Math.round(m.broker.uptimeMs / 1000)}s secure=${m.broker.secureTransport}`,
    `  connections:  ${m.transport.connections.active}/${m.transport.connections.max}  buffer ${m.transport.buffer.bytesInUse}/${m.transport.buffer.budgetBytes} bytes`,
    `  handshakes:   ok=${h.ok} auth_failed=${h.authFailed} proto_mismatch=${h.protoMismatch} timed_out=${h.timedOut}`,
    `  refusals:     conn_limit=${rf.connLimit} rate_limit=${rf.rateLimit}  frames pre_handshake=${f.preHandshakeRejected} secure_open=${f.secureOpenFailed}`,
    `  deliveries:   queued=${dl('queued')} retry_wait=${dl('retry_wait')} transport_written=${dl('transport_written')} accepted=${dl('accepted')} completed=${dl('completed')} expired=${dl('expired')} dead_letter=${dl('dead_letter')} cancelled=${dl('cancelled')}`,
    `  reaper:       sweeps=${m.reaper.sweepsTotal} ack_timed_out=${rt.ackTimedOut} dead_lettered=${rt.deadLettered} expired=${rt.expired} leases_reclaimed=${rt.leasesReclaimed} last=${m.reaper.lastSweepAt ?? '-'}`,
    `  sessions:     ${ready}`,
    `  injections:   total=${m.injections.total} redeliveries=${m.injections.redeliveries}`,
  ].join('\n');
}

export function formatSendResult(r: { messageId: string; sequence: number; state: string; recipientAlias: string; recipientReceiveMode?: string }): string {
  if (r.state === 'queued_until_checkpoint') {
    return [
      `Message queued for ${r.recipientAlias}.`,
      '',
      'The receiving session uses checkpoint delivery and may be idle.',
      'It will receive this message at its next supported Claude lifecycle checkpoint',
      '(for example, the next time its user submits a prompt).',
      '',
      `Message ID: ${r.messageId}`,
      `Sequence: ${r.sequence}`,
      `State: ${r.state}`,
    ].join('\n');
  }
  return `Message ${r.messageId} to ${r.recipientAlias}: ${r.state} (sequence ${r.sequence}).`;
}
