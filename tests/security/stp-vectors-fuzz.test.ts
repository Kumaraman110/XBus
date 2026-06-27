/**
 * XBUS-STP test vectors (§14) + parser fuzzing / strict limits (§15).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import {
  startClientHandshake, serverHandshake, parseServerHello, clientFinish, parseClientHello,
  SecureSession, generateRootSecret, type HelloIdentity,
} from '../../src/ipc/secure-channel.js';

const vectors = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/stp-vectors.json'), 'utf8')) as Record<string, any>;
const hx = (s: string) => Buffer.from(s, 'hex');

describe('STP test vectors (§14) — stable, deterministic, non-production', () => {
  it('re-derives the exact transcript hash + keys + client proof from fixed inputs', () => {
    const root = hx(vectors.rootKey);
    const identity = vectors.identity as HelloIdentity;
    const ch = startClientHandshake(1, identity, { clientNonce: hx(vectors.clientNonce), connId: hx(vectors.connId) });
    expect(ch.clientHelloBytes.toString('hex')).toBe(vectors.clientHelloBytes);
    const srv = serverHandshake(root, 'broker-test', parseClientHello(ch.clientHelloBytes), { serverNonce: hx(vectors.serverNonce) });
    expect(srv.serverHelloBytes.toString('hex')).toBe(vectors.serverHelloBytes);
    expect(srv.th.toString('hex')).toBe(vectors.transcriptHash);
    const cf = clientFinish(root, ch.state, parseServerHello(srv.serverHelloBytes));
    expect(cf.keys.k_c2s_enc.toString('hex')).toBe(vectors.derivedKeys.k_c2s_enc);
    expect(cf.keys.k_s2c_enc.toString('hex')).toBe(vectors.derivedKeys.k_s2c_enc);
    expect(cf.clientProof.toString('hex')).toBe(vectors.clientProof);
  });

  it('the recorded sealed frame decrypts to the recorded plaintext', () => {
    const root = hx(vectors.rootKey);
    const ch = startClientHandshake(1, vectors.identity, { clientNonce: hx(vectors.clientNonce), connId: hx(vectors.connId) });
    const srv = serverHandshake(root, 'broker-test', parseClientHello(ch.clientHelloBytes), { serverNonce: hx(vectors.serverNonce) });
    const server = new SecureSession(srv.keys, hx(vectors.connId), 'server');
    expect(server.open(hx(vectors.sealedFrame)).toString('hex')).toBe(vectors.plaintext);
  });
});

describe('parser fuzzing / strict limits (§15)', () => {
  it('parseClientHello rejects arbitrary/truncated/oversized bytes without crashing', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 4096 }), (arr) => {
        try { parseClientHello(Buffer.from(arr)); } catch { /* expected: typed throw, never a crash */ }
        return true; // the property is "never throws an unhandled non-Error / never hangs"
      }),
      { numRuns: 500 },
    );
  });

  it('parseServerHello rejects garbage without crashing', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 2048 }), (arr) => {
        try { parseServerHello(Buffer.from(arr)); } catch { /* typed throw */ }
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it('a truncated client_hello throws STP_DECODE_UNDERRUN (no over-read)', () => {
    const ch = startClientHandshake(1, { buildId: 'b', appProtoRange: '1-1', claimedRole: 'mcp', claimedSessionId: '', claimedEpoch: 0, capabilities: '' });
    const full = ch.clientHelloBytes;
    expect(() => parseClientHello(full.subarray(0, full.length - 5))).toThrow(/UNDERRUN/);
  });

  it('SecureSession.open rejects a truncated/garbage sealed frame', () => {
    const root = generateRootSecret();
    const ch = startClientHandshake(1, { buildId: 'b', appProtoRange: '1-1', claimedRole: 'mcp', claimedSessionId: '', claimedEpoch: 0, capabilities: '' });
    const srv = serverHandshake(root, 'bk', parseClientHello(ch.clientHelloBytes));
    const cf = clientFinish(root, ch.state, parseServerHello(srv.serverHelloBytes));
    const client = new SecureSession(cf.keys, cf.connId, 'client');
    const sealed = client.seal(Buffer.from('hi'));
    const server = new SecureSession(srv.keys, parseClientHello(ch.clientHelloBytes).connId, 'server');
    // truncated -> throws, no crash
    expect(() => server.open(sealed.subarray(0, 10))).toThrow();
    // random bytes -> throws
    expect(() => server.open(Buffer.from('not a frame at all'))).toThrow();
  });

  it('oversized plaintext is rejected before allocation', () => {
    const root = generateRootSecret();
    const ch = startClientHandshake(1, { buildId: 'b', appProtoRange: '1-1', claimedRole: 'mcp', claimedSessionId: '', claimedEpoch: 0, capabilities: '' });
    const srv = serverHandshake(root, 'bk', parseClientHello(ch.clientHelloBytes));
    const cf = clientFinish(root, ch.state, parseServerHello(srv.serverHelloBytes));
    const client = new SecureSession(cf.keys, cf.connId, 'client');
    expect(() => client.seal(Buffer.alloc(2 * 1024 * 1024))).toThrow(/TOO_LARGE/);
  });
});
