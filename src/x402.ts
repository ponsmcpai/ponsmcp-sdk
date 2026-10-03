// x402 protocol compatibility layer (https://x402.org style HTTP 402 payments).
// A server answers 402 PAYMENT-REQUIRED with payment requirements, the client
// settles, then retries the original request with a signed X-PAYMENT header.
//
// Wire format handled here (v1-style, base64-encoded JSON in the X-PAYMENT
// response header, or the same JSON as the 402 body):
//   { x402Version: 1, scheme: "exact", network: "…", resource: "https://…",
//     description: "…", mimeType: "application/json",
//     maxAmountRequired: "2500000", payTo: "0x…", asset?: "0x…" }
// Servers MAY also send the v1 body shape { x402Version, accepts: [req, …] }.
//
// The retry header carries the settlement proof PonsMCP produces:
//   { x402Version, scheme, network, payload: { txHash, payer, payTo, token,
//     amountBase, amountHuman, chainId, explorer } }

import { CHAIN, isAddress } from './chain.js';
import type { PonsMCPClient, PayResult } from './index.js';
import { PolicyEngine } from './policy.js';

const FETCH_TIMEOUT_MS = 15_000;
const DISCOVER_TIMEOUT_MS = 5_000;
const RETRY_TIMEOUT_MS = 20_000;

export interface X402Requirement {
  x402Version: number;
  scheme: string;
  network: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  /** Asset base units (USDC/USDG = 6 decimals), as a string per the spec. */
  maxAmountRequired?: string | number;
  payTo: string;
  asset?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export interface X402PaymentRequired {
  ok: boolean;
  /** Normalized primary requirement (first entry). */
  requirement?: X402Requirement;
  /** All requirement entries when the server sent multiple accepts. */
  accepts?: X402Requirement[];
  source: 'header' | 'body' | 'none';
  error?: string;
}

export interface X402SettleResult {
  ok: boolean;
  stage: 'parsed' | 'policy_denied' | 'paid' | 'failed' | 'unsupported';
  priceUsdg?: string;
  payTo?: string;
  payment?: PayResult;
  error?: string;
}

export interface X402FetchResult {
  ok: boolean;
  status: number;
  paid: boolean;
  /** Parsed JSON body when the final response is JSON, else null. */
  json: unknown;
  /** Raw final response body (truncated to 8 KiB for tool output safety). */
  body: string;
  /** True when the server still answered 402 after the payment retry. */
  still402: boolean;
  payment?: PayResult;
  requirement?: X402Requirement;
  error?: string;
}

export interface X402Resource {
  url: string;
  priceUsdg?: string;
  maxAmountRequired?: string;
  payTo?: string;
  description?: string;
  mimeType?: string;
  network?: string;
}

export interface X402DiscoverResult {
  ok: boolean;
  domain: string;
  source: string | null;
  resources: X402Resource[];
  errors: string[];
}

// ---------------------------------------------------------------- parsing

function decodeBase64Json(value: string): Record<string, unknown> | null {
  try {
    const json = Buffer.from(value.replace(/^b64:/, '').trim(), 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Pull the first requirement out of a decoded x402 object (header or body shape). */
function requirementFromObject(obj: Record<string, unknown>): X402Requirement | null {
  const accepts = Array.isArray(obj.accepts) ? obj.accepts : null;
  const candidates: unknown[] = accepts ? accepts : [obj];
  for (const raw of candidates) {
    const c = raw as Record<string, any>;
    if (!c || typeof c !== 'object') continue;
    // v1 uses maxAmountRequired; tolerate amount/price variants defensively.
    const amount = c.maxAmountRequired ?? c.maxAmountRequiredUsdg ?? c.amount ?? c.price;
    if (typeof c.payTo === 'string' && isAddress(c.payTo) && (typeof amount === 'string' || typeof amount === 'number')) {
      return {
        x402Version: typeof c.x402Version === 'number' ? c.x402Version : 1,
        scheme: typeof c.scheme === 'string' ? c.scheme : 'exact',
        network: typeof c.network === 'string' ? c.network : 'robinhood-chain',
        resource: typeof c.resource === 'string' ? c.resource : undefined,
        description: typeof c.description === 'string' ? c.description : undefined,
        mimeType: typeof c.mimeType === 'string' ? c.mimeType : undefined,
        maxAmountRequired: String(amount),
        payTo: c.payTo,
        asset: typeof c.asset === 'string' ? c.asset : undefined,
        maxTimeoutSeconds: typeof c.maxTimeoutSeconds === 'number' ? c.maxTimeoutSeconds : undefined,
        extra: c.extra && typeof c.extra === 'object' ? c.extra : undefined,
      };
    }
  }
  return null;
}

function allRequirementsFromObject(obj: Record<string, unknown>): X402Requirement[] {
  const primary = requirementFromObject(obj);
  if (!primary) return [];
  const accepts = Array.isArray(obj.accepts) ? obj.accepts : null;
  if (!accepts) return [primary];
  const out: X402Requirement[] = [];
  for (const raw of accepts) {
    const single = requirementFromObject({ ...raw as Record<string, unknown>, x402Version: obj.x402Version });
    if (single) out.push(single);
  }
  return out.length ? out : [primary];
}

/**
 * Parse an x402 402 PAYMENT-REQUIRED response into normalized requirements.
 * Checks the X-PAYMENT response header (base64 JSON) first, then the JSON body
 * (flat object or { x402Version, accepts: [...] }).
 */
export function parse402Response(response: Response, body?: unknown): X402PaymentRequired {
  const header = response.headers.get('x-payment') ?? response.headers.get('X-PAYMENT');
  if (header) {
    const decoded = decodeBase64Json(header);
    if (decoded) {
      const req = requirementFromObject(decoded);
      if (req) {
        return {
          ok: true,
          requirement: req,
          accepts: allRequirementsFromObject(decoded),
          source: 'header',
        };
      }
      return { ok: false, source: 'header', error: 'X-PAYMENT header decoded but lacks a valid payTo/amount requirement' };
    }
    return { ok: false, source: 'header', error: 'X-PAYMENT header present but not base64 JSON' };
  }
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    if (obj.accepts || obj.x402Version || obj.payTo || obj.maxAmountRequired) {
      const req = requirementFromObject(obj);
      if (req) {
        return { ok: true, requirement: req, accepts: allRequirementsFromObject(obj), source: 'body' };
      }
      return { ok: false, source: 'body', error: '402 body looks like x402 but lacks a valid payTo/amount requirement' };
    }
  }
  return { ok: false, source: 'none', error: '402 response carries no recognizable x402 requirement' };
}

/** true when the response carries an x402 requirement (header or body). */
export function isX402Response(response: Response, body?: unknown): boolean {
  return parse402Response(response, body).ok;
}

// ---------------------------------------------------------------- settlement

/** maxAmountRequired (asset base units, 6 dec) → USD decimal string. */
function amountToUsd(amount: string | number): string | null {
  const n = typeof amount === 'number' ? amount : Number.parseFloat(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return (n / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

const ROBINHOOD_NETWORK_RE = /(4663|robinhood)/i;

/**
 * Settle an x402 requirement using the wrapped client's pay flow — policy
 * check → exact USDG transfer → verified receipt. Nothing broadcasts unless
 * the requirement parses and policy allows the price.
 */
export async function settleX402(
  client: PonsMCPClient,
  requirement: X402Requirement,
  opts: { waitMs?: number } = {},
): Promise<X402SettleResult> {
  if (requirement.scheme && requirement.scheme !== 'exact') {
    return { ok: false, stage: 'unsupported', error: `unsupported x402 scheme '${requirement.scheme}' — only 'exact' is settled directly` };
  }
  if (requirement.network && !ROBINHOOD_NETWORK_RE.test(requirement.network)) {
    return { ok: false, stage: 'unsupported', error: `x402 requirement targets network '${requirement.network}'; PonsMCP settles on Robinhood Chain (4663)` };
  }
  if (requirement.asset && isAddress(requirement.asset) && requirement.asset.toLowerCase() !== CHAIN.usdg.toLowerCase()) {
    return { ok: false, stage: 'unsupported', error: `x402 requirement demands asset ${requirement.asset}; PonsMCP settles in USDG (${CHAIN.usdg})` };
  }
  const priceUsdg = amountToUsd(requirement.maxAmountRequired ?? '');
  if (!priceUsdg) {
    return { ok: false, stage: 'unsupported', error: `invalid maxAmountRequired '${requirement.maxAmountRequired}'` };
  }
  const payment = await client.pay({ payTo: requirement.payTo, amountUsd: priceUsdg, waitMs: opts.waitMs });
  if (!payment.ok) {
    return {
      ok: false,
      stage: payment.stage === 'policy_denied' ? 'policy_denied' : 'failed',
      priceUsdg,
      payTo: requirement.payTo,
      payment,
      error: payment.error,
    };
  }
  return { ok: true, stage: 'paid', priceUsdg, payTo: requirement.payTo, payment };
}

// ---------------------------------------------------------------- retry header

export interface X402PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    txHash: string;
    payer?: string;
    payTo: string;
    token: string;
    amountBase: string;
    amountHuman: string;
    chainId: number;
    explorer: string;
  };
}

/** Encode a settled payment into the X-PAYMENT request header (base64 JSON). */
export function encodePaymentHeader(
  requirement: X402Requirement,
  payment: PayResult,
  payer?: string,
): string {
  const body: X402PaymentPayload = {
    x402Version: requirement.x402Version || 1,
    scheme: requirement.scheme || 'exact',
    network: requirement.network || 'robinhood-chain',
    payload: {
      txHash: payment.txHash ?? '',
      payer,
      payTo: requirement.payTo,
      token: payment.quote.token,
      amountBase: payment.quote.amountBase.toString(),
      amountHuman: payment.quote.amountHuman,
      chainId: CHAIN.chainId,
      explorer: payment.explorer ?? '',
    },
  };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
}

// ---------------------------------------------------------------- client

/**
 * x402-compatible HTTP client on top of the PonsMCP payment rails.
 * fetch() transparently settles x402 402s; discover() probes a domain's
 * x402 manifest endpoints; settle() pays a requirement directly.
 * Spending is always gated by the PolicyEngine (per-tx and daily caps).
 */
export class X402Client {
  readonly client: PonsMCPClient;
  readonly policy: PolicyEngine;

  constructor(client: PonsMCPClient) {
    this.client = client;
    this.policy = client.policy;
  }

  /**
   * Fetch a URL; on 402 with an x402 requirement, settle via policy + pay and
   * retry once with the X-PAYMENT settlement header attached.
   */
  async fetch(url: string, init: RequestInit = {}, opts: { waitMs?: number } = {}): Promise<X402FetchResult> {
    let first: Response;
    try {
      first = await globalThis.fetch(url, {
        ...init,
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e: any) {
      return { ok: false, status: 0, paid: false, json: null, body: '', still402: false, error: `fetch failed: ${e?.message ?? String(e)}` };
    }
    if (first.status !== 402) {
      return this.finalize(first, { paid: false });
    }
    let body402: unknown;
    try { body402 = await first.clone().json(); } catch { body402 = undefined; }
    const parsed = parse402Response(first, body402);
    if (!parsed.ok || !parsed.requirement) {
      return { ok: false, status: 402, paid: false, json: body402 ?? null, body: '', still402: true, error: parsed.error };
    }
    const requirement = parsed.requirement;
    const settlement = await settleX402(this.client, requirement, opts);
    if (!settlement.ok || !settlement.payment) {
      return {
        ok: false, status: 402, paid: false, json: body402 ?? null, body: '', still402: true,
        payment: settlement.payment,
        requirement,
        error: settlement.error ?? settlement.stage,
      };
    }
    // Retry with the signed settlement proof attached.
    let second: Response;
    try {
      const retryHeaders: Record<string, string> = { ...(init.headers as Record<string, string> ?? {}) };
      second = await globalThis.fetch(url, {
        ...init,
        headers: {
          ...retryHeaders,
          Accept: 'application/json',
          'X-PAYMENT': encodePaymentHeader(requirement, settlement.payment, this.client.address),
        },
        signal: AbortSignal.timeout(RETRY_TIMEOUT_MS),
      });
    } catch (e: any) {
      return {
        ok: false, status: 0, paid: true, json: null, body: '', still402: false,
        payment: settlement.payment, requirement,
        error: `payment settled but retry failed: ${e?.message ?? String(e)}`,
      };
    }
    return this.finalize(second, { paid: true, payment: settlement.payment, requirement });
  }

  private async finalize(res: Response, extra: { paid: boolean; payment?: PayResult; requirement?: X402Requirement }): Promise<X402FetchResult> {
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    const trimmed = text.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    return {
      ok: res.ok,
      status: res.status,
      paid: extra.paid,
      still402: res.status === 402,
      payment: extra.payment,
      requirement: extra.requirement,
      json,
      body: text.slice(0, 8192),
    };
  }

  /**
   * Probe a domain for x402 paid resources via the common manifest endpoints.
   * Never throws — unresponsive endpoints are reported in errors[].
   */
  async discover(domain: string): Promise<X402DiscoverResult> {
    // Accept a bare domain ("api.example.com") or a full origin
    // ("http://127.0.0.1:8787") — bare domains default to https.
    const explicit = /^(https?:\/\/)/i.test(domain);
    const host = domain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    const base = explicit ? `${domain.match(/^(https?:\/\/)/i)![1]}${host}` : `https://${host}`;
    const endpoints = [
      { path: '/.well-known/x402', url: `${base}/.well-known/x402` },
      { path: '/api/x402/manifest', url: `${base}/api/x402/manifest` },
    ];
    const errors: string[] = [];
    const results = await Promise.all(endpoints.map(async (ep) => {
      try {
        const res = await globalThis.fetch(ep.url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
        });
        if (!res.ok) return { ep, json: null as unknown, status: res.status };
        return { ep, json: (await res.json()) as unknown, status: res.status };
      } catch (e: any) {
        return { ep, json: null as unknown, status: 0, err: e?.message ?? String(e) };
      }
    }));
    for (const r of results) {
      if (r.json === null || r.json === undefined) {
        errors.push(`${r.ep.path}: ${r.err ?? `HTTP ${r.status}`}`);
        continue;
      }
      const resources = resourcesFromManifest(r.json, base);
      if (resources.length) {
        return { ok: true, domain: host, source: r.ep.url, resources, errors };
      }
      errors.push(`${r.ep.path}: responded but no resources found`);
    }
    return { ok: false, domain: host, source: null, resources: [], errors };
  }

  /** Settle an already-parsed x402 requirement (no HTTP round trip). */
  async settle(paymentRequired: X402PaymentRequired | X402Requirement, opts: { waitMs?: number } = {}): Promise<X402SettleResult> {
    const requirement = 'requirement' in paymentRequired && paymentRequired.requirement
      ? paymentRequired.requirement
      : paymentRequired as X402Requirement;
    if (!requirement?.payTo) {
      return { ok: false, stage: 'unsupported', error: 'no valid x402 requirement supplied' };
    }
    return settleX402(this.client, requirement, opts);
  }
}

// ---------------------------------------------------------------- discovery parsing

/**
 * Normalize a manifest into a resource list. Handles: a bare array,
 * { resources: [...] }, { accepts | services | endpoints: [...] }, and
 * single-requirement objects. Prices stay in asset base units unless they
 * parse as 6-decimal micro amounts (converted to USD for priceUsdg).
 */
function resourcesFromManifest(manifest: unknown, base: string): X402Resource[] {
  const collect = (raw: unknown): X402Resource | null => {
    const c = raw as Record<string, any>;
    if (!c || typeof c !== 'object') return null;
    const payTo = typeof c.payTo === 'string' && isAddress(c.payTo) ? c.payTo : undefined;
    const url = typeof c.url === 'string' ? c.url : typeof c.resource === 'string' ? c.resource : undefined;
    if (!url && !payTo) return null;
    const amount = c.maxAmountRequired ?? c.amount ?? c.price ?? c.priceUsdg ?? c.amount_usdg;
    const amountStr = typeof amount === 'string' || typeof amount === 'number' ? String(amount) : undefined;
    let priceUsdg: string | undefined;
    if (amountStr !== undefined) {
      const n = Number.parseFloat(amountStr);
      if (Number.isFinite(n) && n > 0) {
        // Unit convention: explicit *_usdg keys and decimal strings ("0.01")
        // are USD. Bare integers (x402 maxAmountRequired style) are asset base
        // units (6 dec) when large enough to be implausible as whole dollars.
        const isUsdKey = c.priceUsdg !== undefined || c.amount_usdg !== undefined;
        const micro = !isUsdKey && !amountStr.includes('.') && n >= 1000;
        const usd = micro ? n / 1e6 : n;
        priceUsdg = usd.toFixed(6).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
      }
    }
    return {
      url: url && /^https?:\/\//i.test(url) ? url : url ? `${base}${url.startsWith('/') ? '' : '/'}${url}` : base,
      priceUsdg,
      maxAmountRequired: amountStr,
      payTo,
      description: typeof c.description === 'string' ? c.description : undefined,
      mimeType: typeof c.mimeType === 'string' ? c.mimeType : undefined,
      network: typeof c.network === 'string' ? c.network : undefined,
    };
  };
  if (Array.isArray(manifest)) return manifest.map(collect).filter((r): r is X402Resource => r !== null);
  if (!manifest || typeof manifest !== 'object') return [];
  const obj = manifest as Record<string, unknown>;
  for (const key of ['resources', 'accepts', 'services', 'endpoints', 'items']) {
    if (Array.isArray(obj[key])) {
      return (obj[key] as unknown[]).map(collect).filter((r): r is X402Resource => r !== null);
    }
  }
  const single = collect(obj);
  return single ? [single] : [];
}

// (helpers live in chain.ts / policy.ts — nothing further to re-export)
