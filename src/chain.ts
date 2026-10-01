// Robinhood Chain (4663) low-level JSON-RPC client + ABI helpers.
// Zero external deps — uses global fetch (Node >= 20).

export const CHAIN = {
  name: 'Robinhood Chain',
  chainId: 4663,
  rpcUrl: process.env.PONSMCP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com',
  explorer: 'https://robinhoodchain.blockscout.com',
  gasToken: 'ETH',
  pons: '0x39dBED3a2bd333467115dE45665cC57F813C4571',
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  usdgDecimals: 6,
} as const;

export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // keccak("Transfer(address,address,uint256)")

export function isAddress(a: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

export async function rpc<T = any>(method: string, params: unknown[]): Promise<T> {
  const urls = process.env.PONSMCP_RPC_URL
    ? [process.env.PONSMCP_RPC_URL]
    : [CHAIN.rpcUrl, 'https://rpc.nodeflare.app/robinhood/public'];
  let lastError: unknown;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'ponsmcp-sdk/0.1' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      });
      if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
      const j = (await res.json()) as { result?: T; error?: { message: string } };
      if (j.error) throw new Error(`RPC error: ${j.error.message}`);
      return j.result as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('all RPC endpoints failed');
}

export async function ethCall(to: string, data: string): Promise<string> {
  return rpc<string>('eth_call', [{ to, data }, 'latest']);
}

export function hexToBigInt(hex: string): bigint {
  return BigInt(hex === '0x' || !hex ? '0x0' : hex);
}

/** Decode an ABI-encoded dynamic string at offset 0x60 (standard ERC-20 name()/symbol() layout). */
export function decodeAbiString(hex: string): string {
  const h = hex.replace(/^0x/, '');
  if (h.length < 128) return '';
  const len = parseInt(h.slice(64, 128), 16);
  const raw = h.slice(128, 128 + len * 2);
  return Buffer.from(raw, 'hex').toString('utf8').replace(/\0+$/g, '');
}

/** Format a token amount (base units) into a human string. */
export function unitToString(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString()}${frac ? '.' + frac : ''}`;
}

/** USD decimal string ("5.00") -> settlement token base units (USDG, 6 decimals). */
export function usdToMicro(usd: string | number): bigint {
  const n = typeof usd === 'string' ? Number.parseFloat(usd) : usd;
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid USD amount: ${usd}`);
  return BigInt(Math.round(n * 1e6));
}

/** ABI-encode address to 32-byte hex word (lowercase, no 0x). */
function addrWord(addr: string): string {
  if (!isAddress(addr)) throw new Error(`invalid address: ${addr}`);
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

/** ERC-20 transfer(address,uint256) calldata. */
export function erc20TransferData(to: string, amountBase: bigint): string {
  return '0xa9059cbb' + addrWord(to) + amountBase.toString(16).padStart(64, '0');
}

export interface LogEntry {
  address: string;
  topics: string[];
  data: string;
}

export interface Receipt {
  transactionHash: string;
  status: '0x1' | '0x0';
  blockNumber: string;
  gasUsed: string;
  logs: LogEntry[];
}

export async function getReceipt(hash: string): Promise<Receipt | null> {
  const r = await rpc<Receipt | null>('eth_getTransactionReceipt', [hash]);
  return r ?? null;
}

export interface TransferEvent {
  token: string;
  from: string;
  to: string;
  value: bigint;
}

/** Extract ERC-20 Transfer events from a receipt. */
export function extractTransfers(receipt: Receipt): TransferEvent[] {
  const out: TransferEvent[] = [];
  for (const log of receipt.logs ?? []) {
    if (log.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC && log.topics.length >= 3) {
      out.push({
        token: log.address.toLowerCase(),
        from: '0x' + log.topics[1].slice(-40),
        to: '0x' + log.topics[2].slice(-40),
        value: BigInt(log.data === '0x' ? '0x0' : log.data),
      });
    }
  }
  return out;
}
