#!/usr/bin/env node
// PonsMCP MCP server — stdio transport (JSON-RPC 2.0, MCP protocol).
// Tools are self-contained (no SDK dependency) so the binary runs standalone.

import { createInterface } from 'node:readline';
import { CHAIN, rpc, hexToBigInt, unitToString, isAddress } from './chain.js';
import { tokenName, tokenSymbol, tokenDecimals, totalSupply, balanceOf } from './erc20.js';
import { ponsPairs, ponsBest, tokenPairs } from './dexscreener.js';
import { ponsLaunchInfo } from './pons.js';
import { ponsV2LaunchRecord, ponsV2ConfigCount, ponsV2SnipeTaxBps, PONS_V2_FACTORY, PONS_V2_LAUNCH_AND_BUY } from './ponsv2.js';
import { quoteBuyPure, quoteSellPure, type BuyQuoteInput } from './curve.js';
import { PonsMCPClient, payForResource } from './index.js';

const VERSION = '1.3.0';

const TOOLS = [
  {
    name: 'pons_chain_info',
    description: 'Get Robinhood Chain network info: chainId, RPC, explorer, and the canonical PONS / USDG / WETH token addresses.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'pons_price',
    description: 'Get the live PONS token price (USD), liquidity, and top DEX pairs on Robinhood Chain via DexScreener.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'pons_launch_info',
    description: 'Read a pons v1 launch token directly onchain: canonical pool, fixed supply, logo, description, and social links. Names/symbols are not identity; use the token address.',
    inputSchema: {
      type: 'object',
      properties: { token: { type: 'string', description: 'pons launch-token contract address (0x...)' } },
      required: ['token'], additionalProperties: false,
    },
  },
  {
    name: 'pons_launch_market',
    description: 'Get live Robinhood Chain DEX markets, price, liquidity, and 24h change for a pons launch token address.',
    inputSchema: {
      type: 'object',
      properties: { token: { type: 'string', description: 'pons launch-token contract address (0x...)' } },
      required: ['token'], additionalProperties: false,
    },
  },
  {
    name: 'pons_v2_launch',
    description: 'Read a pons v2 launch record from the factory: deployer, paired token, pool fee, supply, restrictions end block. Read-only; does not launch anything.',
    inputSchema: {
      type: 'object',
      properties: { token: { type: 'string', description: 'pons v2 launch-token address (0x...)' } },
      required: ['token'], additionalProperties: false,
    },
  },
  {
    name: 'pons_v2_snipe_tax',
    description: 'Read the decaying opening snipe tax (bps) a pons v2 curve would charge a specific recipient right now. Keyed on the recipient per pons docs. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        curve: { type: 'string', description: 'pons v2 curve address (0x...)' },
        recipient: { type: 'string', description: 'wallet that would receive the buy (0x...)' },
      },
      required: ['curve', 'recipient'], additionalProperties: false,
    },
  },
  {
    name: 'pons_v2_quote_buy',
    description: 'Pure curve buy quote for a pons v2 launch: tokens out, fee, tax, snipe tax, and refund given reserves and fee inputs. Pure math — reads no chain state and moves nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        quoteIn: { type: 'string', description: 'buy amount in wei (quote asset)' },
        quoteReserve: { type: 'string' }, tokenReserve: { type: 'string' }, sellable: { type: 'string' },
        feeBps: { type: 'string' }, creatorTaxBps: { type: 'string' }, rawSnipeBps: { type: 'string' },
      },
      required: ['quoteIn', 'quoteReserve', 'tokenReserve', 'sellable', 'feeBps', 'creatorTaxBps', 'rawSnipeBps'],
      additionalProperties: false,
    },
  },
  {
    name: 'pons_v2_quote_sell',
    description: 'Pure curve sell quote for a pons v2 launch: quote out, fee, tax, and net proceeds. Pure math — reads no chain state and moves nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        tokensIn: { type: 'string' }, quoteReserve: { type: 'string' }, tokenReserve: { type: 'string' },
        feeBps: { type: 'string' }, creatorTaxBps: { type: 'string' },
      },
      required: ['tokensIn', 'quoteReserve', 'tokenReserve', 'feeBps', 'creatorTaxBps'],
      additionalProperties: false,
    },
  },
  {
    name: 'pons_token_info',
    description: 'Read on-chain ERC-20 metadata for any token on Robinhood Chain: name, symbol, decimals, total supply.',
    inputSchema: {
      type: 'object',
      properties: { token: { type: 'string', description: 'Token contract address (0x...)' } },
      required: ['token'],
    },
  },
  {
    name: 'pons_balance',
    description: 'Get the agent wallet balance for a token (default USDG) on Robinhood Chain.',
    inputSchema: {
      type: 'object',
      properties: { token: { type: 'string', description: 'Token address; default USDG settlement token' } },
    },
  },
  {
    name: 'pons_quote',
    description: 'Quote a payment: converts a USD amount into USDG base units (6 decimals) and returns the settlement plan without executing.',
    inputSchema: {
      type: 'object',
      properties: { amountUsd: { type: 'string', description: 'USD amount, e.g. "5.00"' } },
      required: ['amountUsd'],
    },
  },
  {
    name: 'pons_pay',
    description: 'Execute an autonomous MPP payment: policy check, then transfer USDG on Robinhood Chain to the payTo address, then verify the on-chain receipt. Requires PONSMCP_PRIVATE_KEY env. Guards: policy limits, balance check, receipt verification.',
    inputSchema: {
      type: 'object',
      properties: {
        payTo: { type: 'string', description: 'Recipient address (0x...)' },
        amountUsd: { type: 'string', description: 'USD amount, e.g. "5.00"' },
        waitMs: { type: 'number', description: 'Max ms to wait for receipt (default 30000)' },
      },
      required: ['payTo', 'amountUsd'],
    },
  },
  {
    name: 'pons_pay_resource',
    description: 'Fetch an HTTP resource that answers 402 PAYMENT-REQUIRED, parse the price and recipient, and settle exactly that price in USDG on Robinhood Chain with full policy checks. Nothing broadcasts unless the 402 parses. Requires PONSMCP_PRIVATE_KEY env.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL of the 402-gated resource' },
        waitMs: { type: 'number', description: 'Max ms to wait for receipt (default 30000)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'pons_tx_status',
    description: 'Look up a transaction receipt on Robinhood Chain: status, block, gas used, and decoded ERC-20 transfers.',
    inputSchema: {
      type: 'object',
      properties: { txHash: { type: 'string', description: 'Transaction hash (0x...)' } },
      required: ['txHash'],
    },
  },
];

function jsonSafe(v: unknown): string {
  return JSON.stringify(
    v,
    (_k, x) => (typeof x === 'bigint' ? x.toString() : x),
    2
  );
}

async function callTool(name: string, args: Record<string, any>): Promise<unknown> {
  switch (name) {
    case 'pons_chain_info': {
      const [latest, gas] = await Promise.all([
        rpc<string>('eth_blockNumber', []).then(hexToBigInt),
        rpc<string>('eth_gasPrice', []).then(hexToBigInt),
      ]);
      return {
        chain: CHAIN.name,
        chainId: CHAIN.chainId,
        rpcUrl: CHAIN.rpcUrl,
        explorer: CHAIN.explorer,
        gasToken: CHAIN.gasToken,
        latestBlock: Number(latest),
        gasPriceGwei: Number(unitToString(gas, 9)),
        tokens: { pons: CHAIN.pons, usdg: CHAIN.usdg, weth: CHAIN.weth },
      };
    }
    case 'pons_price': {
      const best = await ponsBest();
      const pairs = await ponsPairs();
      return {
        best: best
          ? { priceUsd: best.priceUsd, liquidityUsd: best.liquidityUsd, pair: best.pairAddress, dex: best.dex, change24h: best.change24h, url: best.url }
          : null,
        pairsCount: pairs.length,
        top5: pairs.slice(0, 5).map((p) => ({ pair: `${p.base}/${p.quote}`, dex: p.dex, priceUsd: p.priceUsd, liquidityUsd: p.liquidityUsd })),
      };
    }
    case 'pons_launch_info': {
      return ponsLaunchInfo(String(args.token ?? ''));
    }
    case 'pons_launch_market': {
      const token = String(args.token ?? '');
      if (!isAddress(token)) throw new Error(`invalid token address: ${token}`);
      const pairs = await tokenPairs(token);
      return {
        token: token.toLowerCase(), pairsCount: pairs.length,
        best: pairs[0] ? { priceUsd: pairs[0].priceUsd, liquidityUsd: pairs[0].liquidityUsd, pair: pairs[0].pairAddress, dex: pairs[0].dex, change24h: pairs[0].change24h, url: pairs[0].url } : null,
        top5: pairs.slice(0, 5).map((p) => ({ pair: `${p.base}/${p.quote}`, dex: p.dex, priceUsd: p.priceUsd, liquidityUsd: p.liquidityUsd, change24h: p.change24h, url: p.url })),
      };
    }
    case 'pons_v2_launch': {
      return ponsV2LaunchRecord(String(args.token ?? ''));
    }
    case 'pons_v2_quote_buy': {
      const input: BuyQuoteInput = {
        quoteIn: BigInt(args.quoteIn), quoteReserve: BigInt(args.quoteReserve), tokenReserve: BigInt(args.tokenReserve),
        sellable: BigInt(args.sellable), feeBps: BigInt(args.feeBps), creatorTaxBps: BigInt(args.creatorTaxBps), rawSnipeBps: BigInt(args.rawSnipeBps),
      };
      return quoteBuyPure(input);
    }
    case 'pons_v2_quote_sell': {
      return quoteSellPure({
        tokensIn: BigInt(args.tokensIn), quoteReserve: BigInt(args.quoteReserve), tokenReserve: BigInt(args.tokenReserve),
        feeBps: BigInt(args.feeBps), creatorTaxBps: BigInt(args.creatorTaxBps),
      });
    }
    case 'pons_v2_snipe_tax': {
      const bps = await ponsV2SnipeTaxBps(String(args.curve ?? ''), String(args.recipient ?? ''));
      return { curve: String(args.curve).toLowerCase(), recipient: String(args.recipient).toLowerCase(), snipeTaxBps: bps, verdict: bps === 0 ? 'exempt' : 'wait for decay', factory: PONS_V2_FACTORY, launchAndBuyRouter: PONS_V2_LAUNCH_AND_BUY, note: 'read-only intelligence; PonsMCP does not launch or snipe' };
    }
    case 'pons_token_info': {
      const t = String(args.token ?? '');
      if (!isAddress(t)) throw new Error(`invalid token address: ${t}`);
      const [name, symbol, decimals, supply] = await Promise.all([
        tokenName(t), tokenSymbol(t), tokenDecimals(t), totalSupply(t),
      ]);
      return { address: t, name, symbol, decimals, totalSupply: supply.toString() };
    }
    case 'pons_balance': {
      const client = new PonsMCPClient({ privateKey: process.env.PONSMCP_PRIVATE_KEY });
      const token = args.token ? String(args.token) : CHAIN.usdg;
      const b = await client.getBalance(token);
      const meta = await (async () => { try { return await new PonsMCPClient().tokenInfo(token); } catch { return null; } })();
      return { wallet: client.address, token, balance: b.human, decimals: b.decimals, symbol: meta?.symbol ?? '?' };
    }
    case 'pons_quote': {
      const client = new PonsMCPClient();
      const q = await client.quote(String(args.amountUsd ?? '0'));
      return {
        usd: q.usd, token: CHAIN.usdg, symbol: 'USDG',
        amountBase: q.amountBase.toString(), amountHuman: q.amountHuman,
        note: 'quote only — nothing executed',
      };
    }
    case 'pons_pay': {
      const payTo = String(args.payTo ?? '');
      const amountUsd = String(args.amountUsd ?? '0');
      const client = new PonsMCPClient({ privateKey: process.env.PONSMCP_PRIVATE_KEY });
      const result = await client.pay({ payTo, amountUsd, waitMs: args.waitMs ? Number(args.waitMs) : undefined });
      return result;
    }
    case 'pons_tx_status': {
      const h = String(args.txHash ?? '');
      if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw new Error(`invalid tx hash: ${h}`);
      const client = new PonsMCPClient();
      return client.txStatus(h);
    }
    case 'pons_pay_resource': {
      const url = String(args.url ?? '');
      if (!/^https?:\/\//i.test(url)) throw new Error(`invalid resource URL: ${url}`);
      const client = new PonsMCPClient({ privateKey: process.env.PONSMCP_PRIVATE_KEY });
      return payForResource(client, url, { waitMs: args.waitMs ? Number(args.waitMs) : undefined });
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ------------------------------------------------------------ JSON-RPC loop

const rl = createInterface({ input: process.stdin });
function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req: any;
  try { req = JSON.parse(trimmed); } catch { return; }
  void (async () => {
    const { id, method, params } = req;
    try {
      if (method === 'initialize') {
        send({
          jsonrpc: '2.0', id, result: {
            protocolVersion: params?.protocolVersion ?? '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'ponsmcp', version: VERSION },
          },
        });
      } else if (method === 'notifications/initialized' || method?.startsWith('notifications/')) {
        // notifications: no response
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      } else if (method === 'tools/call') {
        const name = String(params?.name ?? '');
        const result = await callTool(name, params?.arguments ?? {});
        send({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: jsonSafe(result) }] },
        });
      } else if (method === 'ping') {
        send({ jsonrpc: '2.0', id, result: {} });
      } else if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
      }
    } catch (e: any) {
      if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32000, message: e?.message ?? String(e) } });
      }
    }
  })();
});

process.on('SIGINT', () => process.exit(0));
