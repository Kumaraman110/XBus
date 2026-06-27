/**
 * XBus Secure Transport Protocol (XBUS-STP v1) — implements docs/secure-transport-spec.md.
 *
 * The named pipe / UDS is an UNTRUSTED byte transport. This module provides mutual
 * installation-membership auth + AES-256-GCM confidentiality/integrity with
 * transcript-bound key derivation (downgrade + identity-substitution resistant)
 * using ONLY pinned-runtime primitives. This is a CUSTOM PROTOCOL composed from
 * standard primitives (see ADR 0010 honesty amendment).
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { ByteWriter, ByteReader } from './codec.js';

export const STP_MAGIC = 'XBUS-STP';
export const STP_VERSION = 1;
export const SUITE_AES256_GCM = 0x0001;
export const ROOT_SECRET_BYTES = 32;
const NONCE_BYTES = 32;
const CONN_ID_BYTES = 16; // normative fixed connId width
const PROOF_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENC_KEY_BYTES = 32;
export const MAX_PLAINTEXT = 1024 * 1024;

export class AuthFailed extends Error { constructor() { super('AUTH_FAILED'); this.name = 'AuthFailed'; } }
export class ProtocolMismatch extends Error { constructor(m = 'PROTOCOL_MISMATCH') { super(m); this.name = 'ProtocolMismatch'; } }

/** Identity claims a client asserts in client_hello (verified by L2-L4 later). */
export interface HelloIdentity {
  buildId: string;
  appProtoRange: string;
  claimedRole: string;
  claimedSessionId: string; // '' if none
  claimedEpoch: number; // 0 if none
  capabilities: string; // canonical csv
}

export interface ClientHello {
  keyVersion: number;
  offeredSuites: number[];
  clientNonce: Buffer;
  connId: Buffer; // 16 bytes
  identity: HelloIdentity;
}

export function generateRootSecret(): Buffer { return randomBytes(ROOT_SECRET_BYTES); }

function encodeClientHello(h: ClientHello): Buffer {
  return new ByteWriter()
    .str(STP_MAGIC).u8(STP_VERSION).u32(h.keyVersion)
    .u16Array(h.offeredSuites).raw(h.clientNonce).bytes(h.connId)
    .str(h.identity.buildId).str(h.identity.appProtoRange)
    .str(h.identity.claimedRole).str(h.identity.claimedSessionId).u32(h.identity.claimedEpoch)
    .str(h.identity.capabilities)
    .done();
}

function encodeServerHelloCore(stpVersion: number, keyVersion: number, selectedSuite: number, serverNonce: Buffer, brokerInstanceId: string): Buffer {
  return new ByteWriter().u8(stpVersion).u32(keyVersion).u16(selectedSuite).raw(serverNonce).str(brokerInstanceId).done();
}

/** Build the binding context (spec §5) — bound into every derived key. */
function buildContext(th: Buffer, brokerInstanceId: string, h: ClientHello, selectedSuite: number): Buffer {
  return new ByteWriter()
    .raw(th).str(brokerInstanceId).bytes(h.connId)
    .str(h.identity.claimedRole).str(h.identity.claimedSessionId).u32(h.identity.claimedEpoch)
    .str(h.identity.buildId).u16(selectedSuite).u8(STP_VERSION)
    .done();
}

function expand(prk: Buffer, label: string, context: Buffer, len: number): Buffer {
  const info = Buffer.concat([Buffer.from(`XBUS-STP/v1/${label}`, 'utf8'), context]);
  return Buffer.from(hkdfSync('sha256', prk, Buffer.alloc(0), info, len));
}

export interface DerivedKeys {
  k_c2s_enc: Buffer; k_s2c_enc: Buffer; k_c2s_iv: Buffer; k_s2c_iv: Buffer; mk_client: Buffer; mk_server: Buffer;
}

function deriveAll(rootSecret: Buffer, clientNonce: Buffer, serverNonce: Buffer, context: Buffer): DerivedKeys {
  const prk = Buffer.from(hkdfSync('sha256', rootSecret, Buffer.concat([clientNonce, serverNonce]), Buffer.from('XBUS-STP/v1/extract'), 32));
  // NOTE: hkdfSync already does extract+expand; we use it as a PRF with explicit
  // per-purpose info. salt is folded via the extract call above feeding `prk`.
  return {
    k_c2s_enc: expand(prk, 'c2s-enc', context, ENC_KEY_BYTES),
    k_s2c_enc: expand(prk, 's2c-enc', context, ENC_KEY_BYTES),
    k_c2s_iv: expand(prk, 'c2s-iv', context, IV_BYTES),
    k_s2c_iv: expand(prk, 's2c-iv', context, IV_BYTES),
    mk_client: expand(prk, 'client-proof', context, 32),
    mk_server: expand(prk, 'server-proof', context, 32),
  };
}

function proof(mk: Buffer, label: 'server-finished' | 'client-finished', th: Buffer): Buffer {
  return createHmac('sha256', mk).update(label).update(th).digest();
}

// ---- Client side ----
export interface ClientHandshakeState { hello: ClientHello; helloBytes: Buffer; }

export interface HandshakeRandomness { clientNonce?: Buffer; connId?: Buffer; serverNonce?: Buffer; }

export function startClientHandshake(keyVersion: number, identity: HelloIdentity, rnd?: HandshakeRandomness): { state: ClientHandshakeState; clientHelloBytes: Buffer } {
  const hello: ClientHello = { keyVersion, offeredSuites: [SUITE_AES256_GCM], clientNonce: rnd?.clientNonce ?? randomBytes(NONCE_BYTES), connId: rnd?.connId ?? randomBytes(16), identity };
  const helloBytes = encodeClientHello(hello);
  return { state: { hello, helloBytes }, clientHelloBytes: helloBytes };
}

export interface ServerHelloParsed { stpVersion: number; keyVersion: number; selectedSuite: number; serverNonce: Buffer; brokerInstanceId: string; serverProof: Buffer; }

export function parseServerHello(buf: Buffer): ServerHelloParsed {
  const r = new ByteReader(buf);
  const stpVersion = r.u8();
  const keyVersion = r.u32();
  const selectedSuite = r.u16();
  const serverNonce = r.raw(NONCE_BYTES);
  const brokerInstanceId = r.str();
  const serverProof = r.raw(PROOF_BYTES);
  return { stpVersion, keyVersion, selectedSuite, serverNonce, brokerInstanceId, serverProof };
}

/** Client verifies server, derives keys, produces client_finish. Throws AuthFailed/ProtocolMismatch. */
export function clientFinish(rootSecret: Buffer, state: ClientHandshakeState, sh: ServerHelloParsed): { keys: DerivedKeys; clientProof: Buffer; connId: Buffer } {
  if (sh.stpVersion !== STP_VERSION || sh.selectedSuite !== SUITE_AES256_GCM) throw new ProtocolMismatch();
  if (!state.hello.offeredSuites.includes(sh.selectedSuite)) throw new ProtocolMismatch('suite not offered');
  const serverHelloCore = encodeServerHelloCore(sh.stpVersion, sh.keyVersion, sh.selectedSuite, sh.serverNonce, sh.brokerInstanceId);
  const transcript = Buffer.concat([state.helloBytes, serverHelloCore]);
  const th = createHash('sha256').update(transcript).digest();
  const context = buildContext(th, sh.brokerInstanceId, state.hello, sh.selectedSuite);
  const keys = deriveAll(rootSecret, state.hello.clientNonce, sh.serverNonce, context);
  const expectedServer = proof(keys.mk_server, 'server-finished', th);
  if (sh.serverProof.length !== expectedServer.length || !timingSafeEqual(sh.serverProof, expectedServer)) throw new AuthFailed();
  const clientProof = proof(keys.mk_client, 'client-finished', th);
  return { keys, clientProof, connId: state.hello.connId };
}

// ---- Server side ----
export function parseClientHello(buf: Buffer): ClientHello {
  const r = new ByteReader(buf);
  const magic = r.str();
  if (magic !== STP_MAGIC) throw new ProtocolMismatch('bad magic');
  const stpVersion = r.u8();
  if (stpVersion !== STP_VERSION) throw new ProtocolMismatch('unsupported version');
  const keyVersion = r.u32();
  const offeredSuites = r.u16Array();
  const clientNonce = r.raw(NONCE_BYTES);
  const connId = r.bytes();
  // Enforce the normative fixed 16-byte connId. A hostile client
  // could otherwise submit a 0..65535-byte value that flows into the key-schedule
  // context + per-frame AAD; reject anything off-width as a protocol violation.
  if (connId.length !== CONN_ID_BYTES) throw new ProtocolMismatch('bad connId length');
  const identity: HelloIdentity = {
    buildId: r.str(), appProtoRange: r.str(), claimedRole: r.str(),
    claimedSessionId: r.str(), claimedEpoch: r.u32(), capabilities: r.str(),
  };
  return { keyVersion, offeredSuites, clientNonce, connId, identity };
}

/** Server selects a suite, derives keys, builds server_hello (with proof). Throws ProtocolMismatch. */
export function serverHandshake(rootSecret: Buffer, brokerInstanceId: string, hello: ClientHello, rnd?: HandshakeRandomness): { keys: DerivedKeys; serverHelloBytes: Buffer; serverNonce: Buffer; selectedSuite: number; th: Buffer; clientHelloBytes: Buffer } {
  if (!hello.offeredSuites.includes(SUITE_AES256_GCM)) throw new ProtocolMismatch('no common suite');
  const selectedSuite = SUITE_AES256_GCM;
  const serverNonce = rnd?.serverNonce ?? randomBytes(NONCE_BYTES);
  const clientHelloBytes = encodeClientHello(hello);
  const serverHelloCore = encodeServerHelloCore(STP_VERSION, hello.keyVersion, selectedSuite, serverNonce, brokerInstanceId);
  const transcript = Buffer.concat([clientHelloBytes, serverHelloCore]);
  const th = createHash('sha256').update(transcript).digest();
  const context = buildContext(th, brokerInstanceId, hello, selectedSuite);
  const keys = deriveAll(rootSecret, hello.clientNonce, serverNonce, context);
  const serverProof = proof(keys.mk_server, 'server-finished', th);
  const serverHelloBytes = Buffer.concat([serverHelloCore, serverProof]);
  return { keys, serverHelloBytes, serverNonce, selectedSuite, th, clientHelloBytes };
}

/** Server verifies the client_finish proof. Throws AuthFailed. */
export function serverVerifyFinish(keys: DerivedKeys, th: Buffer, clientProof: Buffer): void {
  const expected = proof(keys.mk_client, 'client-finished', th);
  if (clientProof.length !== expected.length || !timingSafeEqual(clientProof, expected)) throw new AuthFailed();
}

// ---- Per-connection AEAD session ----
export type Direction = 'c2s' | 's2c';

export class SecureSession {
  private sendSeq = 0;
  private recvSeq = 0;
  private readonly encKey: Buffer;
  private readonly encIvBase: Buffer;
  private readonly decKey: Buffer;
  private readonly decIvBase: Buffer;
  private readonly sendDir: number;
  private readonly recvDir: number;

  constructor(keys: DerivedKeys, private readonly connId: Buffer, role: 'client' | 'server') {
    if (role === 'client') {
      this.encKey = keys.k_c2s_enc; this.encIvBase = keys.k_c2s_iv; this.sendDir = 1;
      this.decKey = keys.k_s2c_enc; this.decIvBase = keys.k_s2c_iv; this.recvDir = 2;
    } else {
      this.encKey = keys.k_s2c_enc; this.encIvBase = keys.k_s2c_iv; this.sendDir = 2;
      this.decKey = keys.k_c2s_enc; this.decIvBase = keys.k_c2s_iv; this.recvDir = 1;
    }
  }

  private iv(base: Buffer, seq: number): Buffer {
    const ctr = Buffer.alloc(IV_BYTES);
    ctr.writeUInt32BE(seq >>> 0, IV_BYTES - 4); // counter in the low 4 bytes
    const out = Buffer.allocUnsafe(IV_BYTES);
    for (let i = 0; i < IV_BYTES; i++) out[i] = base[i]! ^ ctr[i]!;
    return out;
  }

  private aad(dir: number, seq: number, ctLen: number): Buffer {
    return new ByteWriter().str('XBUS-STP/v1').bytes(this.connId).u8(dir).u32(seq).u32(ctLen).done();
  }

  seal(plaintext: Buffer): Buffer {
    if (plaintext.length > MAX_PLAINTEXT) throw new Error('PLAINTEXT_TOO_LARGE');
    if (this.sendSeq >= 0xffffffff) throw new Error('SEQ_OVERFLOW'); // close before reuse
    const seq = this.sendSeq++;
    const iv = this.iv(this.encIvBase, seq);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const aad = this.aad(this.sendDir, seq, plaintext.length); // ctLen==ptLen for GCM
    cipher.setAAD(aad);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return new ByteWriter().u32(seq).raw(iv).raw(tag).raw(ct).done();
  }

  open(sealed: Buffer): Buffer {
    const r = new ByteReader(sealed);
    const seq = r.u32();
    if (seq !== this.recvSeq) throw new Error('REPLAY_OR_REORDER');
    const iv = r.raw(IV_BYTES);
    const tag = r.raw(TAG_BYTES);
    const ct = r.raw(r.remaining);
    if (ct.length > MAX_PLAINTEXT + TAG_BYTES) throw new Error('FRAME_TOO_LARGE');
    const expectedIv = this.iv(this.decIvBase, seq);
    if (!timingSafeEqual(iv, expectedIv)) throw new Error('IV_MISMATCH'); // counter integrity
    const decipher = createDecipheriv('aes-256-gcm', this.decKey, iv);
    decipher.setAAD(this.aad(this.recvDir, seq, ct.length));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]); // throws on tamper
    this.recvSeq++;
    return pt;
  }
}
