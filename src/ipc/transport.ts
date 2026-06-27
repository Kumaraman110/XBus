/**
 * Local IPC transport abstraction + platform endpoint selection.
 *
 * Windows: per-user named pipe (\\.\pipe\xbus-<user>-<hash>).
 * Unix:    user-only Unix domain socket under a 0700 dir.
 *
 * The contract is intentionally small so UnixSocketTransport,
 * WindowsNamedPipeTransport and an InMemoryTestTransport can all satisfy it
 * (see tests/contract). For the vertical slice we use Node `net` which gives a
 * named pipe on win32 and a UDS on posix from the same API.
 */
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { hardenDir, assertNotReparse, type HardenResult } from './acl.js';

export function defaultEndpoint(dataDir: string): string {
  if (process.platform === 'win32') {
    const user = (process.env.USERNAME ?? 'user').replace(/[^A-Za-z0-9]/g, '');
    const h = createHash('sha256').update(dataDir).digest('hex').slice(0, 12);
    return `\\\\.\\pipe\\xbus-${user}-${h}`;
  }
  return path.join(dataDir, 'broker.sock');
}

/**
 * Ensure the data dir exists with restrictive perms. Unix: 0700. Windows:
 * remove inheritance + grant current-user+SYSTEM only (a textual 0700 is a no-op
 * on Windows — see src/ipc/acl.ts). Rejects a symlinked/reparse data dir.
 */
export function ensureDataDir(dataDir: string): HardenResult {
  const existed = fs.existsSync(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  if (existed) assertNotReparse(dataDir);
  return hardenDir(dataDir);
}

export interface Connection {
  send(frame: Buffer): void;
  onFrame(cb: (payload: unknown) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (e: Error) => void): void;
  close(): void;
  readonly id: string;
}

export type { net };
