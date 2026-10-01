// Read-only helpers for pons v1 launch tokens. Values come straight from the token contract.
import { ethCall, hexToBigInt, isAddress } from './chain.js';
import { keccak256 } from './crypto.js';
import { tokenName, tokenSymbol, tokenDecimals, totalSupply } from './erc20.js';

function selector(signature: string): string {
  return '0x' + keccak256(Buffer.from(signature)).subarray(0, 4).toString('hex');
}

function word(hex: string, byteOffset: number): string {
  const raw = hex.replace(/^0x/, '');
  return raw.slice(byteOffset * 2, byteOffset * 2 + 64).padEnd(64, '0');
}

function stringAt(hex: string, byteOffset: number): string {
  const len = Number(BigInt('0x' + word(hex, byteOffset)));
  const raw = hex.replace(/^0x/, '').slice((byteOffset + 32) * 2, (byteOffset + 32 + len) * 2);
  return Buffer.from(raw, 'hex').toString('utf8');
}

async function stringGetter(token: string, signature: string): Promise<string> {
  const result = await ethCall(token, selector(signature));
  return stringAt(result, Number(BigInt('0x' + word(result, 0))));
}

async function addressGetter(token: string, signature: string): Promise<string> {
  const result = await ethCall(token, selector(signature));
  return '0x' + word(result, 0).slice(-40);
}

/** Read the self-describing metadata and canonical pool exposed by a pons v1 launch token. */
export async function ponsLaunchInfo(token: string) {
  if (!isAddress(token)) throw new Error(`invalid token address: ${token}`);
  try {
    const [name, symbol, decimals, supply, logo, description, pool, socialsRaw] = await Promise.all([
      tokenName(token), tokenSymbol(token), tokenDecimals(token), totalSupply(token),
      stringGetter(token, 'logo()'), stringGetter(token, 'description()'),
      addressGetter(token, 'liquidityPool()'), ethCall(token, selector('socials()')),
    ]);
    const socials = [0, 1, 2, 3, 4].map((i) => stringAt(socialsRaw, Number(BigInt('0x' + word(socialsRaw, i * 32)))));
    return {
      token: token.toLowerCase(), name, symbol, decimals, totalSupply: supply.toString(),
      logo, description, pool: pool.toLowerCase(),
      socials: { twitter: socials[0], telegram: socials[1], discord: socials[2], website: socials[3], farcaster: socials[4] },
      source: 'onchain pons launch-token getters',
    };
  } catch (error: any) {
    throw new Error(`not a readable pons v1 launch token: ${error?.message ?? String(error)}`);
  }
}
