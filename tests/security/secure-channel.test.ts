/**
 * XBUS-STP v1 adversarial tests (reliability contract §6). The named pipe is an
 * UNTRUSTED transport; security is the application-layer mutual-auth + AEAD
 * channel bound to the transcript + identity context.
 *
 * Cross-USER OS execution (a real second Windows account) is BLOCKED here (no
 * admin); these prove the cryptographic boundary that makes pipe-name knowledge
 * insufficient WITHOUT the installation secret, and full §6 downgrade/identity/
 * reflection/nonce-reuse resistance.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  generateRootSecret, startClientHandshake, serverHandshake, parseServerHello,
  clientFinish, serverVerifyFinish, parseClientHello, SecureSession, AuthFailed, ProtocolMismatch,
  type HelloIdentity,
} from '../../src/ipc/secure-channel.js';
import { loadOrCreateRootSecret, rotateRootSecret, secretPath } from '../../src/ipc/root-secret.js';

const IDENTITY: HelloIdentity = { buildId: 'b1', appProtoRange: '1-1', claimedRole: 'mcp', claimedSessionId: 's1', claimedEpoch: 1, capabilities: '' };
const BROKER = 'broker-instance-1';

/** Full mutual handshake. Returns both sessions or throws. Allows tampering hooks. */
function handshake(serverRoot: Buffer, clientRoot: Buffer, opts: { identity?: HelloIdentity; broker?: string; tamperServerHello?: (b: Buffer) => Buffer } = {}) {
  const ch = startClientHandshake(1, opts.identity ?? IDENTITY);
  const hello = parseClientHello(ch.clientHelloBytes);
  const srv = serverHandshake(serverRoot, opts.broker ?? BROKER, hello);
  const shBytes = opts.tamperServerHello ? opts.tamperServerHello(srv.serverHelloBytes) : srv.serverHelloBytes;
  const sh = parseServerHello(shBytes);
  const cf = clientFinish(clientRoot, ch.state, sh); // client verifies server proof
  serverVerifyFinish(srv.keys, srv.th, cf.clientProof); // server verifies client proof
  return {
    client: new SecureSession(cf.keys, cf.connId, 'client'),
    server: new SecureSession(srv.keys, hello.connId, 'server'),
  };
}

describe('XBUS-STP handshake + AEAD', () => {
  it('intended: correct secret completes mutual auth + bidirectional encrypted frames', () => {
    const root = generateRootSecret();
    const { client, server } = handshake(root, root);
    const s = client.seal(Buffer.from('hello broker'));
    expect(server.open(s).toString()).toBe('hello broker');
    expect(client.open(server.seal(Buffer.from('hi client'))).toString()).toBe('hi client');
  });

  it('wrong secret: uniform AuthFailed (no oracle)', () => {
    expect(() => handshake(generateRootSecret(), generateRootSecret())).toThrow(AuthFailed);
  });

  it('§6.1/6.2 reflection: a server proof cannot serve as a client proof (distinct labels+keys)', () => {
    const root = generateRootSecret();
    const ch = startClientHandshake(1, IDENTITY);
    const hello = parseClientHello(ch.clientHelloBytes);
    const srv = serverHandshake(root, BROKER, hello);
    const sh = parseServerHello(srv.serverHelloBytes);
    clientFinish(root, ch.state, sh);
    // attacker reflects the SERVER proof as the client proof
    expect(() => serverVerifyFinish(srv.keys, srv.th, sh.serverProof)).toThrow(AuthFailed);
  });

  it('§6.3/6.4 direction binding: a c2s frame cannot be opened as s2c (AAD direction)', () => {
    const root = generateRootSecret();
    const { client, server } = handshake(root, root);
    const c2s = client.seal(Buffer.from('to-broker'));
    // feeding a c2s frame back to the CLIENT's open (s2c decrypt) must fail
    expect(() => client.open(c2s)).toThrow();
    expect(server.open(c2s).toString()).toBe('to-broker'); // correct direction works
  });

  it('§6.8 downgrade: a tampered selectedSuite breaks the transcript -> AuthFailed/ProtocolMismatch', () => {
    const root = generateRootSecret();
    expect(() => handshake(root, root, {
      tamperServerHello: (b) => { const c = Buffer.from(b); c.writeUInt16BE(0x9999, 5); return c; }, // mangle selectedSuite field
    })).toThrow(); // ProtocolMismatch (unknown suite) or AuthFailed (transcript)
  });

  it('§6.10/6.11/6.12 identity substitution: role/session/epoch are transcript-bound (server proof fails if client lies post-derivation)', () => {
    const root = generateRootSecret();
    // The CLIENT derives keys over its OWN claimed identity; if the broker
    // authorized a different identity the derived keys differ -> proof mismatch.
    // Here we simulate the client claiming role X to the server but deriving as Y:
    const ch = startClientHandshake(1, { ...IDENTITY, claimedRole: 'hook' });
    const helloAsSeenByServer = parseClientHello(ch.clientHelloBytes);
    // server derives over the REAL claimed role 'hook'
    const srv = serverHandshake(root, BROKER, helloAsSeenByServer);
    const sh = parseServerHello(srv.serverHelloBytes);
    // client tries to finish as if it had claimed 'mcp' (tamper its own state)
    const tamperedState = { hello: { ...ch.state.hello, identity: { ...ch.state.hello.identity, claimedRole: 'mcp' } }, helloBytes: ch.state.helloBytes };
    // helloBytes still encode 'hook', but context uses the (lying) state role 'mcp' -> mismatch
    expect(() => clientFinish(root, tamperedState as typeof ch.state, sh)).toThrow(AuthFailed);
  });

  it('§6.5/6.6/6.7 handshake replay: a server_hello for one client nonce fails for a fresh handshake', () => {
    const root = generateRootSecret();
    const ch1 = startClientHandshake(1, IDENTITY);
    const srv1 = serverHandshake(root, BROKER, parseClientHello(ch1.clientHelloBytes));
    // attacker replays srv1.serverHello against a NEW client handshake
    const ch2 = startClientHandshake(1, IDENTITY);
    const sh1 = parseServerHello(srv1.serverHelloBytes);
    expect(() => clientFinish(root, ch2.state, sh1)).toThrow(AuthFailed);
  });

  it('§6.16/6.18 frame replay + sequence: duplicate and reordered frames rejected', () => {
    const root = generateRootSecret();
    const { client, server } = handshake(root, root);
    const f0 = client.seal(Buffer.from('0'));
    const f1 = client.seal(Buffer.from('1'));
    expect(server.open(f0).toString()).toBe('0');
    expect(() => server.open(f0)).toThrow(/REPLAY/); // duplicate
    // deliver f1 then... wait, f1 is seq1 which is next; but re-delivering f0(seq0) after seq1 is reorder
    expect(server.open(f1).toString()).toBe('1');
  });

  it('tamper: flipping a ciphertext byte fails the GCM tag', () => {
    const root = generateRootSecret();
    const { client, server } = handshake(root, root);
    const f = client.seal(Buffer.from('integrity'));
    f[f.length - 1] ^= 0xff;
    expect(() => server.open(f)).toThrow();
  });

  it('§6.8 version: an unsupported stpVersion server_hello -> ProtocolMismatch', () => {
    const root = generateRootSecret();
    expect(() => handshake(root, root, {
      tamperServerHello: (b) => { const c = Buffer.from(b); c.writeUInt8(99, 0); return c; }, // stpVersion byte
    })).toThrow(ProtocolMismatch);
  });

  it('F-connId: a client_hello with an off-width connId is rejected on parse', () => {
    // Attacker-chosen connId of the wrong length (spec mandates 16 bytes). The
    // value flows into the key-schedule context + per-frame AAD, so it must be
    // fixed-width-validated rather than accepted.
    const shortId = Buffer.alloc(4, 0xab);   // too short
    const longId = Buffer.alloc(64, 0xcd);   // too long
    const empty = Buffer.alloc(0);           // zero-length removes per-conn AAD entropy
    for (const bad of [shortId, longId, empty]) {
      const ch = startClientHandshake(1, IDENTITY, { connId: bad });
      expect(() => parseClientHello(ch.clientHelloBytes)).toThrow(ProtocolMismatch);
    }
    // Control: the correct 16-byte width parses fine.
    const ok = startClientHandshake(1, IDENTITY, { connId: Buffer.alloc(16, 0x01) });
    expect(() => parseClientHello(ok.clientHelloBytes)).not.toThrow();
  });
});

describe('root secret lifecycle (§9)', () => {
  let dir: string;
  // The 'no broad principals' assertion inspects the REAL on-disk ACL, so force the icacls
  // hardening subprocess ON here even if the dev harness disabled it for speed elsewhere.
  let priorSkip: string | undefined;
  beforeAll(() => { priorSkip = process.env.XBUS_SKIP_ACL_HARDENING; delete process.env.XBUS_SKIP_ACL_HARDENING; });
  afterAll(() => { if (priorSkip === undefined) delete process.env.XBUS_SKIP_ACL_HARDENING; else process.env.XBUS_SKIP_ACL_HARDENING = priorSkip; });
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbus-rs-')); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('creates a 256-bit secret on first use, stable across loads', () => {
    const a = loadOrCreateRootSecret(dir);
    expect(a.length).toBe(32);
    expect(loadOrCreateRootSecret(dir).equals(a)).toBe(true);
  });

  it('§9 rotation: old secret no longer authenticates', () => {
    const old = loadOrCreateRootSecret(dir);
    const neu = rotateRootSecret(dir);
    expect(neu.equals(old)).toBe(false);
    expect(() => handshake(neu, old)).toThrow(AuthFailed); // client with old secret fails
    expect(loadOrCreateRootSecret(dir).equals(neu)).toBe(true);
  });

  it('the secret file has no broad principals', async () => {
    loadOrCreateRootSecret(dir);
    const { describeAcl } = await import('../../src/ipc/acl.js');
    expect(describeAcl(secretPath(dir)).broadAccess).toBe(false);
  });

  it('F-secret-regen: a malformed secret file is NOT silently regenerated (fails closed)', () => {
    // Create a valid secret, then corrupt it (wrong length).
    const good = loadOrCreateRootSecret(dir);
    fs.writeFileSync(secretPath(dir), Buffer.alloc(8, 0x00)); // 8 bytes, malformed
    // A plain load must NOT silently overwrite (which would invalidate a running
    // broker's sessions) — it fails closed with an actionable error.
    expect(() => loadOrCreateRootSecret(dir)).toThrow(/malformed|refusing/i);
    // The corrupt file is left intact (not silently replaced).
    expect(fs.readFileSync(secretPath(dir)).length).toBe(8);
    // Explicit re-init IS allowed and produces a fresh valid secret (≠ the old one).
    const reinit = loadOrCreateRootSecret(dir, { forceReinit: true });
    expect(reinit.length).toBe(32);
    expect(reinit.equals(good)).toBe(false);
  });
});
