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

import { isAddress } from './chain.js';
import type { PonsMCPClient, PayResult } from './index.js';

export interface ResourcePayment {
  ok: boolean;
  stage: 'parsed' | 'policy_denied' | 'paid' | 'failed' | 'unsupported';
  priceUsdg?: string;
  payTo?: string;
  chainId?: number;
  payment?: PayResult;
  error?: string;
}

interface Parsed402 {
  priceUsdg: string;
  payTo: string;
  chainId?: number;
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
  let body: unknown;
  try { body = await response.json(); } catch {
    return { ok: false, stage: 'unsupported', error: '402 body was not JSON' };
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
