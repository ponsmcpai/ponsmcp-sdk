// Read-only pons v2 factory intelligence: launch configs, launch records, and the
// decaying snipe tax. Read-only by design — this module never builds or signs a launch.
import { ethCall, isAddress } from './chain.js';
import { keccak256 } from './crypto.js';

function selector(signature: string): string {
  return '0x' + keccak256(Buffer.from(signature)).subarray(0, 4).toString('hex');
}

/** 32-byte ABI word `index` (0-based) of a return value, as 64 hex chars ('' past the end). */
function word(hex: string, index: number): string {
  const raw = hex.replace(/^0x/, '');
  return raw.slice(index * 64, index * 64 + 64);
}

function addr(hex: string, index: number): string {
  return '0x' + word(hex, index).padStart(64, '0').slice(-40);
}

function big(hex: string, index: number): bigint {
  return BigInt('0x' + (word(hex, index) || '0'));
}

/** Signed ABI word (int24 and friends are sign-extended to 256 bits). */
function int(hex: string, index: number): bigint {
  return BigInt.asIntN(256, big(hex, index));
}

// pons v2 active factory (per official pons docs deployed addresses).
export const PONS_V2_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
export const PONS_V2_LAUNCH_AND_BUY = '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948';

/**
 * Decode the return value of the v2 factory's getLaunchedToken(address):
 *   (address token, address curve, address deployer, address creatorFeeRecipient,
 *    address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing,
 *    uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote,
 *    uint256 sweptTokens, uint256 sweptAt, bool exists)
 * — a static tuple, so each field is one 32-byte word in order.
 */
export function decodeLaunchedToken(hex: string) {
  return {
    token: addr(hex, 0),
    curve: addr(hex, 1),
    deployer: addr(hex, 2),
    creatorFeeRecipient: addr(hex, 3),
    pairToken: addr(hex, 4),
    graduationThreshold: big(hex, 5).toString(),
    poolFee: big(hex, 6).toString(),
    tickSpacing: int(hex, 7).toString(),
    creatorTaxBps: big(hex, 8).toString(),
    buybackEnabled: big(hex, 9) === 1n,
    phase: big(hex, 10).toString(),
    sweptQuote: big(hex, 11).toString(),
    sweptTokens: big(hex, 12).toString(),
    sweptAt: big(hex, 13).toString(),
    exists: big(hex, 14) === 1n,
  };
}

/** getLaunchedToken(token) — launch-level state recorded by the v2 factory. */
export async function ponsV2LaunchRecord(token: string) {
  if (!isAddress(token)) throw new Error(`invalid token address: ${token}`);
  const hex = await ethCall(PONS_V2_FACTORY, selector('getLaunchedToken(address)') + token.toLowerCase().replace(/^0x/, '').padStart(64, '0'));
  return { ...decodeLaunchedToken(hex), source: 'pons v2 factory getLaunchedToken' };
}

/** launchConfigCount() — how many launch configs the v2 factory holds. */
export async function ponsV2ConfigCount(): Promise<number> {
  const hex = await ethCall(PONS_V2_FACTORY, selector('launchConfigCount()'));
  return Number(big(hex, 0));
}

/**
 * currentSnipeTaxBps(recipient) on a v2 curve.
 * The pons docs require reading this per recipient before quoting an opening
 * buy — a router must ask about the wallet receiving the tokens.
 */
export async function ponsV2SnipeTaxBps(curve: string, recipient: string): Promise<number> {
  if (!isAddress(curve) || !isAddress(recipient)) throw new Error('invalid curve or recipient address');
  const data = selector('currentSnipeTaxBps(address)') + recipient.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const hex = await ethCall(curve, data);
  return Number(big(hex, 0));
}
