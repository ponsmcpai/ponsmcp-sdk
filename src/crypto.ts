// Keccak-256, RLP, and secp256k1 ECDSA — zero-dependency implementations.
// Validated in test/e2e.mjs against standard vectors AND a live broadcast.

import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------- keccak256

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// rho rotation offsets, indexed [x + 5*y]  (r[x][y], x = column, y = row)
const RHO = [
  0n, 1n, 62n, 28n, 27n,
  36n, 44n, 6n, 55n, 20n,
  3n, 10n, 43n, 25n, 39n,
  41n, 45n, 15n, 21n, 8n,
  18n, 2n, 61n, 56n, 14n,
];

const MASK = (1n << 64n) - 1n;
const rotl64 = (v: bigint, n: bigint): bigint =>
  n === 0n ? v : ((v << n) | (v >> (64n - n))) & MASK;

function keccakF(st: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    // theta
    const c: bigint[] = [];
    for (let x = 0; x < 5; x++) {
      c[x] = st[x] ^ st[x + 5] ^ st[x + 10] ^ st[x + 15] ^ st[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1n);
      for (let y = 0; y < 5; y++) st[x + 5 * y] ^= d;
    }
    // rho + pi (canonical rotc/piln traversal, same as tiny-keccak)
    const PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
    const ROTC = [1n, 3n, 6n, 10n, 15n, 21n, 28n, 36n, 45n, 55n, 2n, 14n, 27n, 41n, 56n, 8n, 25n, 43n, 62n, 18n, 39n, 61n, 20n, 44n];
    let t = st[1];
    for (let i2 = 0; i2 < 24; i2++) {
      const j2 = PILN[i2];
      const tmp = st[j2];
      st[j2] = rotl64(t, ROTC[i2]);
      t = tmp;
    }
    // chi
    const bc: bigint[] = new Array(5).fill(0n);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) bc[x] = st[x + 5 * y];
      for (let x = 0; x < 5; x++) {
        st[x + 5 * y] = bc[x] ^ (~bc[(x + 1) % 5] & bc[(x + 2) % 5]);
      }
    }
    // iota
    st[0] ^= RC[round];
  }
}

export function keccak256(data: Uint8Array): Buffer {
  const rate = 136; // 1088 bits for 256-bit output
  const st: bigint[] = new Array(25).fill(0n);
  const padded = Buffer.from(data);
  // keccak padding: 0x01 ... 0x80
  const padLen = rate - (padded.length % rate);
  const pad = Buffer.alloc(padLen);
  pad[0] = 0x01;
  pad[padLen - 1] |= 0x80;
  const full = Buffer.concat([padded, pad]);

  for (let off = 0; off < full.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      st[i] ^= full.readBigUInt64LE(off + i * 8);
    }
    keccakF(st);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(st[i], i * 8);
  return out;
}

// ---------------------------------------------------------------- RLP

type RlpItem = Uint8Array | RlpItem[];

function encodeLength(len: number, offset: number): Buffer {
  if (len < 56) return Buffer.from([offset + len]);
  const lenBytes = Buffer.from(len.toString(16).padStart(2, '0').length % 2 ? '0' + len.toString(16) : len.toString(16), 'hex');
  return Buffer.concat([Buffer.from([offset + 55 + lenBytes.length]), lenBytes]);
}

export function rlpEncode(item: RlpItem): Buffer {
  if (Array.isArray(item)) {
    const body = Buffer.concat(item.map(rlpEncode));
    return Buffer.concat([encodeLength(body.length, 0xc0), body]);
  }
  const b = Buffer.from(item);
  if (b.length === 1 && b[0] < 0x80) return b;
  return Buffer.concat([encodeLength(b.length, 0x80), b]);
}

export function toRlpScalar(v: bigint | number | Uint8Array): Uint8Array {
  if (v instanceof Uint8Array) return v;
  const n = BigInt(v);
  if (n === 0n) return new Uint8Array(0);
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}

// ---------------------------------------------------------------- secp256k1

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const Gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const Gy = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

function mod(v: bigint, m: bigint): bigint {
  const r = v % m;
  return r >= 0n ? r : r + m;
}

function modInv(a: bigint, m: bigint): bigint {
  let [old_r, r] = [mod(a, m), m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return mod(old_s, m);
}

// Jacobian point ops
function jDouble(pt: bigint[]): bigint[] {
  if (pt[1] === 0n) return [0n, 1n, 0n];
  const ySq = mod(pt[1] * pt[1], P);
  const s = mod(4n * pt[0] * ySq, P);
  const m = mod(3n * pt[0] * pt[0], P);
  const x = mod(m * m - 2n * s, P);
  const y = mod(m * (s - x) - 8n * ySq * ySq, P);
  const z = mod(2n * pt[1] * pt[2], P);
  return [x, y, z];
}

function jAdd(p1: bigint[], p2: bigint[]): bigint[] {
  if (p1[2] === 0n) return p2;
  if (p2[2] === 0n) return p1;
  const z1z1 = mod(p1[2] * p1[2], P);
  const z2z2 = mod(p2[2] * p2[2], P);
  const u1 = mod(p1[0] * z2z2, P);
  const u2 = mod(p2[0] * z1z1, P);
  const s1 = mod(p1[1] * z2z2 * p2[2], P);
  const s2 = mod(p2[1] * z1z1 * p1[2], P);
  if (u1 === u2) {
    if (s1 !== s2) return [0n, 1n, 0n];
    return jDouble(p1);
  }
  const h = mod(u2 - u1, P);
  const i = mod(4n * h * h, P); // I = (2H)²
  const j = mod(h * i, P);
  const rr = mod(2n * (s2 - s1), P);
  const v = mod(u1 * i, P);
  const x = mod(rr * rr - j - 2n * v, P);
  const y = mod(rr * (v - x) - 2n * s1 * j, P);
  const z = mod(2n * p1[2] * p2[2] * h, P);
  return [x, y, z];
}

function jMul(pt: bigint[], k: bigint): bigint[] {
  let result: bigint[] = [0n, 1n, 0n];
  let addend = pt;
  while (k > 0n) {
    if (k & 1n) result = jAdd(result, addend);
    addend = jDouble(addend);
    k >>= 1n;
  }
  return result;
}

function toAffine(pt: bigint[]): { x: bigint; y: bigint } {
  const zInv = modInv(pt[2], P);
  const zInv2 = mod(zInv * zInv, P);
  const zInv3 = mod(zInv2 * zInv, P);
  return { x: mod(pt[0] * zInv2, P), y: mod(pt[1] * zInv3, P) };
}

export function privateKeyToPublicKey(priv: bigint): { x: bigint; y: bigint } {
  return toAffine(jMul([Gx, Gy, 1n], priv));
}

export interface Signature {
  r: bigint;
  s: bigint;
  recovery: number;
}

export function sign(hash: Buffer, priv: bigint): Signature {
  const z = mod(BigInt('0x' + hash.toString('hex')), N);
  for (let i = 0; i < 64; i++) {
    const k = mod(BigInt('0x' + randomBytes(32).toString('hex')), N);
    if (k === 0n) continue;
    const R = toAffine(jMul([Gx, Gy, 1n], k));
    let r = mod(R.x, N);
    if (r === 0n) continue;
    let s = mod(modInv(k, N) * (z + r * priv), N);
    if (s === 0n) continue;
    let recovery = R.y & 1n ? 1 : 0;
    if (R.x >= N) recovery |= 2;
    if (s > N / 2n) {
      s = N - s;
      recovery ^= 1;
    }
    return { r, s, recovery };
  }
  throw new Error('signing failed');
}

// ---------------------------------------------------------------- tx signing

export interface LegacyTx {
  nonce: bigint;
  gasPrice: bigint;
  gas: bigint;
  to: string | null; // null = contract creation
  value: bigint;
  data: Uint8Array;
  chainId: number;
}

export function serializeTx(tx: LegacyTx, sig?: Signature): Buffer {
  const fields: RlpItem[] = [
    toRlpScalar(tx.nonce),
    toRlpScalar(tx.gasPrice),
    toRlpScalar(tx.gas),
    tx.to ? Buffer.from(tx.to.toLowerCase().replace(/^0x/, ''), 'hex') : new Uint8Array(0),
    toRlpScalar(tx.value),
    tx.data,
  ];
  if (!sig) {
    fields.push(toRlpScalar(BigInt(tx.chainId)), new Uint8Array(0), new Uint8Array(0));
  } else {
    fields.push(toRlpScalar(BigInt(35 + tx.chainId * 2 + sig.recovery)));
    fields.push(toRlpScalar(sig.r));
    fields.push(toRlpScalar(sig.s));
  }
  return rlpEncode(fields);
}

export function signingHash(tx: LegacyTx): Buffer {
  return keccak256(serializeTx(tx));
}

export function signTransaction(tx: LegacyTx, priv: bigint): Buffer {
  const sig = sign(signingHash(tx), priv);
  return serializeTx(tx, sig);
}

/** Address (0x + 20 bytes) derived from a private key. */
export function privateKeyToAddress(priv: bigint): string {
  const pub = privateKeyToPublicKey(priv);
  const xBuf = Buffer.from(pub.x.toString(16).padStart(64, '0'), 'hex');
  const yBuf = Buffer.from(pub.y.toString(16).padStart(64, '0'), 'hex');
  const addr = keccak256(Buffer.concat([xBuf, yBuf])).subarray(12);
  return '0x' + addr.toString('hex');
}

// re-export node's createHash for callers that need sha (unused)
export const _sha = createHash;
