// Unit tests — chain, erc20, curve, stocks modules.
import test from 'node:test';
import assert from 'node:assert/strict';

// ── chain ────────────────────────────────────────────────────────────────
test('chain: hexToBigInt handles empty and zero', async () => {
  const { hexToBigInt } = await import('../../dist/chain.js');
  assert.equal(hexToBigInt('0x'), 0n);
  assert.equal(hexToBigInt(''), 0n);
  assert.equal(hexToBigInt('0x0'), 0n);
  assert.equal(hexToBigInt('0x10'), 16n);
});

test('chain: unitToString formats decimals correctly', async () => {
  const { unitToString } = await import('../../dist/chain.js');
  assert.equal(unitToString(1_000_000n, 6), '1');
  assert.equal(unitToString(1_500_000n, 6), '1.5');
  assert.equal(unitToString(1_234_567n, 6), '1.234567');
  assert.equal(unitToString(0n, 18), '0');
  assert.equal(unitToString(10n ** 18n, 18), '1');
});

test('chain: usdToMicro converts USD to base units', async () => {
  const { usdToMicro } = await import('../../dist/chain.js');
  assert.equal(usdToMicro('5.00'), 5_000_000n);
  assert.equal(usdToMicro('0.01'), 10_000n);
  assert.equal(usdToMicro(5), 5_000_000n);
  assert.throws(() => usdToMicro('-1'));
  assert.throws(() => usdToMicro('abc'));
});

test('chain: isAddress validates EVM addresses', async () => {
  const { isAddress } = await import('../../dist/chain.js');
  assert.equal(isAddress('0x82Ff4dD9eD21933C0e4eFbA0cC1cD0A1a5C75330'), true);
  assert.equal(isAddress('0xSHORT'), false);
  assert.equal(isAddress('not-an-address'), false);
  assert.equal(isAddress(''), false);
});

test('chain: erc20TransferData encodes correctly', async () => {
  const { erc20TransferData } = await import('../../dist/chain.js');
  const data = erc20TransferData('0x82Ff4dD9eD21933C0e4eFbA0cC1cD0A1a5C75330', 1_000_000n);
  assert.equal(data.startsWith('0xa9059cbb'), true); // transfer selector
  assert.equal(data.length, 2 + 8 + 64 + 64); // 0x + selector + 2 words
});

// ── erc20 ────────────────────────────────────────────────────────────────
test('erc20: decodeAbiString handles standard layout', async () => {
  const { decodeAbiString } = await import('../../dist/chain.js');
  // name() "Pons MCP" encoded
  const encoded = '0x' + '0'.repeat(64) + Buffer.from('Pons MCP').length.toString(16).padStart(64, '0') + Buffer.from('Pons MCP').toString('hex').padEnd(64, '0');
  assert.equal(decodeAbiString(encoded), 'Pons MCP');
});

test('erc20: decodeAbiString handles short/invalid input gracefully', async () => {
  const { decodeAbiString } = await import('../../dist/chain.js');
  assert.equal(decodeAbiString('0x'), '');
  assert.equal(decodeAbiString('0x1234'), '');
});

// ── stocks ───────────────────────────────────────────────────────────────
test('stocks: all 19 addresses are valid hex', async () => {
  const { STOCK_TOKENS } = await import('../../dist/stocks.js');
  const tickers = Object.keys(STOCK_TOKENS);
  assert.equal(tickers.length, 19);
  for (const [sym, addr] of Object.entries(STOCK_TOKENS)) {
    assert.match(addr, /^0x[0-9a-fA-F]{40}$/, `${sym} address invalid`);
  }
});

test('stocks: resolveStock is case-insensitive', async () => {
  const { resolveStock } = await import('../../dist/stocks.js');
  assert.equal(resolveStock('nvda')?.symbol, 'NVDA');
  assert.equal(resolveStock('NVDA')?.symbol, 'NVDA');
  assert.equal(resolveStock('NvDa')?.symbol, 'NVDA');
  assert.equal(resolveStock('FAKEXYZ'), null);
  assert.equal(resolveStock('')?.symbol, undefined);
});

test('stocks: resolveStock accepts addresses too', async () => {
  const { resolveStock } = await import('../../dist/stocks.js');
  const r = resolveStock('0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec'); // NVDA
  assert.equal(r?.symbol, 'NVDA');
});

// ── curve ────────────────────────────────────────────────────────────────
test('curve: quoteBuyPure returns positive tokens out', async () => {
  const { quoteBuyPure } = await import('../../dist/curve.js');
  const q = quoteBuyPure({
    quoteIn: 100_000_000_000_000_000n, // 0.1 ETH
    quoteReserve: 1_000_000_000_000_000_000n,
    tokenReserve: 1_000_000_000_000_000_000_000_000_000n,
    sellable: 1_000_000_000_000_000_000_000_000_000n,
    feeBps: 100n, creatorTaxBps: 0n, rawSnipeBps: 0n,
  });
  assert.ok(q.tokensOut > 0n);
});

test('curve: larger buy in yields more tokens out (monotonic)', async () => {
  const { quoteBuyPure } = await import('../../dist/curve.js');
  const base = {
    quoteReserve: 1_000_000_000_000_000_000n,
    tokenReserve: 1_000_000_000_000_000_000_000_000_000n,
    sellable: 1_000_000_000_000_000_000_000_000_000n,
    feeBps: 100n, creatorTaxBps: 0n, rawSnipeBps: 0n,
  };
  const small = quoteBuyPure({ ...base, quoteIn: 10n ** 17n });
  const large = quoteBuyPure({ ...base, quoteIn: 2n * 10n ** 17n });
  assert.ok(large.tokensOut > small.tokensOut);
});

test('curve: zero input yields zero output (no negative)', async () => {
  const { quoteSellPure } = await import('../../dist/curve.js');
  const q = quoteSellPure({
    tokensIn: 0n,
    quoteReserve: 1_000_000_000_000_000_000n,
    tokenReserve: 1_000_000_000_000_000_000_000_000_000n,
    feeBps: 100n, creatorTaxBps: 0n,
  });
  assert.ok(q.quoteOut >= 0n);
});
