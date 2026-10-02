// Robinhood Chain 4663 — stock token registry (19 verified on-chain).
// Verified: symbol() / name() / totalSupply() confirmed via eth_call 2026-09-08.
// These are tokenized debt securities issued by Robinhood (name suffix "• Robinhood Token"),
// NOT equity shares. Prices reflect DEX pair data, not official NAV.

export const STOCK_TOKENS: Record<string, string> = {
  AAPL: '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9',
  AMD:  '0x86923f96303d656e4aa86d9d42d1e57ad2023fdc',
  AMZN: '0x12f190a9f9d7d37a250758b26824b97ce941bf54',
  BE:   '0x822cc93ffd030293e9842c30bbd678f530701867',
  COIN: '0x6330d8c3178a418788df01a47479c0ce7ccf450b',
  CRWV: '0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3',
  GOOGL:'0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3',
  INTC: '0xc72b96e0e48ecd4dc75e1e45396e26300bc39681',
  META: '0xc0d6457c16cc70d6790dd43521c899c87ce02f35',
  MSFT: '0xe93237c50d904957cf27e7b1133b510c669c2e74',
  MU:   '0xff080c8ce2e5feadaca0da81314ae59d232d4afd',
  NFLX: '0xe0444ef8bf4ed74f74fd73686e2ddf4c1c5591e8',
  NVDA: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
  ORCL: '0xb0992820e760d836549ba69bc7598b4af75dee03',
  PLTR: '0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a',
  SNDK: '0xb90a19ff0af67f7779aff50a882a9cff42446400',
  SPCX: '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea',
  TSLA: '0x322f0929c4625ed5bad873c95208d54e1c003b2d',
  USAR: '0xd917b029c761d264c6a312bbbcda868658ef86a6',
};

export const STOCK_BY_ADDRESS: Record<string, string> = Object.fromEntries(
  Object.entries(STOCK_TOKENS).map(([s, a]) => [a.toLowerCase(), s])
);

export function resolveStock(tickerOrAddress: string): { symbol: string; address: string } | null {
  if (!tickerOrAddress) return null;
  const upper = tickerOrAddress.toUpperCase().trim();
  if (STOCK_TOKENS[upper]) return { symbol: upper, address: STOCK_TOKENS[upper] };
  const addr = tickerOrAddress.toLowerCase().trim();
  const sym = STOCK_BY_ADDRESS[addr];
  if (sym) return { symbol: sym, address: addr };
  return null;
}

/** Filter criteria mirroring the notifier.py logic:
 *  Grade A = signal contains [A] + $ in first 4 lines (strict).
 *  Applied here to pons launches as a screening layer:
 *  - has active DEX pairs (liq > 0)
 *  - graduation progress ≥ threshold
 *  - 24h change within bounds
 */
export function isGradeA(item: {
  liquidityUsd: number;
  graduationPct: number;
  change24h: number | null;
}): boolean {
  return (
    item.liquidityUsd > 500 &&
    item.graduationPct > 5 &&
    (item.change24h === null || item.change24h > -50)
  );
}

export function isEarlyWatch(item: {
  liquidityUsd: number;
  graduationPct: number;
}): boolean {
  return item.liquidityUsd > 0 && item.graduationPct < 10;
}
