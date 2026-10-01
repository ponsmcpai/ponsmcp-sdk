// Live PONS market data via DexScreener (chainId: robinhood).
export interface PairInfo {
  dex: string;
  pairAddress: string;
  base: string;
  quote: string;
  priceUsd: number;
  liquidityUsd: number;
  change24h: number | null;
  url: string;
}

const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) ponsmcp-sdk/0.1' };

export async function tokenPairs(token: string): Promise<PairInfo[]> {
  const res = await fetch(
    `https://api.dexscreener.com/latest/dex/tokens/${token}`,
    { headers: UA }
  );
  if (!res.ok) throw new Error(`dexscreener HTTP ${res.status}`);
  const j = (await res.json()) as {
    pairs?: Array<Record<string, any>>;
  };
  return (j.pairs ?? [])
    .filter((p) => p.chainId === 'robinhood')
    .map((p) => ({
      dex: String(p.dexId ?? '?'),
      pairAddress: String(p.pairAddress ?? ''),
      base: String(p.baseToken?.symbol ?? '?'),
      quote: String(p.quoteToken?.symbol ?? '?'),
      priceUsd: Number.parseFloat(p.priceUsd ?? '0'),
      liquidityUsd: Number(p.liquidity?.usd ?? 0),
      change24h:
        p.priceChange?.h24 === undefined ? null : Number(p.priceChange.h24),
      url: p.url ?? `https://dexscreener.com/robinhood/${p.pairAddress ?? ''}`,
    }))
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}

/** Live markets for the PONS reference token. */
export function ponsPairs(): Promise<PairInfo[]> {
  return tokenPairs('0x39dBED3a2bd333467115dE45665cC57F813C4571');
}

/** Best (deepest) PONS pair snapshot. */
export async function ponsBest(): Promise<PairInfo | null> {
  const pairs = await ponsPairs();
  return pairs[0] ?? null;
}
