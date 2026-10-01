// Read-only pons v2 factory intelligence: launch configs, launch records, and the
// decaying snipe tax. Read-only by design — this module never builds or signs a launch.
import { ethCall, isAddress } from './chain.js';
import { keccak256 } from './crypto.js';

function selector(signature: string): string {
  return '0x' + keccak256(Buffer.from(signature)).subarray(0, 4).toString('hex');
}

function word(hex: string, byteOffset: number): string {
  const raw = hex.replace(/^0x/, '');
  return raw.slice(byteOffset * 2, byteOffset * 2 + 64);
}

function addr(hex: string, byteOffset: number): string {
  return '0x' + word(hex, byteOffset).slice(-40);
}

function big(hex: string, byteOffset: number): bigint {
  return BigInt('0x' + word(hex, byteOffset) || '0');
}

// pons v2 active factory (per official pons docs deployed addresses).
export const PONS_V2_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
export const PONS_V2_LAUNCH_AND_BUY = '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948';

/** getLaunchedToken(token) — launch-level state recorded by the v2 factory. */
export async function ponsV2LaunchRecord(token: string) {
  if (!isAddress(token)) throw new Error(`invalid token address: ${token}`);
  const hex = await ethCall(PONS_V2_FACTORY, selector('getLaunchedToken(address)') + token.toLowerCase().replace(/^0x/, '').padStart(64, '0'));
  // struct: token, deployer, pairedToken, positionManager, positionId, dexId,
  //        launchConfigId, restrictionsEndBlock, supply, isToken0, poolFee, exists, initialBuyAmount
  return {
    token: addr(hex, 0),
    deployer: addr(hex, 1),
    pairedToken: addr(hex, 2),
    positionManager: addr(hex, 3),
    positionId: big(hex, 4).toString(),
    dexId: big(hex, 5).toString(),
    launchConfigId: big(hex, 6).toString(),
    restrictionsEndBlock: big(hex, 7).toString(),
    supply: big(hex, 8).toString(),
    isToken0: big(hex, 9) === 1n,
    poolFee: big(hex, 10).toString(),
    exists: big(hex, 11) === 1n,
    initialBuyAmount: big(hex, 12).toString(),
    source: 'pons v2 factory getLaunchedToken',
  };
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
