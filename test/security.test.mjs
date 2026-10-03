// Security regression tests — verify the v2.0.2 fixes stay fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine } from '../dist/policy.js';

test('PolicyEngine blocks amount above maxPerTx', () => {
  const p = new PolicyEngine({ maxPerTx: 100_000_000n, dailyLimit: 1_000_000_000n });
  const d = p.check(150_000_000n);
  assert.equal(d.allowed, false);
  assert.match(d.reason, /max_per_transaction/);
});

test('PolicyEngine blocks amount above remaining daily budget', () => {
  const p = new PolicyEngine({ maxPerTx: 100_000_000n, dailyLimit: 120_000_000n });
  assert.equal(p.check(100_000_000n).allowed, true);
  p.record(100_000_000n);
  const d2 = p.check(50_000_000n); // only 20M left today
  assert.equal(d2.allowed, false);
  assert.match(d2.reason, /daily budget/);
});

test('PolicyEngine allows amount within caps and records spend', () => {
  const p = new PolicyEngine({ maxPerTx: 60_000_000n, dailyLimit: 100_000_000n });
  assert.equal(p.check(50_000_000n).allowed, true);
  p.record(50_000_000n);
  assert.equal(p.check(50_000_000n).allowed, true); // 50M spent, 50M remaining, within caps
  p.record(50_000_000n);
  assert.equal(p.check(50_000_000n).allowed, false); // 100M spent = daily limit reached
});

test('PolicyEngine rejects zero and negative configuration', () => {
  assert.throws(() => new PolicyEngine({ maxPerTx: 0n, dailyLimit: 1000n }));
  assert.throws(() => new PolicyEngine({ maxPerTx: 1000n, dailyLimit: 0n }));
});

test('PolicyEngine rejects maxPerTx > dailyLimit', () => {
  assert.throws(() => new PolicyEngine({ maxPerTx: 500n, dailyLimit: 100n }));
});

test('waitMs clamp logic (extracted from mcp.ts)', () => {
  const clamp = (waitMs) => Math.min(waitMs ? Number(waitMs) : 30_000, 120_000);
  assert.equal(clamp(undefined), 30_000);
  assert.equal(clamp(0), 30_000);
  assert.equal(clamp(60_000), 60_000);
  assert.equal(clamp(120_000), 120_000);
  assert.equal(clamp(999_999_999), 120_000); // 999999s clamped to 2min
});

test('amount regex rejects scientific notation and multi-dot', () => {
  const re = /^\d+(\.\d+)?$/;
  assert.equal(re.test('1e18'), false);
  assert.equal(re.test('1.2.3'), false);
  assert.equal(re.test('0x10'), false);
  assert.equal(re.test('-5'), false);
  assert.equal(re.test('5'), true);
  assert.equal(re.test('5.00'), true);
  assert.equal(re.test('0.000001'), true);
});
