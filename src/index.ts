// PonsMCP client — quote → policy → sign → broadcast → receipt verification.

import {
  CHAIN, rpc, isAddress, unitToString, usdToMicro,
  erc20TransferData, getReceipt, extractTransfers, hexToBigInt,
} from './chain.js';
import { balanceOf, tokenName, tokenSymbol, tokenDecimals } from './erc20.js';
import { PolicyEngine } from './policy.js';
import { ponsBest, type PairInfo } from './dexscreener.js';
import {
  privateKeyToAddress, signTransaction, type LegacyTx,
} from './crypto.js';
import { randomBytes } from 'node:crypto';

export interface PayOptions {
  /** Recipient address (merchant or 402 response payTo). */
  payTo: string;
  /** Amount in USD decimal string, e.g. "5.00" — settled in USDG (6 dec). */
  amountUsd: string;
  /** ERC-20 transfer calldata attachment (memo), default empty. */
  memo?: string;
  /** Max ms to wait for the receipt (default 30000). */
  waitMs?: number;
}

export interface PayResult {
  ok: boolean;
  stage: 'policy_denied' | 'broadcast' | 'confirmed' | 'failed' | 'timeout';
  quote: { token: string; symbol: string; amountBase: bigint; amountHuman: string; usd: string };
  txHash?: string;
  explorer?: string;
  blockNumber?: bigint;
  gasUsed?: bigint;
  transfers?: Array<{ token: string; from: string; to: string; amountHuman: string }>;
  error?: string;
}

export interface ClientOptions {
  /** Funded agent wallet private key (hex, with or without 0x). */
  privateKey?: string;
  rpcUrl?: string;
  policy?: { maxPerTx?: bigint; dailyLimit?: bigint };
}

export class PonsMCPClient {
  readonly policy: PolicyEngine;
  private priv?: bigint;
  readonly address?: string;

  constructor(private opts: ClientOptions = {}) {
    this.policy = new PolicyEngine(opts.policy);
    if (opts.privateKey) {
      const hex = opts.privateKey.replace(/^0x/, '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('privateKey must be 64 hex chars');
      this.priv = BigInt('0x' + hex);
      this.address = privateKeyToAddress(this.priv);
    }
  }

  get hasWallet(): boolean {
    return this.priv !== undefined;
  }

  async getBalance(token: string = CHAIN.usdg): Promise<{ raw: bigint; human: string; decimals: number }> {
    if (!this.address) throw new Error('no wallet configured');
    const raw = await balanceOf(token, this.address);
    const dec = await tokenDecimals(token);
    return { raw, human: unitToString(raw, dec), decimals: dec };
  }

  async quote(amountUsd: string): Promise<PayResult['quote']> {
    const amountBase = usdToMicro(amountUsd);
    return {
      token: CHAIN.usdg,
      symbol: 'USDG',
      amountBase,
      amountHuman: unitToString(amountBase, CHAIN.usdgDecimals),
      usd: amountUsd,
    };
  }

  async price(): Promise<PairInfo | null> {
    return ponsBest();
  }

  /** Execute a payment: policy check → ERC-20 USDG transfer → receipt verify. */
  async pay(o: PayOptions): Promise<PayResult> {
    if (!isAddress(o.payTo)) {
      return this.fail('policy_denied', o, `invalid payTo address: ${o.payTo}`);
    }
    const quote = await this.quote(o.amountUsd);
    const decision = this.policy.check(quote.amountBase);
    if (!decision.allowed) {
      return { ...this.fail('policy_denied', o, decision.reason), quote };
    }
    if (!this.priv) {
      return { ...this.fail('policy_denied', o, 'no wallet configured (set PONSMCP_PRIVATE_KEY)'), quote };
    }

    // 1. funds check
    const bal = await this.getBalance(CHAIN.usdg);
    if (bal.raw < quote.amountBase) {
      return { ...this.fail('policy_denied', o, `insufficient USDG: have ${bal.human}, need ${quote.amountHuman}`), quote };
    }

    // 2. build tx
    const nonce = hexToBigInt(await rpc<string>('eth_getTransactionCount', [this.address, 'pending']));
    const gp = hexToBigInt(await rpc<string>('eth_gasPrice', []));
    const gasPrice = gp > 100_000_000n ? (gp * 3n) / 2n : 100_000_000n;
    const tx: LegacyTx = {
      nonce,
      gasPrice,
      gas: 120_000n,
      to: CHAIN.usdg,
      value: 0n,
      data: Buffer.from(erc20TransferData(o.payTo, quote.amountBase).replace(/^0x/, ''), 'hex'),
      chainId: CHAIN.chainId,
    };

    // 3. sign + broadcast
    const raw = signTransaction(tx, this.priv);
    let hash: string;
    try {
      hash = await rpc<string>('eth_sendRawTransaction', ['0x' + raw.toString('hex')]);
    } catch (e: any) {
      return { ...this.fail('failed', o, `broadcast rejected: ${e.message}`), quote };
    }

    // 4. wait + verify
    const receipt = await this.waitForReceipt(hash, o.waitMs ?? 30_000);
    if (!receipt) {
      return { ok: false, stage: 'timeout', quote, txHash: hash, explorer: this.explorer(hash), error: 'no receipt within wait window' };
    }
    if (receipt.status !== '0x1') {
      return { ok: false, stage: 'failed', quote, txHash: hash, explorer: this.explorer(hash), error: 'transaction reverted' };
    }
    this.policy.record(quote.amountBase);
    const transfers = extractTransfers(receipt).map((t) => ({
      token: t.token,
      from: t.from,
      to: t.to,
      amountHuman: t.token.toLowerCase() === CHAIN.usdg.toLowerCase()
        ? unitToString(t.value, CHAIN.usdgDecimals)
        : t.value.toString(),
    }));
    return {
      ok: true,
      stage: 'confirmed',
      quote,
      txHash: hash,
      explorer: this.explorer(hash),
      blockNumber: BigInt(receipt.blockNumber),
      gasUsed: BigInt(receipt.gasUsed),
      transfers,
    };
  }

  private explorer(hash: string): string {
    return `${CHAIN.explorer}/tx/${hash}`;
  }

  private fail(stage: PayResult['stage'], _o: PayOptions, error: string): PayResult {
    return { ok: false, stage, quote: { token: CHAIN.usdg, symbol: 'USDG', amountBase: 0n, amountHuman: '0', usd: '0' }, error };
  }

  async waitForReceipt(hash: string, waitMs: number) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const r = await getReceipt(hash);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 2000));
    }
    return null;
  }

  async txStatus(hash: string) {
    const r = await getReceipt(hash);
    if (!r) return { found: false, status: 'pending' as const };
    return {
      found: true,
      status: r.status === '0x1' ? ('success' as const) : ('reverted' as const),
      blockNumber: BigInt(r.blockNumber),
      gasUsed: BigInt(r.gasUsed),
      transfers: extractTransfers(r).map((t) => ({
        token: t.token, from: t.from, to: t.to, value: t.value.toString(),
      })),
    };
  }

  async tokenInfo(token: string) {
    const [name, symbol, dec] = await Promise.all([
      tokenName(token), tokenSymbol(token), tokenDecimals(token),
    ]);
    return { name, symbol, decimals: dec };
  }
}

export { payForResource, parse402, type ResourcePayment } from './resource.js';

// re-exports
export { CHAIN };
export { tokenName, tokenSymbol, tokenDecimals, totalSupply, balanceOf } from './erc20.js';
export { PolicyEngine } from './policy.js';
export { ponsPairs, ponsBest } from './dexscreener.js';
export { randomBytes };
