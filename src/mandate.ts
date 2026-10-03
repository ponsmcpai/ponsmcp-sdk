// EIP-712 Signed Spending Mandates for PonsMCP.
//
// A mandate lets the user (key-holder) authorize an agent wallet to spend up to
// a specified amount of USDG to a specific merchant within a time window, without
// giving the agent unrestricted access.
//
// Usage (offline flow):
//   1. Agent calls MandateEngine.createMandate(params) → gets EIP-712 typed data.
//   2. User signs the typed data in MetaMask / a frame wallet (eth_signTypedData_v4).
//   3. Agent presents the mandate + signature to MandateEngine.verifyMandate() before spending.
//
// Zero external dependencies — uses keccak256 from crypto.ts.

import { keccak256 } from './crypto.js';
import { isAddress } from './chain.js';

// ── Domain ────────────────────────────────────────────────────────────────────

export const MANDATE_DOMAIN = {
  name: 'PonsMCP',
  version: '1',
  chainId: 4663,
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MandateParams {
  /** Agent wallet address that is authorized to spend. */
  spender: string;
  /** Merchant/recipient address that can be paid. */
  merchant: string;
  /** Maximum USDG amount (in micro-units, 6 decimals). */
  maxAmountUsdg: bigint;
  /** Unix timestamp after which the mandate is no longer valid. */
  validUntil: bigint;
  /** Unique nonce to prevent replay. Suggested: Date.now() as bigint. */
  nonce: bigint;
}

export interface Mandate extends MandateParams {
  // All fields from MandateParams
}

export interface MandateTypedData {
  domain: typeof MANDATE_DOMAIN;
  types: {
    EIP712Domain: Array<{ name: string; type: string }>;
    Mandate: Array<{ name: string; type: string }>;
  };
  primaryType: 'Mandate';
  message: {
    spender: string;
    merchant: string;
    maxAmountUsdg: string;
    validUntil: string;
    nonce: string;
  };
}

export interface MandateVerifyResult {
  valid: boolean;
  reason: string;
  spender: string;
  merchant: string;
  maxAmountUsdg: string;
  validUntil: string;
}

// ── ABI / EIP-712 helpers ─────────────────────────────────────────────────────

/** Encode a uint256 as a 32-byte big-endian Buffer. */
function uint256Word(n: bigint): Buffer {
  return Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
}

/** Encode an Ethereum address as a 32-byte word (left-padded). */
function addressWord(addr: string): Buffer {
  return Buffer.from(addr.toLowerCase().replace(/^0x/, '').padStart(64, '0'), 'hex');
}

/** keccak256 of a UTF-8 string. */
function keccakStr(s: string): Buffer {
  return keccak256(Buffer.from(s, 'utf8'));
}

const DOMAIN_TYPEHASH = keccakStr(
  'EIP712Domain(string name,string version,uint256 chainId)'
);

const MANDATE_TYPEHASH = keccakStr(
  'Mandate(address spender,address merchant,uint256 maxAmountUsdg,uint256 validUntil,uint256 nonce)'
);

/** Compute the EIP-712 domain separator for PonsMCP on Robinhood Chain. */
function domainSeparator(): Buffer {
  return keccak256(Buffer.concat([
    DOMAIN_TYPEHASH,
    keccak256(Buffer.from(MANDATE_DOMAIN.name, 'utf8')),
    keccak256(Buffer.from(MANDATE_DOMAIN.version, 'utf8')),
    uint256Word(BigInt(MANDATE_DOMAIN.chainId)),
  ]));
}

/** Hash a Mandate struct per EIP-712. */
function hashMandate(m: Mandate): Buffer {
  return keccak256(Buffer.concat([
    MANDATE_TYPEHASH,
    addressWord(m.spender),
    addressWord(m.merchant),
    uint256Word(m.maxAmountUsdg),
    uint256Word(m.validUntil),
    uint256Word(m.nonce),
  ]));
}

/** Compute the final EIP-712 hash to sign (the 0x1901 envelope). */
export function computeMandateHash(m: Mandate): Buffer {
  return keccak256(Buffer.concat([
    Buffer.from('1901', 'hex'),
    domainSeparator(),
    hashMandate(m),
  ]));
}

// ── secp256k1 ecrecover ───────────────────────────────────────────────────────
// Re-implements ecrecover using the same Jacobian math in crypto.ts rather than
// importing a separate lib.

const P_FIELD = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const Gx_CONST = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const Gy_CONST = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

function modP(v: bigint): bigint {
  const r = v % P_FIELD;
  return r >= 0n ? r : r + P_FIELD;
}
function modN(v: bigint): bigint {
  const r = v % N_ORDER;
  return r >= 0n ? r : r + N_ORDER;
}
function modInvP(a: bigint): bigint {
  // Fermat: a^(P-2) mod P
  let [result, base, exp] = [1n, modP(a), P_FIELD - 2n];
  while (exp > 0n) {
    if (exp & 1n) result = modP(result * base);
    base = modP(base * base);
    exp >>= 1n;
  }
  return result;
}
function modInvN(a: bigint): bigint {
  let [old_r, r] = [modN(a), N_ORDER];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return modN(old_s);
}

function jDoubleEC(pt: bigint[]): bigint[] {
  if (pt[1] === 0n) return [0n, 1n, 0n];
  const ySq = modP(pt[1] * pt[1]);
  const s = modP(4n * pt[0] * ySq);
  const m = modP(3n * pt[0] * pt[0]);
  const x = modP(m * m - 2n * s);
  const y = modP(m * (s - x) - 8n * ySq * ySq);
  const z = modP(2n * pt[1] * pt[2]);
  return [x, y, z];
}
function jAddEC(p1: bigint[], p2: bigint[]): bigint[] {
  if (p1[2] === 0n) return p2;
  if (p2[2] === 0n) return p1;
  const z1z1 = modP(p1[2] * p1[2]);
  const z2z2 = modP(p2[2] * p2[2]);
  const u1 = modP(p1[0] * z2z2);
  const u2 = modP(p2[0] * z1z1);
  const s1 = modP(p1[1] * z2z2 * p2[2]);
  const s2 = modP(p2[1] * z1z1 * p1[2]);
  if (u1 === u2) {
    if (s1 !== s2) return [0n, 1n, 0n];
    return jDoubleEC(p1);
  }
  const h = modP(u2 - u1);
  const i = modP(4n * h * h);
  const j = modP(h * i);
  const rr = modP(2n * (s2 - s1));
  const v = modP(u1 * i);
  const x = modP(rr * rr - j - 2n * v);
  const y = modP(rr * (v - x) - 2n * s1 * j);
  const z = modP(2n * p1[2] * p2[2] * h);
  return [x, y, z];
}
function jMulEC(pt: bigint[], k: bigint): bigint[] {
  let result: bigint[] = [0n, 1n, 0n];
  let addend = pt;
  while (k > 0n) {
    if (k & 1n) result = jAddEC(result, addend);
    addend = jDoubleEC(addend);
    k >>= 1n;
  }
  return result;
}
function toAffineEC(pt: bigint[]): { x: bigint; y: bigint } {
  const zInv = modInvP(pt[2]);
  const zInv2 = modP(zInv * zInv);
  const zInv3 = modP(zInv2 * zInv);
  return { x: modP(pt[0] * zInv2), y: modP(pt[1] * zInv3) };
}

/**
 * ecrecover: Given a hash, v, r, s — returns the signer address or null.
 * v must be 27 or 28.
 */
export function ecrecover(hash: Buffer, v: number, r: bigint, s: bigint): string | null {
  try {
    const vNorm = v === 27 || v === 28 ? v - 27 : v & 1;
    if (r <= 0n || r >= N_ORDER || s <= 0n || s >= N_ORDER) return null;

    // R point: x = r, recover y from curve equation y² = x³ + 7
    const x = r;
    const yCandSq = modP(x * x * x + 7n);
    // sqrt via Tonelli–Shanks (P ≡ 3 mod 4, so sqrt = n^((P+1)/4))
    let yCandidate = modP(yCandSq ** ((P_FIELD + 1n) / 4n));
    // Pick correct parity
    const yParity = yCandidate & 1n;
    if (Number(yParity) !== vNorm) yCandidate = modP(P_FIELD - yCandidate);

    const R = [x, yCandidate, 1n]; // affine → Jacobian
    const e = BigInt('0x' + hash.toString('hex'));
    const rInv = modInvN(r);

    // pubKey = r⁻¹ * (s*R - e*G)
    const sR = jMulEC(R, s);
    const eG = jMulEC([Gx_CONST, Gy_CONST, 1n], modN(N_ORDER - modN(e)));
    const pub = toAffineEC(jMulEC(jAddEC(sR, eG), rInv));

    const xBuf = Buffer.from(pub.x.toString(16).padStart(64, '0'), 'hex');
    const yBuf = Buffer.from(pub.y.toString(16).padStart(64, '0'), 'hex');
    const addrBuf = keccak256(Buffer.concat([xBuf, yBuf])).subarray(12);
    return '0x' + addrBuf.toString('hex');
  } catch {
    return null;
  }
}

// ── MandateEngine ─────────────────────────────────────────────────────────────

export class MandateEngine {
  /**
   * Creates the EIP-712 typed data structure for a mandate, ready to be
   * signed offline by the user via MetaMask / eth_signTypedData_v4.
   */
  createMandate(params: MandateParams): {
    mandate: Mandate;
    typedData: MandateTypedData;
    hash: string;
  } {
    if (!isAddress(params.spender)) throw new Error(`invalid spender address: ${params.spender}`);
    if (!isAddress(params.merchant)) throw new Error(`invalid merchant address: ${params.merchant}`);
    if (params.maxAmountUsdg <= 0n) throw new Error('maxAmountUsdg must be > 0');
    if (params.validUntil <= 0n) throw new Error('validUntil must be > 0');

    const mandate: Mandate = {
      spender: params.spender.toLowerCase(),
      merchant: params.merchant.toLowerCase(),
      maxAmountUsdg: params.maxAmountUsdg,
      validUntil: params.validUntil,
      nonce: params.nonce,
    };

    const typedData: MandateTypedData = {
      domain: MANDATE_DOMAIN,
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
        ],
        Mandate: [
          { name: 'spender', type: 'address' },
          { name: 'merchant', type: 'address' },
          { name: 'maxAmountUsdg', type: 'uint256' },
          { name: 'validUntil', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      primaryType: 'Mandate',
      message: {
        spender: mandate.spender,
        merchant: mandate.merchant,
        maxAmountUsdg: mandate.maxAmountUsdg.toString(),
        validUntil: mandate.validUntil.toString(),
        nonce: mandate.nonce.toString(),
      },
    };

    const hash = computeMandateHash(mandate);
    return { mandate, typedData, hash: '0x' + hash.toString('hex') };
  }

  /**
   * Verifies a mandate + its signature.
   * - Recovers the signer from the EIP-712 hash.
   * - Checks expiry.
   * - The caller is responsible for checking amountUsdg <= maxAmountUsdg.
   *
   * @param mandate         - The mandate struct.
   * @param signature       - 65-byte hex signature (0x prefixed), r+s+v layout.
   * @param expectedSigner  - The address expected to have signed (user/owner, NOT the agent).
   */
  verifyMandate(
    mandate: Mandate,
    signature: string,
    expectedSigner: string,
  ): MandateVerifyResult {
    const base: Omit<MandateVerifyResult, 'valid' | 'reason'> = {
      spender: mandate.spender,
      merchant: mandate.merchant,
      maxAmountUsdg: mandate.maxAmountUsdg.toString(),
      validUntil: mandate.validUntil.toString(),
    };

    // 1. Expiry check
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (mandate.validUntil < nowSec) {
      return { valid: false, reason: `mandate expired at ${mandate.validUntil} (now ${nowSec})`, ...base };
    }

    // 2. Parse signature
    const sigHex = signature.replace(/^0x/, '');
    if (sigHex.length !== 130) {
      return { valid: false, reason: `invalid signature length: expected 130 hex chars, got ${sigHex.length}`, ...base };
    }
    const r = BigInt('0x' + sigHex.slice(0, 64));
    const s = BigInt('0x' + sigHex.slice(64, 128));
    let v = parseInt(sigHex.slice(128, 130), 16);
    // Normalize v: some wallets return 0/1; EIP-155 wallets return 27/28
    if (v < 27) v += 27;

    // 3. Recover signer
    const hash = computeMandateHash(mandate);
    const recovered = ecrecover(hash, v, r, s);
    if (!recovered) {
      return { valid: false, reason: 'signature recovery failed', ...base };
    }

    // 4. Check signer matches
    if (recovered.toLowerCase() !== expectedSigner.toLowerCase()) {
      return {
        valid: false,
        reason: `signer mismatch: recovered ${recovered}, expected ${expectedSigner.toLowerCase()}`,
        ...base,
      };
    }

    return { valid: true, reason: 'ok', ...base };
  }
}
