// pons v2 fee escrow intelligence (read-only) + launch feed.
// Sources: official pons docs (docs.ponsfamily.com/v2) — fee escrow at
// 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e keeps claimable protocol and
// creator balances; sweep functions move accrued fees into it.
// READ-ONLY: we report balances and sweep status. Claiming itself is a wallet
// action on the escrow contract — never performed by PonsMCP.
import { ethCall, isAddress } from './chain.js';
import { keccak256 } from './crypto.js';

export const PONS_V2_FEE_ESCROW = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e';
export const PONS_V2_BUYBACK_VAULT = '0x42df2a798f82289E177311362e8f5ccC45c1219c';
export const PONS_V1_FACTORY = '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB';
export const PONS_V1_LAUNCH_FEED = 'https://www.ponsfamily.com/api/pons-launches';

function word(hex: string, byteOffset: number): string {
  const raw = hex.replace(/^0x/, '');
  return raw.slice(byteOffset * 2, byteOffset * 2 + 64);
}
function big(hex: string, byteOffset: number): bigint {
  return BigInt('0x' + (word(hex, byteOffset) || '0'));
}
function selector(signature: string): string {
  return '0x' + keccak256(Buffer.from(signature)).subarray(0, 4).toString('hex');
}

/** balanceOf(recipient) — native (ETH) claimable balance on the v2 fee escrow. */
export async function escrowNativeBalance(recipient: string): Promise<bigint> {
  if (!isAddress(recipient)) throw new Error(`invalid address: ${recipient}`);
  const hex = await ethCall(PONS_V2_FEE_ESCROW, selector('balanceOf(address)') + recipient.toLowerCase().replace(/^0x/, '').padStart(64, '0'));
  return big(hex, 0);
}

/** balanceOfToken(recipient, token) — ERC-20 claimable balance (custom-pair quote asset or launch token buyback vest). */
export async function escrowTokenBalance(recipient: string, token: string): Promise<bigint> {
  if (!isAddress(recipient) || !isAddress(token)) throw new Error('invalid address');
  const data = selector('balanceOfToken(address,address)')
    + recipient.toLowerCase().replace(/^0x/, '').padStart(64, '0')
    + token.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const hex = await ethCall(PONS_V2_FEE_ESCROW, data);
  return big(hex, 0);
}

/** Recent pons launches from the official v1 launch feed (off-chain JSON). */
export async function ponsLaunchFeed(limit = 10): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${PONS_V1_LAUNCH_FEED}?limit=${Math.min(Math.max(limit, 1), 50)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`launch feed HTTP ${res.status}`);
  const j = (await res.json()) as { launches?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  return Array.isArray(j) ? j : (j.launches ?? []);
}
