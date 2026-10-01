// ERC-20 read helpers (eth_call based).
import { ethCall, hexToBigInt, decodeAbiString } from './chain.js';

const SEL = {
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  totalSupply: '0x18160ddd',
  balanceOf: '0x70a08231', // + address word
};

export async function tokenName(token: string): Promise<string> {
  return decodeAbiString(await ethCall(token, SEL.name));
}

export async function tokenSymbol(token: string): Promise<string> {
  return decodeAbiString(await ethCall(token, SEL.symbol));
}

export async function tokenDecimals(token: string): Promise<number> {
  return Number(hexToBigInt(await ethCall(token, SEL.decimals)));
}

export async function totalSupply(token: string): Promise<bigint> {
  return hexToBigInt(await ethCall(token, SEL.totalSupply));
}

export async function balanceOf(token: string, wallet: string): Promise<bigint> {
  const data = SEL.balanceOf + wallet.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return hexToBigInt(await ethCall(token, data));
}
