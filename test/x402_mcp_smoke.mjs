// MCP-level smoke for the x402 tools: handshake, tools/list count, and live
// calls to x402_fetch / x402_discover against the local mock x402 server.
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
};
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
const REQ = {
  x402Version: 1, scheme: 'exact', network: 'robinhood-chain',
  description: 'smoke paid resource', mimeType: 'application/json',
  maxAmountRequired: '1000', payTo: '0x46E72932a8106E25A0Fb98E2Eb4D79293C4276bb',
};

const server = createServer((req, res) => {
  const send = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
  if (req.url === '/premium') {
    if (req.headers['x-payment']) send(200, { unlocked: true });
    else send(402, {}, { 'X-PAYMENT': b64({ ...REQ, resource: '/premium' }) });
    return;
  }
  if (req.url === '/.well-known/x402') {
    send(200, { resources: [{ url: '/premium', maxAmountRequired: '1000', payTo: REQ.payTo, description: 'premium content' }] });
    return;
  }
  send(404, {});
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${server.address().port}`;

const proc = spawn('node', ['dist/mcp.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
const results = new Map();
createInterface({ input: proc.stdout }).on('line', (line) => {
  try { const m = JSON.parse(line); if (m.id !== undefined) results.set(m.id, m); } catch {}
});
const call = (id, method, params) => new Promise((resolve) => {
  results.delete(id);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (results.has(id)) { clearInterval(iv); resolve(results.get(id)); }
    else if (Date.now() - t0 > 20000) { clearInterval(iv); resolve(null); }
  }, 50);
});

await call(1, 'initialize', { protocolVersion: '2024-11-05' });
const init = results.get(1);
check('initialize reports version 2.1.0', init?.result?.serverInfo?.version === '2.1.0', JSON.stringify(init?.result?.serverInfo));

const list = await call(2, 'tools/list', {});
const names = (list?.result?.tools ?? []).map((t) => t.name);
check('tools/list exposes 27 tools', names.length === 27, `got ${names.length}`);
check('x402_fetch listed', names.includes('x402_fetch'));
check('x402_discover listed', names.includes('x402_discover'));

const d = await call(3, 'tools/call', { name: 'x402_discover', arguments: { domain: B } });
const dParsed = JSON.parse(d?.result?.content?.[0]?.text ?? '{}');
check('x402_discover finds /premium', dParsed.ok === true && dParsed.resources?.[0]?.url === `${B}/premium`, d?.result?.content?.[0]?.text?.slice(0, 200));
check('discover price 1000 micro → 0.001 USD', dParsed.resources?.[0]?.priceUsdg === '0.001');

const f = await call(4, 'tools/call', { name: 'x402_fetch', arguments: { url: `${B}/premium` } });
const fParsed = JSON.parse(f?.result?.content?.[0]?.text ?? '{}');
check('x402_fetch stops cleanly at policy (no key configured)', fParsed.ok === false && fParsed.still402 === true && /no wallet/.test(fParsed.error ?? ''), f?.result?.content?.[0]?.text?.slice(0, 300));

const bad = await call(5, 'tools/call', { name: 'x402_fetch', arguments: { url: 'ftp://nope' } });
check('invalid URL errors cleanly', bad?.error?.message?.includes('invalid URL'), JSON.stringify(bad?.error));

const badDom = await call(6, 'tools/call', { name: 'x402_discover', arguments: { domain: 'not a domain' } });
check('invalid domain errors cleanly', badDom?.error?.message?.includes('invalid domain'), JSON.stringify(badDom?.error));

proc.kill();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
