// Runtime verification for the x402 compatibility layer.
// Runs a local mock x402 server and exercises: parse402Response (header +
// body forms), pons_pay_resource on all three 402 shapes, X402Client.fetch
// happy path (settles → retries with X-PAYMENT), policy denial, and discover.
// No key configured → settlement must stop cleanly at policy stage.

import { createServer } from 'node:http';

import { PonsMCPClient } from '../dist/index.js';
import {
  X402Client,
  parse402Response,
  isX402Response,
  encodePaymentHeader,
} from '../dist/x402.js';
import { payForResource } from '../dist/resource.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}
const J = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');

const REQ = {
  x402Version: 1,
  scheme: 'exact',
  network: 'robinhood-chain',
  resource: '',
  description: 'mock paid resource',
  mimeType: 'application/json',
  maxAmountRequired: '2500', // micro → 0.0025 USD
  payTo: '0x46E72932a8106E25A0Fb98E2Eb4D79293C4276bb',
};

const server = createServer((req, res) => {
  const url = req.url ?? '/';
  const sendJson = (code, obj, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(obj));
  };
  if (url === '/paid-header') {
    if (req.headers['x-payment']) {
      // Echo the decoded proof so the test can assert on it.
      sendJson(200, { unlocked: true, proof: JSON.parse(Buffer.from(String(req.headers['x-payment']), 'base64').toString('utf8')) });
    } else {
      sendJson(402, { error: 'payment required' }, { 'X-PAYMENT': b64({ ...REQ, resource: url }) });
    }
    return;
  }
  if (url === '/paid-body') {
    if (req.headers['x-payment']) {
      sendJson(200, { unlocked: true });
    } else {
      sendJson(402, { x402Version: 1, error: 'payment required', accepts: [{ ...REQ, resource: url }] });
    }
    return;
  }
  if (url === '/native-402') {
    if (req.headers['x-payment']) {
      sendJson(200, { unlocked: true });
    } else {
      sendJson(402, { amount_usdg: '0.01', pay_to: '0x46E72932a8106E25A0fB98E2Eb4D79293C4276bb' });
    }
    return;
  }
  if (url === '/still-402') {
    sendJson(402, { error: 'payment required' }, { 'X-PAYMENT': b64({ ...REQ, resource: url }) });
    return;
  }
  if (url === '/plain') {
    sendJson(200, { hello: 'world' });
    return;
  }
  if (url === '/.well-known/x402') {
    sendJson(200, {
      resources: [
        { url: '/premium', maxAmountRequired: '2500000', payTo: '0x46E72932a8106E25A0Fb98E2Eb4D79293C4276bb', description: 'premium intel', mimeType: 'application/json' },
      ],
    });
    return;
  }
  if (url === '/api/x402/manifest') {
    sendJson(200, {
      services: [
        { url: '/api/v1/forecast', price: '0.05', payTo: '0x46E72932a8106E25A0Fb98E2Eb4D79293C4276bb', description: 'forecast api' },
      ],
    });
    return;
  }
  sendJson(404, { notFound: true });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const B = `http://127.0.0.1:${port}`;

// ---------------------------------------------------------------- parser
console.log('\n[1] parse402Response');
{
  const fake = { headers: new Headers({ 'x-payment': b64(REQ) }), status: 402 };
  const r = parse402Response(fake, undefined);
  check('header form parses', r.ok && r.requirement?.payTo === REQ.payTo && r.source === 'header');
  check('maxAmountRequired preserved', r.requirement?.maxAmountRequired === '2500');
  check('isX402Response true', isX402Response(fake, undefined));
}
{
  const fake = { headers: new Headers(), status: 402 };
  const body = { x402Version: 1, accepts: [REQ] };
  const r = parse402Response(fake, body);
  check('body accepts[] form parses', r.ok && r.requirement?.payTo === REQ.payTo && r.source === 'body');
  check('accepts carried through', r.accepts?.length === 1);
}
{
  const fake = { headers: new Headers(), status: 402 };
  check('native body not x402', !isX402Response(fake, { amount_usdg: '1', pay_to: '0x46E72932a8106E25A0Fb98E2Eb4D79293C4276bb' }));
  check('garbage header rejected cleanly', parse402Response({ headers: new Headers({ 'x-payment': '!!!' }) }, undefined).ok === false);
}

// ---------------------------------------------------------------- pay_resource on all shapes
console.log('\n[2] pons_pay_resource accepts x402 + native (no key → clean policy stop)');
{
  const client = new PonsMCPClient({});
  const a = await payForResource(client, `${B}/paid-header`);
  check('x402 header form detected', a.ok === false && a.x402 === true && a.stage === 'policy_denied' && /no wallet/.test(a.error ?? ''), J(a));
  check('price converted from micro', a.priceUsdg === '0.0025', `priceUsdg=${a.priceUsdg}`);
  const b2 = await payForResource(client, `${B}/paid-body`);
  check('x402 body form detected', b2.ok === false && b2.x402 === true && b2.stage === 'policy_denied', J(b2));
  const c = await payForResource(client, `${B}/native-402`);
  check('native form still works', c.ok === false && !c.x402 && c.stage === 'policy_denied', J(c));
}

// ---------------------------------------------------------------- X402Client.fetch
console.log('\n[3] X402Client.fetch');
{
  const client = new PonsMCPClient({});
  const x402 = new X402Client(client);
  const plain = await x402.fetch(`${B}/plain`);
  check('plain 200 passthrough', plain.ok && plain.status === 200 && plain.json?.hello === 'world' && !plain.paid);
  const r = await x402.fetch(`${B}/paid-header`);
  check('402 settles to clean policy stop (no key)', r.ok === false && r.still402 === true && r.paid === false && /no wallet/.test(r.error ?? ''), J(r));
  check('requirement surfaced', r.requirement?.payTo === REQ.payTo);
  const s = await x402.fetch(`${B}/still-402`);
  check('still-402 without key does not mark paid', s.ok === false && s.still402 === true && s.paid === false);
}

// ---------------------------------------------------------------- settle guards
console.log('\n[4] settle guards (no key → policy stage, no broadcast)');
{
  const client = new PonsMCPClient({});
  const x402 = new X402Client(client);
  const bad = await x402.settle({ x402Version: 1, scheme: 'upto', network: 'base', payTo: '0x46E72932a8106E25A0Fb98E2Eb4D79293C4276bb', maxAmountRequired: '1000' });
  check('non-exact scheme rejected', !bad.ok && bad.stage === 'unsupported' && /scheme/.test(bad.error ?? ''));
  const wrongNet = await x402.settle({ x402Version: 1, scheme: 'exact', network: 'base', payTo: '0x46E72932a8106E25A0Fb98E2Eb4D79293C4276bb', maxAmountRequired: '1000' });
  check('foreign network rejected', !wrongNet.ok && wrongNet.stage === 'unsupported' && /network/.test(wrongNet.error ?? ''));
  const wrongAsset = await x402.settle({ x402Version: 1, scheme: 'exact', network: 'robinhood-chain', payTo: '0x46E72932a8106E25A0Fb98E2Eb4D79293C4276bb', maxAmountRequired: '1000', asset: '0x39dBED3a2bd333467115dE45665cC57F813C4571' });
  check('non-USDG asset rejected', !wrongAsset.ok && wrongAsset.stage === 'unsupported' && /USDG/.test(wrongAsset.error ?? ''));
  const okReq = await x402.settle({ x402Version: 1, scheme: 'exact', network: 'robinhood-chain', payTo: '0x46E72932a8106E25A0Fb98E2Eb4D79293C4276bb', maxAmountRequired: '2500' });
  check('valid requirement stops at policy (no wallet)', !okReq.ok && okReq.stage === 'policy_denied' && okReq.priceUsdg === '0.0025', J(okReq));
}

// ---------------------------------------------------------------- discover
console.log('\n[5] X402Client.discover');
{
  const client = new PonsMCPClient({});
  const x402 = new X402Client(client);
  const d = await x402.discover(`http://127.0.0.1:${port}`);
  check('discovers well-known resources', d.ok && d.source?.endsWith('/.well-known/x402') && d.resources.length === 1, J(d));
  check('price converted 2500000 micro → 2.5 USD', d.resources[0]?.priceUsdg === '2.5', `price=${d.resources[0]?.priceUsdg}`);
  check('payTo captured', d.resources[0]?.payTo === REQ.payTo);
  const empty = await x402.discover('http://127.0.0.1:9'); // closed port, fails fast
  check('dead domain degrades to errors[]', empty.ok === false && empty.errors.length === 2);
}

// ---------------------------------------------------------------- header encode
console.log('\n[6] encodePaymentHeader');
{
  const client = new PonsMCPClient({ privateKey: '0x' + '11'.repeat(32) });
  const x402 = new X402Client(client);
  const payment = {
    ok: true, stage: 'confirmed', txHash: '0x' + 'ab'.repeat(32),
    quote: { token: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', amountBase: 2500n, amountHuman: '0.0025', usd: '0.0025' },
    explorer: 'https://robinhoodchain.blockscout.com/tx/0x' + 'ab'.repeat(32),
  };
  const hdr = encodePaymentHeader({ ...REQ, resource: '/paid-header' }, payment, client.address);
  const decoded = JSON.parse(Buffer.from(hdr, 'base64').toString('utf8'));
  check('header round-trips as base64 JSON', decoded.x402Version === 1 && decoded.payload.txHash === '0x' + 'ab'.repeat(32));
  check('proof carries amount + payer', decoded.payload.amountHuman === '0.0025' && decoded.payload.payer === client.address);
}

// ---------------------------------------------------------------- full happy path (stubbed settlement)
console.log('\n[7] fetch happy path: 402 → settle → retry unlocks (pay stubbed, nothing broadcast)');
{
  const client = new PonsMCPClient({ privateKey: '0x' + '22'.repeat(32) });
  client.pay = async (o) => ({
    ok: true, stage: 'confirmed', txHash: '0x' + 'cd'.repeat(32),
    quote: { token: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', amountBase: 2500n, amountHuman: '0.0025', usd: '0.0025' },
    explorer: `https://robinhoodchain.blockscout.com/tx/0x${'cd'.repeat(32)}`,
  });
  const x402 = new X402Client(client);
  const r = await x402.fetch(`${B}/paid-header`);
  check('retry after settlement unlocked the resource', r.ok && r.status === 200 && r.paid && !r.still402, J(r));
  check('server saw the X-PAYMENT proof', r.json?.unlocked === true && r.json?.proof?.payload?.txHash === '0x' + 'cd'.repeat(32), J(r.json));
  check('proof carries payTo + chainId', r.json?.proof?.payload?.payTo === REQ.payTo && r.json?.proof?.payload?.chainId === 4663);
  const b2 = await x402.fetch(`${B}/paid-body`);
  check('body-form requirement also settles + retries', b2.ok && b2.status === 200 && b2.paid, J(b2));
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
