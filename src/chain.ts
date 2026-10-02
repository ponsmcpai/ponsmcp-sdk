// Robinhood Chain (4663) low-level JSON-RPC client + ABI helpers.
// Zero external deps — uses global fetch (Node >= 20).
import { setDefaultAutoSelectFamily } from 'node:net';
try { setDefaultAutoSelectFamily(true); } catch { /* older node */ }

export const CHAIN = {
  name: 'Robinhood Chain',
  chainId: 4663,
  rpcUrl: process.env.PONSMCP_RPC_URL ?? 'https://rpc.nodeflare.app/robinhood/public',
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

// Per-endpoint timeout. Kept short on purpose: MCP hosts typically enforce a
// ~30-60s tool-call budget, and a single slow/dead endpoint must never be
// allowed to eat that whole budget. We'd rather fail one endpoint fast and
// move to the next than sit in a single 8s+ fetch.
const ENDPOINT_TIMEOUT_MS = 4_000;
// Total wall-clock budget across ALL endpoints + retries for one rpc() call.
const TOTAL_BUDGET_MS = 12_000;

// Limit concurrent RPC calls: hosted endpoints throttle bursts, and our own
// timeout would otherwise abort queued requests. Queue instead.
let rpcInFlight = 0;
const rpcQueue: Array<() => void> = [];
const MAX_CONCURRENT_RPC = 6;
function releaseRpcSlot(): void {
  const next = rpcQueue.shift();
  if (next) next();
  else rpcInFlight--;
}
async function acquireRpcSlot(): Promise<() => void> {
  if (rpcInFlight < MAX_CONCURRENT_RPC) { rpcInFlight++; return releaseRpcSlot; }
  return new Promise((resolve) => { rpcQueue.push(() => resolve(releaseRpcSlot)); });
}

function rpcEndpoints(): string[] {
  if (process.env.PONSMCP_RPC_URL) return [process.env.PONSMCP_RPC_URL];
  const alchemyKey = process.env.PONSMCP_ALCHEMY_KEY;
  return [
    // Alchemy first when a key is configured — fastest and most reliable in
    // practice. "rpc.mainnet.chain.robinhood.com" is deliberately NOT in this
    // list: it resolves (via some ISPs) to a captive/blocked-content page
    // rather than the chain, and hangs for the full connect timeout instead
    // of failing fast. Keep it out unless proven otherwise.
    ...(alchemyKey ? [`https://robinhood-mainnet.g.alchemy.com/v2/${alchemyKey}`] : []),
    'https://rpc.nodeflare.app/robinhood/public',
    'https://lb.routeme.sh/rpc/evm/4663',
  ];
}

export async function rpc<T = any>(method: string, params: unknown[]): Promise<T> {
  const urls = rpcEndpoints();
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let lastError: unknown;
  const release = await acquireRpcSlot();
  try {
    for (const url of urls) {
      if (Date.now() >= deadline) break;
      const remaining = deadline - Date.now();
      const perCallTimeout = Math.max(500, Math.min(ENDPOINT_TIMEOUT_MS, remaining));
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) ponsmcp-sdk/1.5' },
          body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
          signal: AbortSignal.timeout(perCallTimeout),
        });
        if (!res.ok) {
          if (res.status === 429 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 400));
            continue; // retry the SAME endpoint once before moving on
          }
          throw new Error(`RPC HTTP ${res.status}`);
        }
        const j = (await res.json()) as { result?: T; error?: { message: string } };
        if (j.error) throw new Error(`RPC error: ${j.error.message}`);
        return j.result as T;
      } catch (error) {
        lastError = error;
        // Any failure (timeout, DNS, connection refused, HTTP error) moves to
        // the next endpoint immediately — no same-endpoint retry loop that
        // could burn the whole budget on one bad host.
      }
    }
  } finally {
    release();
  }
  throw lastError instanceof Error ? lastError : new Error('all RPC endpoints failed or budget exhausted');
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
