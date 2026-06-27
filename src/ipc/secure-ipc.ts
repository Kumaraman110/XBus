/**
 * §3 — the single approved construction boundary for IPC. Production code uses
 * SecureIpcServer / SecureIpcClient, which REQUIRE an installation root secret.
 * The underlying IpcServer/IpcClient still support a plaintext mode, but that is
 * for in-process unit/contract tests ONLY (they pass no rootSecret); production
 * paths go through these factories so a missing secret is a hard error, never a
 * silent plaintext downgrade.
 */
import { IpcServer, type ServerOptions, type FrameHandler } from './server.js';
import { IpcClient, type ClientOptions } from './client.js';
import { XBusError, XBusErrorCode } from '../protocol/errors.js';

export interface SecureServerOptions extends Omit<ServerOptions, 'rootSecret'> {
  rootSecret: Buffer; // REQUIRED
  brokerInstanceId: string;
}

export function createSecureIpcServer(
  endpoint: string,
  onFrame: FrameHandler,
  onCloseConn: (id: string) => void,
  opts: SecureServerOptions,
): IpcServer {
  if (!opts.rootSecret || opts.rootSecret.length !== 32) {
    throw new XBusError(XBusErrorCode.AUTH_FAILED, 'SecureIpcServer requires a 32-byte root secret');
  }
  return new IpcServer(endpoint, onFrame, onCloseConn, opts);
}

export interface SecureClientOptions extends Omit<ClientOptions, 'rootSecret'> {
  rootSecret: Buffer; // REQUIRED
}

export function createSecureIpcClient(endpoint: string, opts: SecureClientOptions): IpcClient {
  if (!opts.rootSecret || opts.rootSecret.length !== 32) {
    throw new XBusError(XBusErrorCode.AUTH_FAILED, 'SecureIpcClient requires a 32-byte root secret');
  }
  return new IpcClient(endpoint, opts);
}
