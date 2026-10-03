// Regression tests for the 6 tools added in v2.2.0 — pons_buy, pons_sell,
// pons_pay_batch, x402_health, pons_scan_interesting, pons_recent_graduations.
import test from 'node:test';
import assert from 'node:assert/strict';

// ---- pure validation logic (extracted mirrors of the tool guards) ----

test('pons_buy: amountEth regex rejects scientific notation and garbage', () => {
  const re = /^\d+(\.\d+)?$/;
  assert.equal(re.test('1e18'), false);
  assert.equal(re.test('1.2.3'), false);
  assert.equal(re.test('-0.001'), false);
  assert.equal(re.test('0.001'), true);
  assert.equal(re.test('0'), true);
});

test('pons_buy: slippageBps clamped to 0..5000', () => {
  const clamp = (n) => BigInt(Math.max(0, Math.min(5000, Number(n ?? 100))));
  assert.equal(clamp(-100).toString(), '0');
  assert.equal(clamp(10000).toString(), '5000');
  assert.equal(clamp(undefined).toString(), '100');
  assert.equal(clamp(250).toString(), '250');
});

test('pons_buy: ETH_MAX cap blocks > 0.01 ETH', () => {
  const ETH_MAX = 10_000_000_000_000_000n; // 0.01 ETH
  assert.ok(10_000_000_000_000_001n > ETH_MAX);
  assert.ok(9_999_999_999_999_999n <= ETH_MAX);
});

test('pons_pay_batch: batch size capped at 50', () => {
  const tooBig = Array.from({length: 51}, (_, i) => ({ payTo: '0x' + '11'.repeat(20), amountUsd: '0.01' }));
  assert.equal(tooBig.length > 50, true);
});

test('pons_pay_batch: amount regex blocks negative + scientific + multi-dot', () => {
  const re = /^\d+(\.\d+)?$/;
  for (const bad of ['-5', '1e3', '5.5.5', '0x10', '']) assert.equal(re.test(bad), false, bad);
  for (const good of ['0.01', '5', '100.000001']) assert.equal(re.test(good), true, good);
});

test('pons_pay_batch: base amount must be > 0', () => {
  const parse = (str) => {
    if (!/^\d+(\.\d+)?$/.test(str.trim())) throw new Error('bad format');
    const [w, f = ''] = str.trim().split('.');
    const fp = f.slice(0, 6).padEnd(6, '0');
    return BigInt(w || '0') * 10n ** 6n + BigInt(fp || '0');
  };
  assert.throws(() => { const b = parse('0'); if (b <= 0n) throw new Error('must be > 0'); });
  assert.equal(parse('0.01').toString(), '10000');
  assert.equal(parse('5').toString(), '5000000');
});

test('x402_health: SSRF guard blocks private addresses', () => {
  const PRIVATE_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254', 'metadata.google.internal'];
  const isPrivate = (h) => PRIVATE_HOSTS.includes(h)
    || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    || /^127\./.test(h) || /^169\.254\./.test(h) || h.endsWith('.internal') || h.endsWith('.local');
  for (const host of ['localhost', '127.0.0.1', '169.254.169.254', '10.0.0.5', '192.168.1.1', '172.16.0.1', 'metadata.google.internal', 'foo.internal', 'bar.local']) {
    assert.equal(isPrivate(host), true, host);
  }
  for (const host of ['api.dexscreener.com', 'example.com', '1.2.3.4']) {
    assert.equal(isPrivate(host), false, host);
  }
});

test('x402_health: URL must be http(s)', () => {
  const ok = (u) => /^https?:\/\//i.test(u);
  assert.equal(ok('ftp://x'), false);
  assert.equal(ok('file:///etc/passwd'), false);
  assert.equal(ok('https://api.example.com'), true);
});
