/**
 * Build the full version/compatibility hello payload (ADR 0004) and a helper to
 * perform the hello handshake on an IpcClient, surfacing an incompatibility as a
 * typed XBusError with the broker's actionable verdict.
 */
import { PROTOCOL_VERSION, MIN_SUPPORTED_PROTOCOL_VERSION, XBUS_VERSION } from '../protocol/version.js';
import { SCHEMA_VERSION, BUILD_ID } from '../protocol/handshake.js';
import { XBusError, XBusErrorCode } from '../protocol/errors.js';
import type { IpcClient } from './client.js';
import type { ComponentRole } from '../identity/components.js';

export function clientHello(role: ComponentRole, authSecret?: string): Record<string, unknown> {
  const h: Record<string, unknown> = {
    xbusVersion: XBUS_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    minimumProtocolVersion: MIN_SUPPORTED_PROTOCOL_VERSION,
    maximumProtocolVersion: PROTOCOL_VERSION,
    schemaVersion: SCHEMA_VERSION,
    componentRole: role,
    buildId: BUILD_ID,
    capabilities: [],
  };
  if (authSecret !== undefined) h.auth = authSecret;
  return h;
}

/** Perform hello; throw a typed, actionable error if the broker reports incompatible. */
export async function doHello(client: IpcClient, role: ComponentRole, authSecret?: string): Promise<void> {
  const ack = await client.request('hello', clientHello(role, authSecret));
  if (ack.frameType === 'error') {
    const p = ack.payload as { code?: string; message?: string; detail?: { result?: string } };
    throw new XBusError(
      (p.code as XBusErrorCode) ?? XBusErrorCode.VERSION_INCOMPATIBLE,
      p.message ?? 'broker rejected hello',
      p.detail?.result ? { result: p.detail.result } : {},
    );
  }
}
