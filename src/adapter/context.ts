/**
 * Context types passed to the XBusAdapter methods (§11). These are the ONLY shapes
 * an adapter sees — they deliberately expose NO broker internals (no SQLite handle,
 * no broker state, no root secret, no transport key, no arbitrary logging callback).
 */

import type { ComponentRole } from '../identity/components.js';
import type { AgentCapabilities } from './capabilities.js';

/** A sandboxed environment reader — an adapter never gets raw `process.env`. */
export interface RuntimeEnv {
  /** Read a single allow-listed env var (or undefined). Never the whole environment. */
  get(key: string): string | undefined;
  cwd: string;
  now(): string;            // ISO timestamp (no Date.now in adapters)
}

/** Vendor-provided identity. Replaces the CLAUDE_CODE_SESSION_ID hard-dependency. */
export interface AdapterIdentity {
  sessionId: string;        // stable, vendor-resolved
  instanceId: string;       // per-process
  projectId: string;
  cwd: string;
  /** Provenance of the resolved id, for the content-free audit trail. */
  source: 'runtime-env' | 'runtime-api' | 'derived';
  /** Free-form host/runtime label; maps onto the retained claudeCodeVersion field. */
  hostAgentVersion?: string;
}

export interface DetectionContext { env: RuntimeEnv }
export type DetectionResult =
  | { available: true; confidence: 'certain' | 'probable' }
  | { available: false; reason: string };

export interface CapabilityContext { env: RuntimeEnv }
export interface CapabilityReport { role: ComponentRole; capabilities: AgentCapabilities }

export interface RegistrationContext { identity: AdapterIdentity; role: ComponentRole; capabilities: AgentCapabilities }

export interface ReceiveContext {
  checkpointId: string;
  limit: number;
  eventName?: string;       // e.g. 'UserPromptSubmit' | 'Stop' | adapter-specific
  stopActive?: boolean;
}

export interface AcknowledgeContext { messageId: string; injectionId: string; status: 'accepted' | 'rejected'; reason?: string }
export interface ReplyContext { injectionId: string; text: string }
export interface HealthContext { env: RuntimeEnv }
export interface ShutdownContext { reason: 'host-exit' | 'broker-shutdown-notice' | 'error' }
