/**
 * Result types returned by the XBusAdapter methods (§11). Content-free where it
 * matters: a ReceiveResult carries the already-fenced presentation string for the
 * host to surface, plus counts — never raw peer bodies in fields meant for metrics.
 */

import type { SupportTier } from './tier.js';
import type { AdapterIdentity } from './context.js';

export interface RegisteredAgent {
  identity: AdapterIdentity;
  /** The tier the BROKER awarded (never adapter-set). */
  awardedTier: SupportTier;
}

export interface ReceiveResult {
  /** Fenced, neutralized injection text the host surfaces to the model. */
  presentation: string;
  /** How many peer messages were injected this pull. */
  injected: number;
  /** Whether a bounded continuation is warranted (host enforces the cap). */
  wantsContinuation: boolean;
}

export interface AcknowledgeResult { ok: boolean; messageId: string }
export interface ReplyResult { ok: boolean; replyId?: string }

export interface HealthResult {
  ready: boolean;
  ackAvailable: boolean;
  versionOk: boolean;
}
