#!/usr/bin/env node
// Serial test runner — one call at a time, wait for response, then next.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const ALCHEMY = 'alch_wXyV1PsUL90Ki4-BYN1WP';

const tests = [
  { name: 'pons_chain_info',         args: {} },
  { name: 'pons_price',               args: {} },
  { name: 'pons_stocks_list',          args: {} },
  { name: 'pons_stock_price',          args: { ticker: 'NVDA' } },
  { name: 'pons_stock_info',           args: { ticker: 'AAPL' } },
  { name: 'pons_quote',               args: { amountUsd: '5.00' } },
  { name: 'pons_token_info',           args: { token: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' } },
  { name: 'pons_launch_feed',          args: { limit: 3 } },
  { name: 'pons_launch_ranking',        args: { limit: 10, sortBy: 'graduation' } },
  { name: 'pons_graduated_launches',    args: { limit: 15 } },
  { name: 'pons_launch_info',           args: { token: '0x5f15B22c89B283d815CA5544eb29F333112Ad767' } },
  { name: 'pons_launch_market',         args: { token: '0x5f15B22c89B283d815CA5544eb29F333112Ad767' } },
  { name: 'pons_v2_launch',             args: { token: '0x39dBED3a2bd333467115dE45665cC57F813C4571' } },
  { name: 'pons_v2_quote_buy',          args: { quoteIn:'100000000000000000', quoteReserve:'1000000000000000000', tokenReserve:'1000000000000000000000000000', sellable:'1000000000000000000000000000', feeBps:'100', creatorTaxBps:'0', rawSnipeBps:'0' } },
  { name: 'pons_v2_quote_sell',         args: { tokensIn:'1000000000000000000', quoteReserve:'1000000000000000000', tokenReserve:'1000000000000000000000000000', feeBps:'100', creatorTaxBps:'0' } },
  { name: 'pons_escrow_balance',        args: { recipient: '0x46e72932a8106e25a0fb98e2eb4d79293c4276bb' } },
  { name: 'pons_escrow_token_balance',  args: { recipient: '0x46e72932a8106e25a0fb98e2eb4d79293c4276bb', token: '0x39dBED3a2bd333467115dE45665cC57F813C4571' } },
  { name: 'pons_tx_status',             args: { txHash: '0x1ea14450438f4e16bbf2ef32cd882328bb441a61cb450656d39bae603800f833' } },
  // Expect clean errors:
  { name: 'pons_stock_price',           args: { ticker: 'FAKEXYZ' }, expectError: true },
  { name: 'pons_balance',               args: {}, expectError: true },
  { name: 'pons_send_token',            args: { to: '0x82Ff4dD9eD21933C0e4eFbA0cC1cD0A1a5C75330', token: 'USDG', amount: '0.001' }, expectError: true },
  { name: 'pons_send_eth',              args: { to: '0x82Ff4dD9eD21933C0e4eFbA0cC1cD0A1a5C75330', amountEth: '0.0001' }, expectError: true },
  // Stocks screen with filter (slower)
  { name: 'pons_stocks_screen',         args: { minLiquidityUsd: 500000 } },
];

const proc = spawn('node', ['dist/mcp.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PONSMCP_ALCHEMY_KEY: ALCHEMY },
  stdio: ['pipe', 'pipe', 'inherit'],
});

// Pending response map
let pendingResolve = null;
const rl = createInterface({ input: proc.stdout });
rl.on('line', line => {
  try {
    const msg = JSON.parse(line.trim());
    if (msg.id !== undefined && pendingResolve) {
      const r = pendingResolve; pendingResolve = null; r(msg);
    }
  } catch {}
});

async function call(id, name, args) {
  const p = new Promise(r => { pendingResolve = r; });
  proc.stdin.write(JSON.stringify({ jsonrpc:'2.0', id, method:'tools/call', params:{ name, arguments:args }}) + '\n');
  return Promise.race([p, new Promise((_,rej) => setTimeout(() => rej(new Error('timeout 15s')), 15000))]);
}

// Init
const initP = new Promise(r => { pendingResolve = r; });
proc.stdin.write(JSON.stringify({ jsonrpc:'2.0', id:0, method:'initialize', params:{ protocolVersion:'2024-11-05' }}) + '\n');
await Promise.race([initP, new Promise((_,rej) => setTimeout(()=>rej(new Error('init timeout')),5000))]);

const pad = (s, n) => String(s).padEnd(n);
console.log('\n' + '─'.repeat(95));
console.log(pad('#', 4) + pad('Tool', 32) + pad('Status', 11) + pad('ms', 7) + 'Sample / Error');
console.log('─'.repeat(95));

let pass=0, fail=0;
for (let i=0; i<tests.length; i++) {
  const t = tests[i];
  const t0 = Date.now();
  let r, ms;
  try {
    r = await call(i+1, t.name, t.args);
    ms = Date.now()-t0;
  } catch(e) {
    ms = Date.now()-t0;
    const status = t.expectError ? 'PASS(err)' : 'FAIL';
    if (t.expectError) pass++; else fail++;
    console.log(pad(i+1,4)+pad(t.name,32)+pad(status,11)+pad(ms+'ms',7)+e.message.slice(0,48));
    continue;
  }
  const isError = !!r.error;
  const expected = t.expectError ?? false;
  const ok = expected ? isError : !isError;
  const status = ok ? (expected ? 'PASS(err)' : 'PASS') : 'FAIL';
  if (ok) pass++; else fail++;
  const sample = isError
    ? (r.error.message ?? '').slice(0,50)
    : (() => {
        try { const d=JSON.parse(r.result.content[0].text); const k=Object.keys(d)[0]; return `${k}=${JSON.stringify(d[k]).slice(0,45)}`; } catch { return '(ok)'; }
      })();
  console.log(pad(i+1,4)+pad(t.name,32)+pad(status,11)+pad(ms+'ms',7)+sample);
}
console.log('─'.repeat(95));
console.log(`PASS: ${pass}  FAIL: ${fail}  Total: ${pass+fail}`);
proc.stdin.end();
process.exit(fail>0?1:0);
