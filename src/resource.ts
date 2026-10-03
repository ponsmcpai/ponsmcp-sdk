// HTTP 402 resource payment flow for PonsMCP.
// A service answers 402 with a machine-readable requirement; this helper parses
// it, enforces policy, pays the exact price to the declared recipient, and
// returns the settlement the agent can retry the request with.
//
// Supported 402 shapes (any of):
//   { amount_usdg: "2.50", pay_to: "0x…", chain_id?: 4663 }
//   { price_usdg: "2.50", merchant: "0x…" }
//   { intent: { payment: { amount_usdg: "2.50", pay_to: "0x…" } } }
//   { service: { price_usdg: "2.50", merchant: "0x…" } }
//   { create_intent: { amount_usdg: "2.50", merchant_address: "0x…" } }

import { CHAIN, isAddress } from './chain.js';
import type { PonsMCPClient, PayResult } from './index.js';
import { parse402Response, type X402Requirement } from './x402.js';

export interface ResourcePayment {
  ok: boolean;
  stage: 'parsed' | 'policy_denied' | 'paid' | 'failed' | 'unsupported';
  priceUsdg?: string;
  payTo?: string;
  chainId?: number;
  payment?: PayResult;
  /** Set when the 402 was x402-formatted (X-PAYMENT header / accepts body). */
  x402?: boolean;
  error?: string;
}

interface Parsed402 {
  priceUsdg: string;
  payTo: string;
  chainId?: number;
  x402?: boolean;
}

/** maxAmountRequired (asset base units, 6 dec) → USD decimal string. */
function microToUsd(amount: string | number): string | null {
  const n = typeof amount === 'number' ? amount : Number.parseFloat(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const usd = n / 1e6;
  return usd.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

/** Normalize a parsed x402 requirement into the Parsed402 settlement shape. */
function fromX402Requirement(req: X402Requirement): Parsed402 | null {
  const usd = microToUsd(req.maxAmountRequired ?? '');
  if (!usd) return null;
  return { priceUsdg: usd, payTo: req.payTo, x402: true };
}

export function parse402(body: unknown): Parsed402 | null {
  const b = body as Record<string, any> | null | undefined;
  if (!b || typeof b !== 'object') return null;
  const candidates: Array<{ price?: unknown; payTo?: unknown; chainId?: unknown }> = [
    { price: b.amount_usdg, payTo: b.pay_to, chainId: b.chain_id },
    { price: b.price_usdg, payTo: b.merchant, chainId: b.chain_id },
    { price: b.intent?.payment?.amount_usdg, payTo: b.intent?.payment?.pay_to, chainId: b.intent?.payment?.chain_id },
    { price: b.service?.price_usdg, payTo: b.service?.merchant, chainId: b.chain_id },
    { price: b.create_intent?.amount_usdg, payTo: b.create_intent?.merchant_address },
  ];
  for (const c of candidates) {
    const price = typeof c.price === 'string' || typeof c.price === 'number' ? String(c.price) : null;
    const payTo = typeof c.payTo === 'string' ? c.payTo : null;
    if (price && payTo && isAddress(payTo) && /^\d+(\.\d{1,6})?$/.test(price)) {
      return { priceUsdg: price, payTo, chainId: typeof c.chainId === 'number' ? c.chainId : undefined };
    }
  }
  return null;
}

/**
 * Pay for a 402-gated resource.
 * 1. fetch the URL, 2. parse the 402 requirement, 3. quote + pay exactly that
 * price with the client's policy, 4. return the settlement data so the caller
 * can retry the request with the transaction hash.
 * Nothing is broadcast unless the 402 parses and policy allows the price.
 */
export async function payForResource(
  client: PonsMCPClient,
  url: string,
  opts: { waitMs?: number; fetchInit?: RequestInit } = {},
): Promise<ResourcePayment> {
  let response: Response;
  try {
    response = await fetch(url, { accept: 'application/json', ...opts.fetchInit } as RequestInit);
  } catch (e: any) {
    return { ok: false, stage: 'unsupported', error: `resource fetch failed: ${e?.message ?? String(e)}` };
  }
  if (response.status !== 402) {
    return { ok: false, stage: 'unsupported', error: `expected HTTP 402 from ${url}, got ${response.status}` };
  }
  // x402 first: X-PAYMENT header (base64 JSON) or an { x402Version, accepts }
  // body take precedence over the native body shapes below.
  const x402 = parse402Response(response, await response.clone().json().catch(() => undefined));
  if (x402.ok && x402.requirement) {
    const req = x402.requirement;
    if (req.scheme && req.scheme !== 'exact') {
      return { ok: false, stage: 'unsupported', error: `unsupported x402 scheme '${req.scheme}' — only 'exact' is settled directly`, x402: true };
    }
    if (req.network && !/(4663|robinhood)/i.test(req.network)) {
      return { ok: false, stage: 'unsupported', error: `x402 requirement targets network '${req.network}'; PonsMCP settles on Robinhood Chain (4663)`, x402: true };
    }
    if (req.asset && isAddress(req.asset) && req.asset.toLowerCase() !== CHAIN.usdg.toLowerCase()) {
      return { ok: false, stage: 'unsupported', error: `x402 requirement demands asset ${req.asset}; PonsMCP settles in USDG (${CHAIN.usdg})`, x402: true };
    }
    const parsedX = fromX402Requirement(req);
    if (!parsedX) {
      return { ok: false, stage: 'unsupported', error: `invalid x402 maxAmountRequired '${req.maxAmountRequired}'`, x402: true };
    }
    const paymentX = await client.pay({ payTo: parsedX.payTo, amountUsd: parsedX.priceUsdg, waitMs: opts.waitMs });
    if (!paymentX.ok) {
      return { ok: false, stage: paymentX.stage === 'policy_denied' ? 'policy_denied' : 'failed', priceUsdg: parsedX.priceUsdg, payTo: parsedX.payTo, x402: true, payment: paymentX, error: paymentX.error };
    }
    return { ok: true, stage: 'paid', priceUsdg: parsedX.priceUsdg, payTo: parsedX.payTo, chainId: 4663, x402: true, payment: paymentX };
  }
  let body: unknown;
  try { body = await response.json(); } catch {
    return { ok: false, stage: 'unsupported', error: '402 body was not JSON and no x402 X-PAYMENT header was present' };
  }
  const parsed = parse402(body);
  if (!parsed) {
    return { ok: false, stage: 'unsupported', error: '402 body lacks a recognized price/payTo shape' };
  }
  if (parsed.chainId !== undefined && parsed.chainId !== 4663) {
    return { ok: false, stage: 'unsupported', error: `resource demands chain ${parsed.chainId}; PonsMCP settles on 4663` };
  }
  const payment = await client.pay({ payTo: parsed.payTo, amountUsd: parsed.priceUsdg, waitMs: opts.waitMs });
  if (!payment.ok) {
    return { ok: false, stage: payment.stage === 'policy_denied' ? 'policy_denied' : 'failed', priceUsdg: parsed.priceUsdg, payTo: parsed.payTo, payment, error: payment.error };
  }
  return { ok: true, stage: 'paid', priceUsdg: parsed.priceUsdg, payTo: parsed.payTo, chainId: 4663, payment };
}
