/**
 * Component roles + the capability matrix (ADR 0003 §5). Fail closed for any
 * (role, operation) not explicitly allowed.
 */
import { XBusError, XBusErrorCode } from '../protocol/errors.js';

export const ComponentRole = {
  MCP: 'mcp',
  HOOK: 'hook',
  TRANSPORT: 'transport',
  CLI: 'cli',
  ADMIN: 'admin',
} as const;
export type ComponentRole = (typeof ComponentRole)[keyof typeof ComponentRole];

export const ROLES: readonly ComponentRole[] = ['mcp', 'hook', 'transport', 'cli', 'admin'];

export function isComponentRole(s: string): s is ComponentRole {
  return (ROLES as readonly string[]).includes(s);
}

/** Operations gated by the capability matrix. */
export const Operation = {
  REGISTER: 'register',
  SEND: 'send',
  PULL_HOOK_CHECKPOINT: 'pull_hook_checkpoint',
  MARK_INJECTED: 'mark_injected',
  ACK: 'ack',
  REPLY: 'reply',
  LIST_INBOX: 'list_inbox',
  LIST_SESSIONS: 'list_sessions',
  GET_METRICS: 'get_metrics',
  DEAD_LETTER: 'dead_letter',
  CHANGE_ALIAS: 'change_alias',
  SHUTDOWN: 'shutdown',
} as const;
export type Operation = (typeof Operation)[keyof typeof Operation];

/**
 * Allowed (role -> operations). Anything not listed is denied (fail closed).
 * 'send' for cli/admin is allowed as an admin convenience (the CLI's `xbus send`).
 */
const MATRIX: Record<ComponentRole, ReadonlySet<Operation>> = {
  mcp: new Set(['register', 'send', 'ack', 'reply', 'list_inbox', 'list_sessions', 'change_alias']),
  hook: new Set(['register', 'pull_hook_checkpoint', 'mark_injected', 'list_inbox']),
  transport: new Set(['register', 'mark_injected']),
  cli: new Set(['register', 'send', 'list_sessions', 'list_inbox']),
  admin: new Set(['register', 'send', 'list_sessions', 'list_inbox', 'get_metrics', 'dead_letter', 'change_alias', 'shutdown']),
};

export function isAllowed(role: ComponentRole, op: Operation): boolean {
  return MATRIX[role]?.has(op) ?? false;
}

/** Throw XBUS_FORBIDDEN_ROLE if the role may not perform the operation. */
export function assertAllowed(role: ComponentRole, op: Operation): void {
  if (!isAllowed(role, op)) {
    throw new XBusError(XBusErrorCode.FORBIDDEN_ROLE, `role '${role}' may not perform '${op}'`, { role, op });
  }
}
