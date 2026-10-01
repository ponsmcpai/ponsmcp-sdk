// pons v2 curve quoting math (pure functions).
// Math shapes adapted from the public dexorynlabs/robinhood-pons-bundler-bot
// research build (read-permitted license for factory indexing and curve study)
// and the official pons v2 docs. Zero-dependency port: no viem.
//
// READ-ONLY: pure math over reserves + fee inputs. PonsMCP never launches, snipes,
// or builds launchAndBuy transactions.

export const BPS = 10_000n;

export const ceilDiv = (a: bigint, b: bigint): bigint => {
  if (b === 0n) throw new Error('division by zero');
  return (a + b - 1n) / b;
};

export const amountOut = (inAmount: bigint, reserveIn: bigint, reserveOut: bigint): bigint => {
  if (inAmount <= 0n) return 0n;
  return (inAmount * reserveOut) / (reserveIn + inAmount);
};

export const amountIn = (outAmount: bigint, reserveIn: bigint, reserveOut: bigint): bigint => {
  if (outAmount <= 0n) return 0n;
  if (outAmount >= reserveOut) throw new Error('output exceeds reserve');
  return (outAmount * reserveIn) / (reserveOut - outAmount) + 1n;
};

export interface BuyQuoteInput {
  quoteIn: bigint;
  quoteReserve: bigint;
  tokenReserve: bigint;
  sellable: bigint;
  feeBps: bigint;
  creatorTaxBps: bigint;
  rawSnipeBps: bigint;
}

export interface BuyQuote {
  tokensOut: bigint;
  spent: bigint;
  refund: bigint;
  fee: bigint;
  tax: bigint;
  snipeTax: bigint;
  snipeBps: bigint;
}

/** Official buy quote. Snipe tax is capped so the buyer always nets at least 1% of spend. */
export function quoteBuyPure(input: BuyQuoteInput): BuyQuote {
  let snipeBps = input.rawSnipeBps;
  if (snipeBps > 0n) {
    const maxSnipeBps = BPS - input.feeBps - input.creatorTaxBps - 100n;
    if (snipeBps > maxSnipeBps) snipeBps = maxSnipeBps < 0n ? 0n : maxSnipeBps;
  }
  const fee = ceilDiv(input.quoteIn * input.feeBps, BPS);
  const tax = ceilDiv(input.quoteIn * input.creatorTaxBps, BPS);
  const snipeTax = ceilDiv(input.quoteIn * snipeBps, BPS);
  const spent = input.quoteIn - fee - tax - snipeTax;
  if (spent <= 0n) {
    return { tokensOut: 0n, spent: 0n, refund: input.quoteIn, fee, tax, snipeTax, snipeBps };
  }
  const tokensOut = amountOut(spent, input.quoteReserve, input.tokenReserve);
  const clamped = tokensOut > input.sellable;
  const sellable = clamped ? input.sellable : tokensOut;
  // A clamped fill is charged only for the tokens actually received: refund is the
  // spend that produced no tokens (per pons docs the curve refunds the remainder).
  const refund = clamped ? input.quoteIn - fee - tax - snipeTax : 0n;
  return { tokensOut: sellable, spent: clamped ? 0n : spent, refund, fee, tax, snipeTax, snipeBps };
}

/** Official sell quote (curve side). */
export function quoteSellPure(input: {
  tokensIn: bigint;
  quoteReserve: bigint;
  tokenReserve: bigint;
  feeBps: bigint;
  creatorTaxBps: bigint;
}): { quoteOut: bigint; fee: bigint; tax: bigint; netQuote: bigint } {
  if (input.tokensIn <= 0n) return { quoteOut: 0n, fee: 0n, tax: 0n, netQuote: 0n };
  const gross = amountOut(input.tokensIn, input.tokenReserve, input.quoteReserve);
  const fee = ceilDiv(gross * input.feeBps, BPS);
  const tax = ceilDiv(gross * input.creatorTaxBps, BPS);
  const net = gross - fee - tax;
  return { quoteOut: gross, fee, tax, netQuote: net > 0n ? net : 0n };
}
