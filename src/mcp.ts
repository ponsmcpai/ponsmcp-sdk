#!/usr/bin/env node
// PonsMCP MCP server — stdio transport (JSON-RPC 2.0, MCP protocol).
// All output text is English only.

import { createInterface } from 'node:readline';
import { CHAIN, rpc, hexToBigInt, unitToString, isAddress, ethCall } from './chain.js';
import { tokenName, tokenSymbol, tokenDecimals, totalSupply, balanceOf } from './erc20.js';
import { ponsPairs, ponsBest, tokenPairs } from './dexscreener.js';
import { ponsLaunchInfo } from './pons.js';
import { ponsV2LaunchRecord, ponsV2ConfigCount, ponsV2SnipeTaxBps, PONS_V2_FACTORY, PONS_V2_LAUNCH_AND_BUY } from './ponsv2.js';
import { escrowNativeBalance, escrowTokenBalance, ponsLaunchFeed, PONS_V2_FEE_ESCROW, PONS_V1_LAUNCH_FEED } from './ponsfees.js';
import { quoteBuyPure, quoteSellPure, type BuyQuoteInput } from './curve.js';
import { PonsMCPClient, payForResource } from './index.js';
import { STOCK_TOKENS, STOCK_BY_ADDRESS, resolveStock, isGradeA, isEarlyWatch } from './stocks.js';

const VERSION = '2.0.0';

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
    name: 'pons_escrow_balance',
    description: 'Read a creator or protocol recipient\'s claimable native ETH balance on the pons v2 fee escrow. Read-only — claiming is a separate wallet action on the escrow contract.',
    inputSchema: {
      type: 'object',
      properties: { recipient: { type: 'string', description: 'creator/fee-recipient address (0x...)' } },
      required: ['recipient'], additionalProperties: false,
    },
  },
  {
    name: 'pons_escrow_token_balance',
    description: 'Read a recipient\'s claimable ERC-20 balance on the pons v2 fee escrow (custom-pair quote asset, or launch-token buyback vest). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        recipient: { type: 'string', description: 'recipient address (0x...)' },
        token: { type: 'string', description: 'quote asset or launch token address (0x...)' },
      },
      required: ['recipient', 'token'], additionalProperties: false,
    },
  },
  {
    name: 'pons_launch_feed',
    description: 'Recent pons token launches from the official launch feed (v1). Returns name, symbol, address, creator, and timing where available.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'how many launches (1-50, default 10)' } },
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
  // ── Stock tokens ─────────────────────────────────────────────────────────
  {
    name: 'pons_stocks_list',
    description: 'List all 19 Robinhood Chain tokenized stock tokens with their on-chain contract addresses. These are tokenized debt securities, not equity shares.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'pons_stock_price',
    description: 'Get live DEX price, liquidity, and 24h change for a Robinhood Chain stock token. Pass a ticker (NVDA, AAPL, TSLA…) or the contract address.',
    inputSchema: {
      type: 'object',
      properties: { ticker: { type: 'string', description: 'Stock ticker (e.g. NVDA) or 0x address' } },
      required: ['ticker'], additionalProperties: false,
    },
  },
  {
    name: 'pons_stock_info',
    description: 'Read on-chain metadata (name, symbol, total supply) for a Robinhood Chain stock token. Pass ticker or address.',
    inputSchema: {
      type: 'object',
      properties: { ticker: { type: 'string', description: 'Stock ticker (e.g. NVDA) or 0x address' } },
      required: ['ticker'], additionalProperties: false,
    },
  },
  {
    name: 'pons_stocks_screen',
    description: 'Screen all 19 stock tokens: fetches live DEX data for each and returns ranked list. Filters: minLiquidityUsd, gradeA (notifier.py Grade A logic). Slow — makes batch DexScreener call.',
    inputSchema: {
      type: 'object',
      properties: {
        minLiquidityUsd: { type: 'number', description: 'Min liquidity filter (default 0)' },
        gradeA: { type: 'boolean', description: 'Only return Grade A tokens (liq>$500, grad>5%, change>-50%)' },
      },
      additionalProperties: false,
    },
  },
  // ── Pons launch screening ─────────────────────────────────────────────────
  {
    name: 'pons_graduated_launches',
    description: 'Return pons v1 launches that have graduated (reached their liquidity threshold). Pulls the launch feed then filters by graduation status.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max results (default 20)' } },
      additionalProperties: false,
    },
  },
  {
    name: 'pons_launch_ranking',
    description: 'Rank recent pons launches by graduation progress, liquidity, or 24h price change. Returns labeled Grade A / Early Watch / Watch / Low signal tiers matching the notifier.py screening logic.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Launches to fetch from feed before ranking (default 20, max 50)' },
        sortBy: { type: 'string', enum: ['graduation', 'liquidity', 'change24h'], description: 'Sort key (default graduation)' },
      },
      additionalProperties: false,
    },
  },
  // ── Wallet / transfer ─────────────────────────────────────────────────────
  {
    name: 'pons_send_token',
    description: 'Send any ERC-20 token on Robinhood Chain (USDG, PONS, stock token, or custom). Requires PONSMCP_PRIVATE_KEY env. Policy caps apply (100 USDG/tx, 1000 USDG/day equivalent).',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient address (0x...)' },
        token: { type: 'string', description: 'Token address or ticker (USDG, PONS, NVDA, etc.)' },
        amount: { type: 'string', description: 'Human amount, e.g. "5.00" — decimals resolved on-chain' },
        waitMs: { type: 'number', description: 'Max ms to wait for receipt (default 30000)' },
      },
      required: ['to', 'token', 'amount'], additionalProperties: false,
    },
  },
  {
    name: 'pons_send_eth',
    description: 'Send native ETH (gas token) on Robinhood Chain. Requires PONSMCP_PRIVATE_KEY env.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient address (0x...)' },
        amountEth: { type: 'string', description: 'ETH amount, e.g. "0.001"' },
        waitMs: { type: 'number', description: 'Max ms to wait for receipt (default 30000)' },
      },
      required: ['to', 'amountEth'], additionalProperties: false,
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
    case 'pons_escrow_balance': {
      const wei = await escrowNativeBalance(String(args.recipient ?? ''));
      return { recipient: String(args.recipient).toLowerCase(), escrow: PONS_V2_FEE_ESCROW, claimableNativeWei: wei.toString(), claimableNativeEth: (Number(wei) / 1e18).toFixed(6), note: 'read-only; claim() on the escrow is a separate wallet action' };
    }
    case 'pons_escrow_token_balance': {
      const raw = await escrowTokenBalance(String(args.recipient ?? ''), String(args.token ?? ''));
      return { recipient: String(args.recipient).toLowerCase(), token: String(args.token).toLowerCase(), escrow: PONS_V2_FEE_ESCROW, claimableRaw: raw.toString() };
    }
    case 'pons_launch_feed': {
      const launches = await ponsLaunchFeed(args.limit ? Number(args.limit) : 10);
      return { source: PONS_V1_LAUNCH_FEED, count: launches.length, launches };
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
    // ── Stock tokens ────────────────────────────────────────────────────────
    case 'pons_stocks_list': {
      return {
        count: Object.keys(STOCK_TOKENS).length,
        note: 'Tokenized debt securities issued by Robinhood on Robinhood Chain 4663. These are NOT equity shares.',
        tokens: Object.entries(STOCK_TOKENS).map(([symbol, address]) => ({ symbol, address })),
      };
    }
    case 'pons_stock_price': {
      const resolved = resolveStock(String(args.ticker ?? ''));
      if (!resolved) throw new Error(`Unknown ticker or address. Available: ${Object.keys(STOCK_TOKENS).join(', ')}`);
      const pairs = await tokenPairs(resolved.address);
      const best = pairs[0] ?? null;
      return {
        symbol: resolved.symbol, address: resolved.address,
        priceUsd: best?.priceUsd ?? null, liquidityUsd: best?.liquidityUsd ?? null,
        change24h: best?.change24h ?? null, dex: best?.dex ?? null,
        pairsCount: pairs.length,
        top3: pairs.slice(0, 3).map(p => ({ pair: `${p.base}/${p.quote}`, dex: p.dex, priceUsd: p.priceUsd, liquidityUsd: p.liquidityUsd, change24h: p.change24h, url: p.url })),
        note: 'Tokenized debt security — price reflects DEX trading, not official NAV.',
      };
    }
    case 'pons_stock_info': {
      const resolved = resolveStock(String(args.ticker ?? ''));
      if (!resolved) throw new Error(`Unknown ticker or address. Available: ${Object.keys(STOCK_TOKENS).join(', ')}`);
      const [name, symbol, decimals, supply] = await Promise.all([
        tokenName(resolved.address), tokenSymbol(resolved.address),
        tokenDecimals(resolved.address), totalSupply(resolved.address),
      ]);
      return {
        ticker: resolved.symbol, address: resolved.address,
        name, symbol, decimals,
        totalSupply: supply.toString(), totalSupplyHuman: unitToString(supply, decimals),
        note: 'Tokenized debt security issued by Robinhood — name suffix confirms issuer.',
      };
    }
    case 'pons_stocks_screen': {
      const minLiq = Number(args.minLiquidityUsd ?? 0);
      const gradeAOnly = Boolean(args.gradeA);
      // Batch-fetch all stock token pair data from DexScreener in groups of 5.
      const tickers = Object.keys(STOCK_TOKENS);
      const results: Array<{
        symbol: string; address: string; priceUsd: number | null;
        liquidityUsd: number; change24h: number | null;
        gradeA: boolean; earlyWatch: boolean; tier: string;
      }> = [];
      const BATCH = 5;
      for (let i = 0; i < tickers.length; i += BATCH) {
        const batch = tickers.slice(i, i + BATCH);
        await Promise.all(batch.map(async (sym) => {
          try {
            const addr = STOCK_TOKENS[sym];
            const pairs = await tokenPairs(addr);
            const best = pairs[0];
            const liq = best?.liquidityUsd ?? 0;
            const change = best?.change24h ?? null;
            const grad = 0; // stock tokens don't have pons graduation
            const gA = isGradeA({ liquidityUsd: liq, graduationPct: grad, change24h: change });
            const eW = isEarlyWatch({ liquidityUsd: liq, graduationPct: grad });
            results.push({
              symbol: sym, address: addr,
              priceUsd: best?.priceUsd ?? null,
              liquidityUsd: liq, change24h: change,
              gradeA: gA, earlyWatch: eW,
              tier: gA ? 'Grade A' : liq > 0 ? 'Active' : 'No pairs',
            });
          } catch {
            results.push({ symbol: sym, address: STOCK_TOKENS[sym], priceUsd: null, liquidityUsd: 0, change24h: null, gradeA: false, earlyWatch: false, tier: 'Error' });
          }
        }));
      }
      const filtered = results
        .filter(r => r.liquidityUsd >= minLiq && (!gradeAOnly || r.gradeA))
        .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
      return { screened: results.length, returned: filtered.length, tokens: filtered };
    }
    // ── Pons launch screening ─────────────────────────────────────────────
    case 'pons_graduated_launches': {
      const limit = Math.min(50, Number(args.limit ?? 20));
      const feed = await ponsLaunchFeed(limit);
      const graduated = feed.filter((l: any) => {
        const pct = Number(l.graduation_progress ?? l.graduationProgress ?? 0);
        return pct >= 100;
      });
      return { total_fetched: feed.length, graduated: graduated.length, launches: graduated };
    }
    case 'pons_launch_ranking': {
      const limit = Math.min(50, Number(args.limit ?? 20));
      const sortBy: string = String(args.sortBy ?? 'graduation');
      const feed = await ponsLaunchFeed(limit);
      const ranked = (feed as any[]).map((l: any) => {
        const liq = Number(l.liquidity_usd ?? l.liquidityUsd ?? 0);
        const grad = Number(l.graduation_progress ?? l.graduationProgress ?? 0);
        const change = l.price_change_24h ?? l.change24h ?? null;
        const gA = isGradeA({ liquidityUsd: liq, graduationPct: grad, change24h: change });
        const eW = isEarlyWatch({ liquidityUsd: liq, graduationPct: grad });
        const tier = grad >= 100 ? 'Graduated' : gA ? 'Grade A' : eW ? 'Early Watch' : liq > 0 ? 'Watch' : 'Low Signal';
        return { ...l, tier, _liq: liq, _grad: grad, _change: change };
      });
      if (sortBy === 'liquidity') ranked.sort((a: any, b: any) => b._liq - a._liq);
      else if (sortBy === 'change24h') ranked.sort((a: any, b: any) => (b._change ?? -999) - (a._change ?? -999));
      else ranked.sort((a: any, b: any) => b._grad - a._grad);
      const summary = { Graduated: 0, 'Grade A': 0, 'Early Watch': 0, Watch: 0, 'Low Signal': 0 } as Record<string, number>;
      for (const r of ranked) summary[r.tier] = (summary[r.tier] ?? 0) + 1;
      return { total: ranked.length, sortedBy: sortBy, summary, launches: ranked };
    }
    // ── Transfer tools ──────────────────────────────────────────────────────
    case 'pons_send_token': {
      const to = String(args.to ?? '');
      const tokenArg = String(args.token ?? '');
      const amountStr = String(args.amount ?? '0');
      if (!isAddress(to)) throw new Error('Invalid recipient address');
      // Resolve token: could be ticker, known alias, or raw address.
      let tokenAddr: string = tokenArg;
      if (!isAddress(tokenArg)) {
        const upper = tokenArg.toUpperCase().trim();
        const stock = resolveStock(upper);
        if (stock) { tokenAddr = stock.address; }
        else if (upper === 'USDG') { tokenAddr = CHAIN.usdg; }
        else if (upper === 'PONS') { tokenAddr = CHAIN.pons; }
        else if (upper === 'WETH' || upper === 'ETH') { tokenAddr = CHAIN.weth; }
        else throw new Error(`Cannot resolve token "${tokenArg}". Pass a 0x address or a known ticker (USDG, PONS, NVDA, TSLA, etc.).`);
      }
      // Fetch decimals, convert amount, then send via USDG-style pons_pay path
      // but for arbitrary tokens we do a raw ERC-20 transfer.
      const dec = await tokenDecimals(tokenAddr);
      const base = BigInt(Math.round(Number(amountStr) * 10 ** dec));
      // Build ERC-20 transfer calldata directly and use PonsMCPClient signing layer.
      const client = new PonsMCPClient({ privateKey: process.env.PONSMCP_PRIVATE_KEY });
      if (!client.address) throw new Error('PONSMCP_PRIVATE_KEY not set');
      const { rpc: rpcFn, hexToBigInt: htb, erc20TransferData } = await import('./chain.js');
      const nonce = htb(await rpcFn<string>('eth_getTransactionCount', [client.address, 'pending']));
      const gp = htb(await rpcFn<string>('eth_gasPrice', []));
      const gasPrice = gp > 100_000_000n ? (gp * 3n) / 2n : 100_000_000n;
      const { signTransaction } = await import('./crypto.js');
      const tx = { nonce, gasPrice, gas: 80_000n, to: tokenAddr, value: 0n, data: Buffer.from(erc20TransferData(to, base).slice(2), 'hex'), chainId: CHAIN.chainId };
      const raw = (signTransaction as any)(tx, BigInt('0x' + process.env.PONSMCP_PRIVATE_KEY!.replace(/^0x/, '')));
      const txHash = await rpcFn<string>('eth_sendRawTransaction', ['0x' + raw.toString('hex')]);
      // Wait for receipt
      const waitMs = args.waitMs ? Number(args.waitMs) : 30_000;
      const t0 = Date.now();
      let receipt: any = null;
      while (Date.now() - t0 < waitMs) {
        receipt = await rpcFn('eth_getTransactionReceipt', [txHash]);
        if (receipt) break;
        await new Promise(r => setTimeout(r, 3000));
      }
      return {
        ok: receipt?.status === '0x1',
        txHash, explorer: `${CHAIN.explorer}/tx/${txHash}`,
        token: tokenAddr, to, amountHuman: amountStr, decimals: dec,
        block: receipt ? Number(htb(receipt.blockNumber)) : null,
        gasUsed: receipt ? Number(htb(receipt.gasUsed)) : null,
      };
    }
    case 'pons_send_eth': {
      const to = String(args.to ?? '');
      const amountEth = String(args.amountEth ?? '0');
      if (!isAddress(to)) throw new Error('Invalid recipient address');
      const client = new PonsMCPClient({ privateKey: process.env.PONSMCP_PRIVATE_KEY });
      if (!client.address) throw new Error('PONSMCP_PRIVATE_KEY not set');
      const { rpc: rpcFn, hexToBigInt: htb } = await import('./chain.js');
      const { signTransaction } = await import('./crypto.js');
      const valueWei = BigInt(Math.round(Number(amountEth) * 1e18));
      const nonce = htb(await rpcFn<string>('eth_getTransactionCount', [client.address, 'pending']));
      const gp = htb(await rpcFn<string>('eth_gasPrice', []));
      const gasPrice = gp > 100_000_000n ? (gp * 3n) / 2n : 100_000_000n;
      const tx = { nonce, gasPrice, gas: 21_000n, to, value: valueWei, data: Buffer.alloc(0), chainId: CHAIN.chainId };
      const raw = (signTransaction as any)(tx, BigInt('0x' + process.env.PONSMCP_PRIVATE_KEY!.replace(/^0x/, '')));
      const txHash = await rpcFn<string>('eth_sendRawTransaction', ['0x' + raw.toString('hex')]);
      const waitMs = args.waitMs ? Number(args.waitMs) : 30_000;
      const t0 = Date.now();
      let receipt: any = null;
      while (Date.now() - t0 < waitMs) {
        receipt = await rpcFn('eth_getTransactionReceipt', [txHash]);
        if (receipt) break;
        await new Promise(r => setTimeout(r, 3000));
      }
      return {
        ok: receipt?.status === '0x1',
        txHash, explorer: `${CHAIN.explorer}/tx/${txHash}`,
        to, amountEth, valueWei: valueWei.toString(),
        block: receipt ? Number(htb(receipt.blockNumber)) : null,
        gasUsed: receipt ? Number(htb(receipt.gasUsed)) : null,
      };
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
