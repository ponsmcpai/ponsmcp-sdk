#!/usr/bin/env node
// Full test runner for all 25 PonsMCP tools.
// Reports: name | status | latency | sample output or error

import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

const ALCHEMY = process.env.PONSMCP_ALCHEMY_KEY ?? 'alch_wXyV1PsUL90Ki4-BYN1WP';

const tests = [
  // Read-only, no key
  { id: 1,  name: 'pons_chain_info',         args: {} },
  { id: 2,  name: 'pons_price',               args: {} },
  { id: 3,  name: 'pons_stocks_list',          args: {} },
  { id: 4,  name: 'pons_stock_price',          args: { ticker: 'NVDA' } },
  { id: 5,  name: 'pons_stock_price',          args: { ticker: 'TSLA' } },
  { id: 6,  name: 'pons_stock_info',           args: { ticker: 'AAPL' } },
  { id: 7,  name: 'pons_quote',               args: { amountUsd: '5.00' } },
  { id: 8,  name: 'pons_token_info',           args: { token: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' } },
  { id: 9,  name: 'pons_launch_feed',          args: { limit: 5 } },
  { id: 10, name: 'pons_launch_ranking',        args: { limit: 10, sortBy: 'graduation' } },
  { id: 11, name: 'pons_graduated_launches',    args: { limit: 20 } },
  { id: 12, name: 'pons_launch_info',           args: { token: '0x39dBED3a2bd333467115dE45665cC57F813C4571' } },
  { id: 13, name: 'pons_launch_market',         args: { token: '0x39dBED3a2bd333467115dE45665cC57F813C4571' } },
  { id: 14, name: 'pons_v2_launch',             args: { token: '0x39dBED3a2bd333467115dE45665cC57F813C4571' } },
  { id: 15, name: 'pons_v2_snipe_tax',          args: { curve: '0x39dBED3a2bd333467115dE45665cC57F813C4571', recipient: '0x46e72932a8106e25a0fb98e2eb4d79293c4276bb' } },
  { id: 16, name: 'pons_v2_quote_buy',          args: { quoteIn:'100000000000000000', quoteReserve:'1000000000000000000', tokenReserve:'1000000000000000000000000000', sellable:'1000000000000000000000000000', feeBps:'100', creatorTaxBps:'0', rawSnipeBps:'0' } },
  { id: 17, name: 'pons_v2_quote_sell',         args: { tokensIn:'1000000000000000000', quoteReserve:'1000000000000000000', tokenReserve:'1000000000000000000000000000', feeBps:'100', creatorTaxBps:'0' } },
  { id: 18, name: 'pons_escrow_balance',        args: { recipient: '0x46e72932a8106e25a0fb98e2eb4d79293c4276bb' } },
  { id: 19, name: 'pons_escrow_token_balance',  args: { recipient: '0x46e72932a8106e25a0fb98e2eb4d79293c4276bb', token: '0x39dBED3a2bd333467115dE45665cC57F813C4571' } },
  { id: 20, name: 'pons_tx_status',             args: { txHash: '0x1ea14450438f4e16bbf2ef32cd882328bb441a61cb450656d39bae603800f833' } },
  // Error handling — should fail cleanly, not crash
  { id: 21, name: 'pons_stock_price',           args: { ticker: 'FAKEXYZ' }, expectError: true },
  { id: 22, name: 'pons_send_token',            args: { to: '0x82Ff4dD9eD21933C0e4eFbA0cC1cD0A1a5C75330', token: 'USDG', amount: '0.001' }, expectError: true }, // no key
  { id: 23, name: 'pons_send_eth',              args: { to: '0x82Ff4dD9eD21933C0e4eFbA0cC1cD0A1a5C75330', amountEth: '0.0001' }, expectError: true }, // no key
  // stocks_screen is slow, do a quick one
  { id: 24, name: 'pons_stocks_screen',         args: { minLiquidityUsd: 1000000 } },
  // balance without key — should report clearly
  { id: 25, name: 'pons_balance',               args: {} },
];

const proc = spawn('node', ['dist/mcp.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PONSMCP_ALCHEMY_KEY: ALCHEMY },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const results = new Map();
const rl = createInterface({ input: proc.stdout });
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id) results.set(msg.id, msg);
  } catch {}
});

// Initialize
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');

// Send all tests sequentially with timestamps
const timestamps = new Map();
for (const t of tests) {
  timestamps.set(t.id, Date.now());
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: t.id, method: 'tools/call', params: { name: t.name, arguments: t.args } }) + '\n');
}

// Wait for all responses (max 45s)
await new Promise(r => setTimeout(r, 45_000));
proc.stdin.end();

// Print results
const pad = (s, n) => String(s).padEnd(n);
console.log('\n' + '─'.repeat(90));
console.log(pad('#', 4) + pad('Tool', 30) + pad('Status', 10) + pad('ms', 8) + 'Sample / Error');
console.log('─'.repeat(90));

let pass = 0, fail = 0, missing = 0;
for (const t of tests) {
  const r = results.get(t.id);
  const ms = r ? Date.now() - timestamps.get(t.id) : null; // approx
  if (!r) {
    console.log(pad(t.id, 4) + pad(t.name, 30) + pad('MISSING', 10) + pad('—', 8) + 'no response (timeout)');
    missing++;
    continue;
  }
  const isError = !!r.error;
  const expected = t.expectError ?? false;
  const ok = expected ? isError : !isError;
  const status = ok ? (expected ? 'PASS(err)' : 'PASS') : 'FAIL';
  if (ok) pass++; else fail++;
  const sample = isError
    ? (r.error.message ?? '').slice(0, 50)
    : (() => {
        try {
          const data = JSON.parse(r.result.content[0].text);
          const keys = Object.keys(data);
          const v = data[keys[0]];
          return `${keys[0]}=${JSON.stringify(v).slice(0, 45)}`;
        } catch { return '(ok)'; }
      })();
  const latency = timestamps.has(t.id) ? String(Date.now() - timestamps.get(t.id)) : '?';
  console.log(pad(t.id, 4) + pad(t.name, 30) + pad(status, 10) + pad(latency + 'ms', 8) + sample);
}
console.log('─'.repeat(90));
console.log(`Total: ${pass + fail + missing} | PASS: ${pass} | FAIL: ${fail} | MISSING: ${missing}`);
process.exit(fail + missing > 0 ? 1 : 0);
