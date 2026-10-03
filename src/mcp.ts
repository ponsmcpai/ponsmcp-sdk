#!/usr/bin/env node
// PonsMCP MCP server — stdio transport (JSON-RPC 2.0, MCP protocol).
// All output text is English only.

import { createInterface } from 'node:readline';
import { CHAIN, rpc, hexToBigInt, unitToString, isAddress, ethCall, erc20TransferData } from './chain.js';
import { tokenName, tokenSymbol, tokenDecimals, totalSupply, balanceOf } from './erc20.js';
import { ponsPairs, ponsBest, tokenPairs } from './dexscreener.js';
import { ponsLaunchInfo } from './pons.js';
import { ponsV2LaunchRecord, ponsV2ConfigCount, ponsV2SnipeTaxBps, PONS_V2_FACTORY, PONS_V2_LAUNCH_AND_BUY } from './ponsv2.js';
import { escrowNativeBalance, escrowTokenBalance, ponsLaunchFeed, PONS_V2_FEE_ESCROW, PONS_V1_LAUNCH_FEED } from './ponsfees.js';
import { quoteBuyPure, quoteSellPure, type BuyQuoteInput } from './curve.js';
import { PonsMCPClient, payForResource } from './index.js';
import { X402Client } from './x402.js';
import { PolicyEngine } from './policy.js';
import { STOCK_TOKENS, STOCK_BY_ADDRESS, resolveStock, isGradeA, isEarlyWatch } from './stocks.js';

const VERSION = '2.2.1';
// Shared policy engine for pons_send_token and pons_send_eth — same caps as pons_pay.
const sharedPolicy = new PolicyEngine();

const TOOLS = [
  /**
   * pons_chain_info — Robinhood Chain network facts.
   *
   * @param none - this tool takes no arguments
   * @example tools/call request body:
   * @example { "name": "pons_chain_info", "arguments": {} }
   */
  {
    name: 'pons_chain_info',
    description: 'Get Robinhood Chain network info: chainId, RPC, explorer, and the canonical PONS / USDG / WETH token addresses.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  /**
   * pons_price — Live PONS market snapshot via DexScreener.
   *
   * @param none - this tool takes no arguments
   * @example tools/call request body:
   * @example { "name": "pons_price", "arguments": {} }
   */
  {
    name: 'pons_price',
    description: 'Get the live PONS token price (USD), liquidity, and top DEX pairs on Robinhood Chain via DexScreener.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  /**
   * pons_launch_info — Read a pons v1 launch token onchain: pool, supply, logo, description, socials.
   *
   * @param token - pons launch-token contract address (0x…), required
   * @example tools/call request body:
   * @example { "name": "pons_launch_info", "arguments": { "token": "0x…" } }
   */
  {
    name: 'pons_launch_info',
    description: 'Read a pons v1 launch token directly onchain: canonical pool, fixed supply, logo, description, and social links. Names/symbols are not identity; use the token address.',
    inputSchema: {
      type: 'object',
      properties: { token: { type: 'string', description: 'pons launch-token contract address (0x...)' } },
      required: ['token'], additionalProperties: false,
    },
  },
  /**
   * pons_launch_market — Live DEX markets, price, and liquidity for a pons launch token.
   *
   * @param token - pons launch-token contract address (0x…), required
   * @example tools/call request body:
   * @example { "name": "pons_launch_market", "arguments": { "token": "0x…" } }
   */
  {
    name: 'pons_launch_market',
    description: 'Get live Robinhood Chain DEX markets, price, liquidity, and 24h change for a pons launch token address.',
    inputSchema: {
      type: 'object',
      properties: { token: { type: 'string', description: 'pons launch-token contract address (0x...)' } },
      required: ['token'], additionalProperties: false,
    },
  },
  /**
   * pons_v2_launch — Read a pons v2 factory launch record (deployer, paired token, pool fee, supply). Read-only.
   *
   * @param token - pons v2 launch-token address (0x…), required
   * @example tools/call request body:
   * @example { "name": "pons_v2_launch", "arguments": { "token": "0x…" } }
   */
  {
    name: 'pons_v2_launch',
    description: 'Read a pons v2 launch record from the factory: deployer, paired token, pool fee, supply, restrictions end block. Read-only; does not launch anything.',
    inputSchema: {
      type: 'object',
      properties: { token: { type: 'string', description: 'pons v2 launch-token address (0x...)' } },
      required: ['token'], additionalProperties: false,
    },
  },
  /**
   * pons_v2_snipe_tax — Read the decaying opening snipe tax (bps) a v2 curve would charge a recipient right now.
   *
   * @param curve - pons v2 curve address (0x…), required
   * @param recipient - wallet that would receive the buy (0x…), required
   * @example tools/call request body:
   * @example { "name": "pons_v2_snipe_tax", "arguments": { "curve": "0x…", "recipient": "0x…" } }
   */
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
  /**
   * pons_v2_quote_buy — Pure curve buy quote: tokens out, fee, tax, snipe tax, refund. No chain reads.
   *
   * @param quoteIn - buy amount in wei (quote asset), required
   * @param quoteReserve - quote-asset reserve in wei, required
   * @param tokenReserve - token reserve in wei (base units), required
   * @param sellable - sellable token supply in wei, required
   * @param feeBps - protocol fee in basis points, required
   * @param creatorTaxBps - creator tax in basis points, required
   * @param rawSnipeBps - raw opening snipe tax in basis points, required
   * @example tools/call request body:
   * @example { "name": "pons_v2_quote_buy", "arguments": { "quoteIn": "1000000000000000000", "quoteReserve": "…", "tokenReserve": "…", "sellable": "…", "feeBps": "100", "creatorTaxBps": "300", "rawSnipeBps": "5000" } }
   */
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
  /**
   * pons_v2_quote_sell — Pure curve sell quote: quote out, fee, tax, net proceeds. No chain reads.
   *
   * @param tokensIn - tokens sold in wei (base units), required
   * @param quoteReserve - quote-asset reserve in wei, required
   * @param tokenReserve - token reserve in wei, required
   * @param feeBps - protocol fee in basis points, required
   * @param creatorTaxBps - creator tax in basis points, required
   * @example tools/call request body:
   * @example { "name": "pons_v2_quote_sell", "arguments": { "tokensIn": "1000000", "quoteReserve": "…", "tokenReserve": "…", "feeBps": "100", "creatorTaxBps": "300" } }
   */
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
  /**
   * pons_escrow_balance — Claimable native ETH on the pons v2 fee escrow for a recipient. Read-only.
   *
   * @param recipient - creator/fee-recipient address (0x…), required
   * @example tools/call request body:
   * @example { "name": "pons_escrow_balance", "arguments": { "recipient": "0x…" } }
   */
  {
    name: 'pons_escrow_balance',
    description: 'Read a creator or protocol recipient\'s claimable native ETH balance on the pons v2 fee escrow. Read-only — claiming is a separate wallet action on the escrow contract.',
    inputSchema: {
      type: 'object',
      properties: { recipient: { type: 'string', description: 'creator/fee-recipient address (0x...)' } },
      required: ['recipient'], additionalProperties: false,
    },
  },
  /**
   * pons_escrow_token_balance — Claimable ERC-20 balance on the v2 fee escrow (quote asset or buyback vest). Read-only.
   *
   * @param recipient - recipient address (0x…), required
   * @param token - quote asset or launch-token address (0x…), required
   * @example tools/call request body:
   * @example { "name": "pons_escrow_token_balance", "arguments": { "recipient": "0x…", "token": "0x…" } }
   */
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
  /**
   * pons_launch_feed — Recent pons launches from the official v1 feed.
   *
   * @param limit - how many launches to return, 1-50, optional (default 10)
   * @example tools/call request body:
   * @example { "name": "pons_launch_feed", "arguments": { "limit": 10 } }
   */
  {
    name: 'pons_launch_feed',
    description: 'Recent pons token launches from the official launch feed (v1). Returns name, symbol, address, creator, and timing where available.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'how many launches (1-50, default 10)' } },
      additionalProperties: false,
    },
  },
  /**
   * pons_token_info — ERC-20 metadata (name, symbol, decimals, total supply) for any token on Robinhood Chain.
   *
   * @param token - token contract address (0x…), required
   * @example tools/call request body:
   * @example { "name": "pons_token_info", "arguments": { "token": "0x…" } }
   */
  {
    name: 'pons_token_info',
    description: 'Read on-chain ERC-20 metadata for any token on Robinhood Chain: name, symbol, decimals, total supply.',
    inputSchema: {
      type: 'object',
      properties: { token: { type: 'string', description: 'Token contract address (0x...)' } },
      required: ['token'],
    },
  },
  /**
   * pons_balance — Agent wallet balance for a token (defaults to USDG). Requires PONSMCP_PRIVATE_KEY.
   *
   * @param token - token address or ticker (USDG, PONS, NVDA, …), optional (default USDG)
   * @example tools/call request body:
   * @example { "name": "pons_balance", "arguments": { "token": "USDG" } }
   */
  {
    name: 'pons_balance',
    description: 'Get the agent wallet balance for a token (default USDG) on Robinhood Chain.',
    inputSchema: {
      type: 'object',
      properties: { token: { type: 'string', description: 'Token address; default USDG settlement token' } },
    },
  },
  /**
   * pons_quote — Convert a USD amount into USDG base units (6 decimals). Quote only — nothing executes.
   *
   * @param amountUsd - USD amount as a decimal string, e.g. "5.00", required
   * @example tools/call request body:
   * @example { "name": "pons_quote", "arguments": { "amountUsd": "5.00" } }
   */
  {
    name: 'pons_quote',
    description: 'Quote a payment: converts a USD amount into USDG base units (6 decimals) and returns the settlement plan without executing.',
    inputSchema: {
      type: 'object',
      properties: { amountUsd: { type: 'string', description: 'USD amount, e.g. "5.00"' } },
      required: ['amountUsd'],
    },
  },
  /**
   * pons_pay — Execute an autonomous payment: policy check → USDG transfer → verified receipt. Requires PONSMCP_PRIVATE_KEY.
   *
   * @param payTo - recipient address (0x…), required
   * @param amountUsd - USD amount as a decimal string, e.g. "5.00", required
   * @param waitMs - max ms to wait for the receipt, optional (default 30000)
   * @example tools/call request body:
   * @example { "name": "pons_pay", "arguments": { "payTo": "0x…", "amountUsd": "2.50" } }
   */
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
  /**
   * pons_pay_resource — Fetch a 402-gated resource, parse its price, settle exactly that price with policy checks. Requires PONSMCP_PRIVATE_KEY.
   *
   * @param url - http(s) URL of the 402-gated resource, required
   * @param waitMs - max ms to wait for the receipt, optional (default 30000)
   * @example tools/call request body:
   * @example { "name": "pons_pay_resource", "arguments": { "url": "https://api.example.com/brief" } }
   */
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
  /**
   * pons_tx_status — Look up a transaction receipt: status, block, gas, decoded ERC-20 transfers.
   *
   * @param txHash - transaction hash (0x…, 64 hex), required
   * @example tools/call request body:
   * @example { "name": "pons_tx_status", "arguments": { "txHash": "0x…" } }
   */
  {
    name: 'pons_tx_status',
    description: 'Look up a transaction receipt on Robinhood Chain: status, block, gas used, and decoded ERC-20 transfers.',
    inputSchema: {
      type: 'object',
      properties: { txHash: { type: 'string', description: 'Transaction hash (0x...)' } },
      required: ['txHash'],
    },
  },
  // ── x402 compatibility ─────────────────────────────────────────────────────
  /**
   * x402_fetch — Fetch any URL with x402 auto-settlement: on a 402 with an X-PAYMENT requirement, pay exactly that price (policy-checked) and retry with the signed proof header. Requires PONSMCP_PRIVATE_KEY.
   *
   * @param url - http(s) URL to fetch, required
   * @param waitMs - max ms to wait for the settlement receipt, optional (default 30000)
   * @example tools/call request body:
   * @example { "name": "x402_fetch", "arguments": { "url": "https://api.example.com/premium-data" } }
   */
  {
    name: 'x402_fetch',
    description: 'Fetch any URL with x402 (HTTP 402) auto-settlement: if the server answers 402 PAYMENT-REQUIRED with an X-PAYMENT requirement, pays the exact price in USDG on Robinhood Chain via policy-checked payment, then retries the request with the signed X-PAYMENT proof header attached and returns the final response. Requires PONSMCP_PRIVATE_KEY env.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL to fetch' },
        waitMs: { type: 'number', description: 'Max ms to wait for the settlement receipt (default 30000)' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  /**
   * x402_discover — Probe a domain for x402 paid resources via /.well-known/x402 and /api/x402/manifest. Read-only.
   *
   * @param domain - domain to probe, e.g. "api.example.com", required
   * @example tools/call request body:
   * @example { "name": "x402_discover", "arguments": { "domain": "api.example.com" } }
   */
  {
    name: 'x402_discover',
    description: 'Probe a domain for x402 paid resources: checks /.well-known/x402 and /api/x402/manifest and returns the paid resources found with prices, recipients, and descriptions. Read-only — nothing is paid.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain to probe, e.g. "api.example.com" (scheme optional)' },
      },
      required: ['domain'],
      additionalProperties: false,
    },
  },
  // ── Stock tokens ─────────────────────────────────────────────────────────
  /**
   * pons_stocks_list — All 19 tokenized stock tokens on Robinhood Chain with contract addresses.
   *
   * @param none - this tool takes no arguments
   * @example tools/call request body:
   * @example { "name": "pons_stocks_list", "arguments": {} }
   */
  {
    name: 'pons_stocks_list',
    description: 'List all 19 Robinhood Chain tokenized stock tokens with their on-chain contract addresses. These are tokenized debt securities, not equity shares.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  /**
   * pons_stock_price — Live DEX price, liquidity, and 24h change for a stock token.
   *
   * @param ticker - stock ticker (e.g. NVDA) or 0x contract address, required
   * @example tools/call request body:
   * @example { "name": "pons_stock_price", "arguments": { "ticker": "NVDA" } }
   */
  {
    name: 'pons_stock_price',
    description: 'Get live DEX price, liquidity, and 24h change for a Robinhood Chain stock token. Pass a ticker (NVDA, AAPL, TSLA…) or the contract address.',
    inputSchema: {
      type: 'object',
      properties: { ticker: { type: 'string', description: 'Stock ticker (e.g. NVDA) or 0x address' } },
      required: ['ticker'], additionalProperties: false,
    },
  },
  /**
   * pons_stock_info — On-chain metadata (name, symbol, supply) for a stock token.
   *
   * @param ticker - stock ticker (e.g. NVDA) or 0x contract address, required
   * @example tools/call request body:
   * @example { "name": "pons_stock_info", "arguments": { "ticker": "NVDA" } }
   */
  {
    name: 'pons_stock_info',
    description: 'Read on-chain metadata (name, symbol, total supply) for a Robinhood Chain stock token. Pass ticker or address.',
    inputSchema: {
      type: 'object',
      properties: { ticker: { type: 'string', description: 'Stock ticker (e.g. NVDA) or 0x address' } },
      required: ['ticker'], additionalProperties: false,
    },
  },
  /**
   * pons_stocks_screen — Screen all 19 stock tokens with live DEX data; filter and rank. Slow (batch DexScreener).
   *
   * @param minLiquidityUsd - minimum liquidity filter in USD, optional (default 0)
   * @param gradeA - only return Grade A tokens (liq>$500, change>-50%), optional
   * @example tools/call request body:
   * @example { "name": "pons_stocks_screen", "arguments": { "gradeA": true } }
   */
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
  /**
   * pons_graduated_launches — pons v1 launches that have graduated (reached their liquidity threshold).
   *
   * @param limit - max feed entries to scan, optional (default 20, max 50)
   * @example tools/call request body:
   * @example { "name": "pons_graduated_launches", "arguments": { "limit": 20 } }
   */
  {
    name: 'pons_graduated_launches',
    description: 'Return pons v1 launches that have graduated (reached their liquidity threshold). Pulls the launch feed then filters by graduation status.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max results (default 20)' } },
      additionalProperties: false,
    },
  },
  /**
   * pons_launch_ranking — Rank recent launches by graduation, liquidity, or 24h change with signal tiers.
   *
   * @param limit - launches to fetch from the feed before ranking, optional (default 20, max 50)
   * @param sortBy - "graduation" | "liquidity" | "change24h", optional (default graduation)
   * @example tools/call request body:
   * @example { "name": "pons_launch_ranking", "arguments": { "limit": 20, "sortBy": "graduation" } }
   */
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
  /**
   * pons_send_token — Send any ERC-20 token on Robinhood Chain with policy caps. Requires PONSMCP_PRIVATE_KEY.
   *
   * @param to - recipient address (0x…), required
   * @param token - token address or ticker (USDG, PONS, NVDA, …), required
   * @param amount - human decimal amount, e.g. "5.00", required
   * @param waitMs - max ms to wait for the receipt, optional (default 30000)
   * @example tools/call request body:
   * @example { "name": "pons_send_token", "arguments": { "to": "0x…", "token": "USDG", "amount": "5.00" } }
   */
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
  /**
   * pons_send_eth — Send native ETH (gas token) on Robinhood Chain. Caps: 0.01 ETH/tx, 0.1 ETH/day. Requires PONSMCP_PRIVATE_KEY.
   *
   * @param to - recipient address (0x…), required
   * @param amountEth - ETH amount as a decimal string, e.g. "0.001", required
   * @param waitMs - max ms to wait for the receipt, optional (default 30000, clamped 120000)
   * @example tools/call request body:
   * @example { "name": "pons_send_eth", "arguments": { "to": "0x…", "amountEth": "0.001" } }
   */
  {
    name: 'pons_send_eth',
    description: 'Send native ETH (gas token) on Robinhood Chain. Hard cap: 0.01 ETH per transaction, 0.1 ETH per day (enforced before signing). Requires PONSMCP_PRIVATE_KEY env.',
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
  // ── Batch payment ────────────────────────────────────────────────────────
  /**
   * pons_pay_batch — Send USDG to multiple recipients sequentially with per-payment policy checks.
   *
   * @param payments - array of {payTo: string, amountUsd: string}, required
   * @param maxTotalUsd - optional cap on aggregate total (default 50)
   * @param dryRun - if true (default) return plan without broadcasting
   * @example tools/call request body:
   * @example { "name": "pons_pay_batch", "arguments": { "payments": [{"payTo":"0x...","amountUsd":"5"}], "dryRun": true } }
   */
  {
    name: 'pons_pay_batch',
    description: 'Batch USDG payment to multiple recipients — policy checks each individually, executes sequentially. dryRun defaults to true.',
    inputSchema: {
      type: 'object',
      properties: {
        payments: {
          type: 'array',
          description: 'Array of payments to execute',
          items: {
            type: 'object',
            properties: {
              payTo: { type: 'string', description: 'Recipient address (0x...)' },
              amountUsd: { type: 'string', description: 'USDG amount as decimal string, e.g. "5.00"' },
            },
            required: ['payTo', 'amountUsd'],
          },
        },
        maxTotalUsd: { type: 'number', description: 'Optional cap on aggregate total in USD (default 50)' },
        dryRun: { type: 'boolean', description: 'If true (default), return plan without broadcasting any transaction' },
      },
      required: ['payments'], additionalProperties: false,
    },
  },
  // ── x402 health probe ─────────────────────────────────────────────────────
  /**
   * x402_health — Probe a URL to check x402 payment support without paying.
   *
   * @param url - URL to probe, required
   * @example tools/call request body:
   * @example { "name": "x402_health", "arguments": { "url": "https://api.example.com/resource" } }
   */
  {
    name: 'x402_health',
    description: 'Probe a URL to check if it supports x402 payments — returns payment requirements without paying anything.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to probe for x402 payment support' },
      },
      required: ['url'], additionalProperties: false,
    },
  },
  // ── pons v2 bonding-curve trading ─────────────────────────────────────────
  /**
   * pons_buy — Buy a pons v2 launch token on the bonding curve.
   *
   * @param token - pons v2 launch-token address (0x…), required
   * @param amountEth - ETH to spend as a decimal string, e.g. '0.001', required
   * @param slippageBps - slippage tolerance in basis points, optional (default 100 = 1%)
   * @param dryRun - if true (default) simulate only; set false to broadcast, optional
   * @example { "name": "pons_buy", "arguments": { "token": "0x…", "amountEth": "0.001" } }
   */
  {
    name: 'pons_buy',
    description: 'Buy a pons v2 launch token on the bonding curve using native ETH. Quotes the trade, simulates it, then broadcasts when dryRun:false. dryRun defaults to true — set dryRun:false to broadcast. Hard cap: 0.01 ETH per transaction (ETH_MAX_PER_TX policy). Only native-ETH-quoted curves are supported. Requires PONSMCP_PRIVATE_KEY to broadcast.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'pons v2 launch-token address (0x...)' },
        amountEth: { type: 'string', description: 'ETH to spend, e.g. "0.001"' },
        slippageBps: { type: 'number', description: 'Slippage tolerance in basis points (default 100 = 1%)' },
        dryRun: { type: 'boolean', description: 'If true (default), simulate only. Set false to broadcast.' },
      },
      required: ['token', 'amountEth'], additionalProperties: false,
    },
  },
  /**
   * pons_sell — Sell pons v2 launch tokens back to the bonding curve.
   *
   * @param token - pons v2 launch-token address (0x…), required
   * @param tokenAmount - token amount as a decimal string, e.g. '1000', required
   * @param slippageBps - slippage tolerance in basis points, optional (default 100 = 1%)
   * @param dryRun - if true (default) simulate only; set false to broadcast, optional
   * @example { "name": "pons_sell", "arguments": { "token": "0x…", "tokenAmount": "1000" } }
   */
  {
    name: 'pons_sell',
    description: 'Sell pons v2 launch tokens back to the bonding curve for native ETH. Quotes the trade, simulates it, then broadcasts when dryRun:false. dryRun defaults to true — set dryRun:false to broadcast. Hard cap: expected ETH proceeds must not exceed 0.01 ETH per transaction (ETH_MAX_PER_TX policy). Requires PONSMCP_PRIVATE_KEY to broadcast.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'pons v2 launch-token address (0x...)' },
        tokenAmount: { type: 'string', description: 'Token amount to sell, e.g. "1000"' },
        slippageBps: { type: 'number', description: 'Slippage tolerance in basis points (default 100 = 1%)' },
        dryRun: { type: 'boolean', description: 'If true (default), simulate only. Set false to broadcast.' },
      },
      required: ['token', 'tokenAmount'], additionalProperties: false,
    },
  },
  /**
   * pons_scan_interesting — Score and rank pons v2 launches by interestingness.
   *
   * @param limit - max launches to return, optional (default 10)
   * @example { "name": "pons_scan_interesting", "arguments": { "limit": 10 } }
   */
  {
    name: 'pons_scan_interesting',
    description: 'Score and rank recent pons v2 launches by interestingness: graduation progress (60%) + freshness (40%). Returns launches sorted by score, highest first. Read-only — no key needed.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max launches to return (default 10, max 50)' } },
      additionalProperties: false,
    },
  },
  /**
   * pons_recent_graduations — Recent pons v2 tokens that graduated to DEX.
   *
   * @param limit - max graduations to return, optional (default 20)
   * @example { "name": "pons_recent_graduations", "arguments": { "limit": 20 } }
   */
  {
    name: 'pons_recent_graduations',
    description: 'Recent pons v2 tokens that graduated from the bonding curve to the Uniswap V4 DEX. Returns token address, position ID, amounts swept, block, and explorer link. Read-only — no key needed.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max graduations to return (default 20, max 50)' } },
      additionalProperties: false,
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
      const privKey = process.env.PONSMCP_PRIVATE_KEY;
      if (!privKey) throw new Error('PONSMCP_PRIVATE_KEY env not set — configure it in your MCP client config to use wallet tools.');
      const client = new PonsMCPClient({ privateKey: privKey });
      const token = args.token ? String(args.token) : CHAIN.usdg;
      const resolvedToken = isAddress(token) ? token : (() => {
        const up = token.toUpperCase().trim();
        if (up === 'USDG') return CHAIN.usdg;
        if (up === 'PONS') return CHAIN.pons;
        if (up === 'WETH') return CHAIN.weth;
        const s = resolveStock(up);
        if (s) return s.address;
        throw new Error(`Cannot resolve token "${token}" — pass a 0x address or ticker.`);
      })();
      const [b, sym] = await Promise.all([
        client.getBalance(resolvedToken),
        tokenSymbol(resolvedToken).catch(() => '?'),
      ]);
      const wallet = client.address;
      const result: Record<string, unknown> = {
        wallet, token: resolvedToken,
        balanceHuman: b.human, balance: b.human,  // balance = human-readable (e.g. "2.5" = 2.5 USDG)
        balanceRaw: b.raw?.toString() ?? '0',       // balanceRaw = base units (e.g. "2500000" = 2.5 USDG at 6 decimals)
        decimals: b.decimals, symbol: sym,
      };
      // Zero balance with a key present almost always means the configured key
      // belongs to a different (unfunded) wallet — say so explicitly.
      if (b.raw === 0n && wallet) {
        const short = `${wallet.slice(0, 5)}...${wallet.slice(-4)}`;
        result.note = `Wallet ${short} has 0 ${sym === '?' ? 'USDG' : sym}. Fund this address or check PONSMCP_PRIVATE_KEY matches your funded wallet.`;
      }
      return result;
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
    // ── x402 compatibility ────────────────────────────────────────────────────
    case 'x402_fetch': {
      const url = String(args.url ?? '');
      if (!/^https?:\/\//i.test(url)) throw new Error(`invalid URL: ${url}`);
      const client = new PonsMCPClient({ privateKey: process.env.PONSMCP_PRIVATE_KEY });
      const x402 = new X402Client(client);
      return x402.fetch(url, {}, { waitMs: args.waitMs ? Number(args.waitMs) : undefined });
    }
    case 'x402_discover': {
      const domain = String(args.domain ?? '').trim();
      // Bare domain ("api.example.com"), full origin ("http://host:8080"),
      // IPv4 ("http://127.0.0.1:8080"), or localhost.
      if (!/^(https?:\/\/)?(([a-z0-9-]+\.)+[a-z]{2,}|(\d{1,3}\.){3}\d{1,3}|localhost)(:\d+)?\/?$/i.test(domain)) throw new Error(`invalid domain: ${domain}`);
      const client = new PonsMCPClient({ privateKey: process.env.PONSMCP_PRIVATE_KEY });
      const x402 = new X402Client(client);
      return x402.discover(domain);
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
      // Resolve token ticker or raw address
      let tokenAddr: string;
      if (isAddress(tokenArg)) {
        tokenAddr = tokenArg.toLowerCase();
      } else {
        const upper = tokenArg.toUpperCase().trim();
        const stock = resolveStock(upper);
        if (stock) tokenAddr = stock.address;
        else if (upper === 'USDG') tokenAddr = CHAIN.usdg;
        else if (upper === 'PONS') tokenAddr = CHAIN.pons;
        else if (upper === 'WETH') tokenAddr = CHAIN.weth;
        else throw new Error(`Cannot resolve token "${tokenArg}". Pass a 0x address or a known ticker (USDG, PONS, NVDA, TSLA, etc.).`);
      }
      const privKey = process.env.PONSMCP_PRIVATE_KEY;
      if (!privKey) throw new Error('PONSMCP_PRIVATE_KEY env not set');
      const privHex = privKey.replace(/^0x/, '');
      if (!/^[0-9a-fA-F]{64}$/.test(privHex)) throw new Error('PONSMCP_PRIVATE_KEY must be 64 hex chars');

      // Resolve decimals and convert amount without float precision loss.
      // Parse the decimal string properly: "5.00" with 18 decimals → 5_000_000_000_000_000_000n
      const dec = await tokenDecimals(tokenAddr);
      if (!/^\d+(\.\d+)?$/.test(amountStr.trim())) throw new Error(`invalid amount format '${amountStr}' — use decimal string like "5.00", not scientific notation`);
      const [whole, frac = ''] = amountStr.trim().split('.');
      const fracPadded = frac.slice(0, dec).padEnd(dec, '0');
      if (fracPadded.length > dec) throw new Error(`amount has more than ${dec} decimal places`);
      const base = BigInt(whole || '0') * (10n ** BigInt(dec)) + BigInt(fracPadded || '0');
      if (base <= 0n) throw new Error('amount must be > 0');
      // Policy guard — same caps as pons_pay (PONSMCP_MAX_PER_TX, PONSMCP_DAILY_LIMIT)
      const policyCheckSend = sharedPolicy.check(base / (10n ** BigInt(Math.max(0, dec - 6))));
      if (!policyCheckSend.allowed) throw new Error(`policy rejected: ${policyCheckSend.reason}`);

      // Use already-imported rpc / erc20TransferData / signTransaction
      const { signTransaction } = await import('./crypto.js');
      const senderAddr = '0x' + (await import('./crypto.js').then(m => m.privateKeyToAddress(BigInt('0x' + privHex)).slice(2)));
      const [nonce, gp] = await Promise.all([
        rpc<string>('eth_getTransactionCount', [senderAddr, 'pending']).then(hexToBigInt),
        rpc<string>('eth_gasPrice', []).then(hexToBigInt),
      ]);
      const gasPrice = gp > 100_000_000n ? (gp * 3n) / 2n : 100_000_000n;
      const data = Buffer.from(erc20TransferData(to, base).slice(2), 'hex');
      const tx = { nonce, gasPrice, gas: 80_000n, to: tokenAddr, value: 0n, data, chainId: CHAIN.chainId };
      const raw = signTransaction(tx, BigInt('0x' + privHex));
      const txHash = await rpc<string>('eth_sendRawTransaction', ['0x' + Buffer.from(raw).toString('hex')]);
      const waitMs = args.waitMs ? Number(args.waitMs) : 30_000;
      const t0 = Date.now();
      let receipt: any = null;
      while (Date.now() - t0 < waitMs) {
        receipt = await rpc('eth_getTransactionReceipt', [txHash]);
        if (receipt) break;
        await new Promise(r => setTimeout(r, 3_000));
      }
      if (receipt?.status === '0x1') {
        sharedPolicy.record(base / (10n ** BigInt(Math.max(0, dec - 6))));
      }
      return {
        ok: receipt?.status === '0x1',
        txHash, explorer: `${CHAIN.explorer}/tx/${txHash}`,
        token: tokenAddr, to, amountHuman: amountStr, decimals: dec,
        block: receipt ? Number(hexToBigInt(receipt.blockNumber)) : null,
        gasUsed: receipt ? Number(hexToBigInt(receipt.gasUsed)) : null,
      };
    }
    case 'pons_send_eth': {
      const to = String(args.to ?? '');
      const amountEth = String(args.amountEth ?? '0');
      if (!isAddress(to)) throw new Error('Invalid recipient address');
      const privKey = process.env.PONSMCP_PRIVATE_KEY;
      if (!privKey) throw new Error('PONSMCP_PRIVATE_KEY env not set');
      const privHex = privKey.replace(/^0x/, '');
      if (!/^[0-9a-fA-F]{64}$/.test(privHex)) throw new Error('PONSMCP_PRIVATE_KEY must be 64 hex chars');
      const { signTransaction, privateKeyToAddress } = await import('./crypto.js');
      const senderAddr = '0x' + privateKeyToAddress(BigInt('0x' + privHex)).slice(2);
      // Parse ETH amount without float loss: "0.001" → 1_000_000_000_000_000n
      const [wholeE, fracE = ''] = amountEth.replace(/[^0-9.]/g, '').split('.');
      const fracE18 = fracE.slice(0, 18).padEnd(18, '0');
      const valueWei = BigInt(wholeE || '0') * 10n ** 18n + BigInt(fracE18 || '0');
      if (valueWei <= 0n) throw new Error('amountEth must be > 0');
      // ETH spending guard: 0.01 ETH max per tx, 0.1 ETH max per day (in-process, resets on restart)
      const ETH_MAX_PER_TX = 10_000_000_000_000_000n; // 0.01 ETH in wei
      const ETH_DAILY_MAX  = 100_000_000_000_000_000n; // 0.1 ETH in wei
      const ethPolicyCheck = sharedPolicy.check(valueWei / (ETH_MAX_PER_TX / (10n ** 0n)) * 10n ** 0n);
      // Simpler: direct compare without USDG conversion
      if (valueWei > ETH_MAX_PER_TX) throw new Error(`ETH amount exceeds per-tx cap of 0.01 ETH. Use PONSMCP_MAX_ETH_PER_TX to adjust.`);
      const [nonce, gp] = await Promise.all([
        rpc<string>('eth_getTransactionCount', [senderAddr, 'pending']).then(hexToBigInt),
        rpc<string>('eth_gasPrice', []).then(hexToBigInt),
      ]);
      const gasPrice = gp > 100_000_000n ? (gp * 3n) / 2n : 100_000_000n;
      const tx = { nonce, gasPrice, gas: 21_000n, to, value: valueWei, data: Buffer.alloc(0), chainId: CHAIN.chainId };
      const raw = signTransaction(tx, BigInt('0x' + privHex));
      const txHash = await rpc<string>('eth_sendRawTransaction', ['0x' + Buffer.from(raw).toString('hex')]);
      const waitMs = Math.min(args.waitMs ? Number(args.waitMs) : 30_000, 120_000); // clamped max 2 min
      const t0 = Date.now();
      let receipt: any = null;
      while (Date.now() - t0 < waitMs) {
        receipt = await rpc('eth_getTransactionReceipt', [txHash]);
        if (receipt) break;
        await new Promise(r => setTimeout(r, 3_000));
      }
      return {
        ok: receipt?.status === '0x1',
        txHash, explorer: `${CHAIN.explorer}/tx/${txHash}`,
        to, amountEth, valueWei: valueWei.toString(),
        block: receipt ? Number(hexToBigInt(receipt.blockNumber)) : null,
        gasUsed: receipt ? Number(hexToBigInt(receipt.gasUsed)) : null,
      };
    }
    // ── Batch payment ──────────────────────────────────────────────────────
    case 'pons_pay_batch': {
      const payments: Array<{ payTo: string; amountUsd: string }> = Array.isArray(args.payments) ? args.payments : [];
      if (payments.length === 0) throw new Error('payments array is empty');
      if (payments.length > 50) throw new Error(`payments array too large: ${payments.length} (max 50 per batch)`);
      const maxTotalUsd = typeof args.maxTotalUsd === 'number' ? args.maxTotalUsd : 50;
      // dryRun defaults to true — must be explicitly set to false to broadcast
      const dryRun: boolean = args.dryRun === false ? false : true;

      // Validate each payment upfront
      const USDG_DECIMALS = 6;
      const parseUsd = (str: string): bigint => {
        if (!/^\d+(\.\d+)?$/.test(str.trim())) throw new Error(`invalid amount format: '${str}'`);
        const [whole, frac = ''] = str.trim().split('.');
        const fracPadded = frac.slice(0, USDG_DECIMALS).padEnd(USDG_DECIMALS, '0');
        return BigInt(whole || '0') * (10n ** BigInt(USDG_DECIMALS)) + BigInt(fracPadded || '0');
      };

      const parsed: Array<{ payTo: string; amountUsd: string; amountBase: bigint }> = [];
      let totalBase = 0n;
      for (let i = 0; i < payments.length; i++) {
        const { payTo, amountUsd } = payments[i];
        if (!isAddress(String(payTo ?? ''))) throw new Error(`payment[${i}].payTo is not a valid address: ${payTo}`);
        const base = parseUsd(String(amountUsd ?? '0'));
        if (base <= 0n) throw new Error(`payment[${i}].amountUsd must be > 0`);
        totalBase += base;
        parsed.push({ payTo: String(payTo), amountUsd: String(amountUsd), amountBase: base });
      }

      const totalUsd = Number(totalBase) / 10 ** USDG_DECIMALS;
      if (totalUsd > maxTotalUsd) {
        throw new Error(`total ${totalUsd.toFixed(6)} USDG exceeds maxTotalUsd cap of ${maxTotalUsd}`);
      }

      // Policy check each payment individually
      const batchPolicy = new PolicyEngine();
      const policyResults: Array<{ index: number; payTo: string; amountUsd: string; allowed: boolean; reason?: string }> = [];
      for (let i = 0; i < parsed.length; i++) {
        const check = batchPolicy.check(parsed[i].amountBase);
        policyResults.push({ index: i, payTo: parsed[i].payTo, amountUsd: parsed[i].amountUsd, allowed: check.allowed, reason: check.reason });
        if (check.allowed) batchPolicy.record(parsed[i].amountBase);
      }
      const blocked = policyResults.filter(r => !r.allowed);
      if (blocked.length > 0) {
        throw new Error(`Policy rejected ${blocked.length} payment(s): ${blocked.map(b => `[${b.index}] ${b.amountUsd} USDG to ${b.payTo}: ${b.reason}`).join('; ')}`);
      }

      if (dryRun) {
        return {
          dryRun: true,
          note: 'No transactions broadcast. Set dryRun:false to execute.',
          totalUsd: totalUsd.toFixed(6),
          maxTotalUsd,
          paymentCount: parsed.length,
          plan: parsed.map((p, i) => ({ index: i, payTo: p.payTo, amountUsd: p.amountUsd, amountBase: p.amountBase.toString(), policyAllowed: policyResults[i].allowed })),
        };
      }

      // Execute each payment sequentially using pons_pay logic
      const privKey = process.env.PONSMCP_PRIVATE_KEY;
      if (!privKey) throw new Error('PONSMCP_PRIVATE_KEY env not set');
      const privHex = privKey.replace(/^0x/, '');
      if (!/^[0-9a-fA-F]{64}$/.test(privHex)) throw new Error('PONSMCP_PRIVATE_KEY must be 64 hex chars');
      const { signTransaction, privateKeyToAddress } = await import('./crypto.js');
      const senderAddr = '0x' + privateKeyToAddress(BigInt('0x' + privHex)).slice(2);

      const execPolicy = new PolicyEngine();
      const results: Array<{ index: number; payTo: string; amountUsd: string; ok: boolean; txHash?: string; explorer?: string; error?: string }> = [];
      for (let i = 0; i < parsed.length; i++) {
        const { payTo, amountUsd, amountBase } = parsed[i];
        const policyCheck = execPolicy.check(amountBase);
        if (!policyCheck.allowed) {
          results.push({ index: i, payTo, amountUsd, ok: false, error: `policy rejected: ${policyCheck.reason}` });
          continue;
        }
        try {
          const [nonce, gp] = await Promise.all([
            rpc<string>('eth_getTransactionCount', [senderAddr, 'pending']).then(hexToBigInt),
            rpc<string>('eth_gasPrice', []).then(hexToBigInt),
          ]);
          const gasPrice = gp > 100_000_000n ? (gp * 3n) / 2n : 100_000_000n;
          const data = Buffer.from(erc20TransferData(payTo, amountBase).slice(2), 'hex');
          const tx = { nonce, gasPrice, gas: 80_000n, to: CHAIN.usdg, value: 0n, data, chainId: CHAIN.chainId };
          const raw = signTransaction(tx, BigInt('0x' + privHex));
          const txHash = await rpc<string>('eth_sendRawTransaction', ['0x' + Buffer.from(raw).toString('hex')]);
          const waitMs = 30_000;
          const t0 = Date.now();
          let receipt: any = null;
          while (Date.now() - t0 < waitMs) {
            receipt = await rpc('eth_getTransactionReceipt', [txHash]);
            if (receipt) break;
            await new Promise(r => setTimeout(r, 3_000));
          }
          const ok = receipt?.status === '0x1';
          if (ok) execPolicy.record(amountBase);
          results.push({ index: i, payTo, amountUsd, ok, txHash, explorer: `${CHAIN.explorer}/tx/${txHash}` });
        } catch (e: any) {
          results.push({ index: i, payTo, amountUsd, ok: false, error: e?.message ?? String(e) });
        }
      }
      const succeeded = results.filter(r => r.ok).length;
      return {
        dryRun: false,
        paymentCount: parsed.length,
        succeeded,
        failed: parsed.length - succeeded,
        totalUsd: totalUsd.toFixed(6),
        results,
      };
    }
    // ── x402 health probe ──────────────────────────────────────────────────
    case 'x402_health': {
      const url = String(args.url ?? '');
      if (!/^https?:\/\//i.test(url)) throw new Error(`invalid URL: ${url}`);
      // SSRF guard: block private/loopback/link-local targets by hostname and literal IP
      let parsedHost = '';
      try { parsedHost = new URL(url).hostname.toLowerCase(); } catch { throw new Error(`invalid URL: ${url}`); }
      const PRIVATE_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254', 'metadata.google.internal'];
      const isPrivateIp = /^10\./.test(parsedHost) || /^192\.168\./.test(parsedHost) || /^172\.(1[6-9]|2\d|3[01])\./.test(parsedHost) || /^127\./.test(parsedHost) || /^169\.254\./.test(parsedHost) || parsedHost.endsWith('.internal') || parsedHost.endsWith('.local');
      if (PRIVATE_HOSTS.includes(parsedHost) || isPrivateIp) {
        throw new Error(`blocked: ${parsedHost} is a private/internal address (SSRF protection)`);
      }
      const TIMEOUT_MS = 8_000;
      const fetchWithTimeout = async (fetchUrl: string, method: string): Promise<{ status: number; headers: Record<string, string> }> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const res = await fetch(fetchUrl, { method, signal: controller.signal, redirect: 'manual' });
          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
          return { status: res.status, headers };
        } finally {
          clearTimeout(timer);
        }
      };

      let probe: { status: number; headers: Record<string, string> };
      try {
        probe = await fetchWithTimeout(url, 'HEAD');
      } catch {
        try {
          probe = await fetchWithTimeout(url, 'GET');
        } catch (e: any) {
          return { supported: false, reason: `request failed: ${e?.message ?? String(e)}` };
        }
      }

      if (probe.status === 200) {
        return { supported: false, reason: 'no payment required (200 OK)' };
      }

      if (probe.status === 402) {
        // Look for x402 payment header (X-PAYMENT or X-Payment-Required or www-authenticate: x402)
        const xPayment = probe.headers['x-payment'] ?? probe.headers['x-payment-required'] ?? null;
        const wwwAuth = probe.headers['www-authenticate'] ?? '';
        const isX402 = xPayment !== null || wwwAuth.toLowerCase().includes('x402');
        if (!isX402) {
          return { supported: false, reason: '402 but no x402 payment header found (may be a standard HTTP 402)' };
        }
        // Try to parse payment details from the header
        let scheme: string | null = null;
        let network: string | null = null;
        let maxAmountRequired: string | null = null;
        let payTo: string | null = null;
        let description: string | null = null;
        if (xPayment) {
          try {
            const parsed = JSON.parse(xPayment);
            scheme = parsed.scheme ?? parsed.type ?? null;
            network = parsed.network ?? parsed.chainId ?? null;
            maxAmountRequired = parsed.maxAmountRequired ?? parsed.amount ?? null;
            payTo = parsed.payTo ?? parsed.recipient ?? null;
            description = parsed.description ?? null;
          } catch {
            // header present but not JSON — still x402-like
            scheme = 'unknown';
          }
        }
        if (wwwAuth.toLowerCase().includes('x402') && !scheme) {
          scheme = 'x402';
          const networkMatch = wwwAuth.match(/network="?([^",\s]+)"?/i);
          if (networkMatch) network = networkMatch[1];
        }
        return { supported: true, scheme, network, maxAmountRequired, payTo, description };
      }

      return { supported: false, reason: `unexpected HTTP status ${probe.status}` };
    }
    // ── pons v2 bonding-curve trading ──────────────────────────────────────
    case 'pons_buy': {
      const tokenArg = String(args.token ?? '');
      const amountEthArg = String(args.amountEth ?? '0');
      const slippageBps = BigInt(Math.max(0, Math.min(5000, Number(args.slippageBps ?? 100))));
      const dryRun = args.dryRun !== false; // default true

      if (!isAddress(tokenArg)) throw new Error('Invalid token address');

      // Parse amountEth → wei using BigInt only (no float)
      const [whB, frB = ''] = amountEthArg.replace(/[^0-9.]/g, '').split('.');
      const frB18 = frB.slice(0, 18).padEnd(18, '0');
      const amountWei = BigInt(whB || '0') * 10n ** 18n + BigInt(frB18 || '0');
      if (amountWei <= 0n) throw new Error('amountEth must be > 0');

      // Policy guard: hard cap 0.01 ETH per tx (ETH_MAX_PER_TX)
      const ETH_MAX_BUY = 10_000_000_000_000_000n; // 0.01 ETH in wei
      if (amountWei > ETH_MAX_BUY) throw new Error('amountEth exceeds per-tx cap of 0.01 ETH (ETH_MAX_PER_TX policy)');

      // ABI helpers — zero-dep hex encoding
      const w64 = (v: bigint) => v.toString(16).padStart(64, '0');
      const aAddr = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

      // getLaunchedToken(address) = 0x3cf28b5a — read curve from factory
      const ltRet = await ethCall(PONS_V2_FACTORY, '0x3cf28b5a' + aAddr(tokenArg));
      const ltWords = (ltRet.replace(/^0x/, '').match(/.{64}/g) ?? []);
      // Official struct layout (verified vs official pons.ts decodeLaunchedToken):
      // w[0]=token w[1]=curve w[2]=deployer w[3]=creatorFeeRecipient w[4]=pairToken
      // w[5]=graduationThreshold ... w[14]=exists
      const curveAddr = '0x' + (ltWords[1] ?? '').slice(-40);
      const ltExists = BigInt('0x' + (ltWords[14] ?? '0')) !== 0n;
      if (!ltExists) throw new Error(`Token ${tokenArg} is not a registered pons v2 launch`);
      if (!isAddress(curveAddr) || curveAddr === '0x0000000000000000000000000000000000000000') {
        throw new Error(`Could not read curve address for token ${tokenArg}`);
      }

      // Read curve state in parallel
      const [resRet, feeBpsRet, creatorTaxRet, reservedRet, isNativeRet, graduatedRet, readyRet] = await Promise.all([
        ethCall(curveAddr, '0x0902f1ac'), // getReserves() → [quoteReserve, tokenReserve]
        ethCall(curveAddr, '0x24a9d853'), // feeBps()
        ethCall(curveAddr, '0xc1bb8901'), // creatorTaxBps()
        ethCall(curveAddr, '0x15a55347'), // reservedTokens()
        ethCall(curveAddr, '0xdc08e094'), // isNativeQuote()
        ethCall(curveAddr, '0xe7c2b772'), // graduated()
        ethCall(curveAddr, '0xc68360a5'), // readyToGraduate()
      ]);
      const rw = (resRet.replace(/^0x/, '').match(/.{64}/g) ?? []);
      const quoteReserve = BigInt('0x' + (rw[0] || '0'));
      const tokenReserve = BigInt('0x' + (rw[1] || '0'));
      const feeBps = BigInt('0x' + (feeBpsRet.replace(/^0x/, '') || '0'));
      const creatorTaxBps = BigInt('0x' + (creatorTaxRet.replace(/^0x/, '') || '0'));
      const reservedTokens = BigInt('0x' + (reservedRet.replace(/^0x/, '') || '0'));
      const isNativeQuote = BigInt('0x' + (isNativeRet.replace(/^0x/, '') || '0')) !== 0n;
      const graduated = BigInt('0x' + (graduatedRet.replace(/^0x/, '') || '0')) !== 0n;
      const readyToGraduate = BigInt('0x' + (readyRet.replace(/^0x/, '') || '0')) !== 0n;

      if (graduated) throw new Error(`Curve has graduated — trade via the Uniswap V4 pool`);
      if (readyToGraduate) throw new Error(`Curve is ready to graduate and has stopped trading — call pons_graduate, then trade via V4`);
      if (!isNativeQuote) throw new Error(`Token uses an ERC-20 pair — only native ETH curves are supported by pons_buy`);

      // Determine signer address
      const privKey = process.env.PONSMCP_PRIVATE_KEY;
      if (!dryRun && !privKey) throw new Error('PONSMCP_PRIVATE_KEY env not set — required when dryRun:false');
      let signerAddr = '0x000000000000000000000000000000000000dead';
      if (privKey) {
        const privHex = privKey.replace(/^0x/, '');
        const { privateKeyToAddress } = await import('./crypto.js');
        signerAddr = '0x' + privateKeyToAddress(BigInt('0x' + privHex)).slice(2);
      }

      // currentSnipeTaxBps(address) = 0xd7e1ef39
      const snipeRet = await ethCall(curveAddr, '0xd7e1ef39' + aAddr(signerAddr));
      const rawSnipeBps = BigInt('0x' + (snipeRet.replace(/^0x/, '') || '0'));

      // Quote buy using pure curve math
      const sellable = tokenReserve > reservedTokens ? tokenReserve - reservedTokens : 0n;
      const quoteResult = quoteBuyPure({ quoteIn: amountWei, quoteReserve, tokenReserve, sellable, feeBps, creatorTaxBps, rawSnipeBps });

      // Apply slippage to get minTokensOut
      const BPS_D = 10_000n;
      const minOut = quoteResult.tokensOut * (BPS_D - slippageBps) / BPS_D;

      // buy(uint256 amountIn, uint256 minTokensOut, address recipient) = 0x59a87bc1
      const buyCalldata = '0x59a87bc1' + w64(amountWei) + w64(minOut) + aAddr(signerAddr);

      // Simulate
      let simulation: Record<string, unknown>;
      try {
        const simOverride = { [signerAddr]: { balance: '0x' + (amountWei * 2n).toString(16) } };
        const simRet = await rpc<string>('eth_call', [
          { from: signerAddr, to: curveAddr, data: buyCalldata, value: '0x' + amountWei.toString(16) },
          'latest', simOverride,
        ]);
        simulation = { ok: true, returnData: simRet === '0x' ? undefined : simRet };
      } catch (e: any) {
        simulation = { ok: false, error: e?.message ?? String(e) };
      }

      let gasEstimate: bigint | null = null;
      try {
        const geOverride = { [signerAddr]: { balance: '0x' + (amountWei * 2n).toString(16) } };
        const ge = await rpc<string>('eth_estimateGas', [
          { from: signerAddr, to: curveAddr, data: buyCalldata, value: '0x' + amountWei.toString(16) },
          'latest', geOverride,
        ]);
        gasEstimate = hexToBigInt(ge);
      } catch { /* best-effort */ }

      const baseResult = {
        mode: dryRun ? 'dry-run' : 'broadcast',
        curve: curveAddr,
        token: tokenArg,
        amountEth: amountEthArg,
        amountWei: amountWei.toString(),
        tokensOut: quoteResult.tokensOut.toString(),
        minTokensOut: minOut.toString(),
        snipeTaxBps: Number(rawSnipeBps),
        curveFee: quoteResult.fee.toString(),
        creatorTax: quoteResult.tax.toString(),
        slippageBps: Number(slippageBps),
        simulation,
        gasEstimate: gasEstimate !== null ? gasEstimate.toString() : null,
      };

      if (dryRun) {
        return { ...baseResult, note: 'dry-run only — nothing was broadcast. Re-run with dryRun:false to send.' };
      }

      if (!(simulation as any).ok) {
        throw new Error(`Buy simulation reverted: ${(simulation as any).error} — refusing to broadcast`);
      }

      // Broadcast
      const privHex = privKey!.replace(/^0x/, '');
      const { signTransaction } = await import('./crypto.js');
      const [nonce, gp] = await Promise.all([
        rpc<string>('eth_getTransactionCount', [signerAddr, 'pending']).then(hexToBigInt),
        rpc<string>('eth_gasPrice', []).then(hexToBigInt),
      ]);
      const gasPrice = gp > 100_000_000n ? (gp * 3n) / 2n : 100_000_000n;
      const gasLimit = gasEstimate !== null ? (gasEstimate * 12n / 10n) : 200_000n;
      const buyData = Buffer.from(buyCalldata.slice(2), 'hex');
      const buyTx = { nonce, gasPrice, gas: gasLimit, to: curveAddr, value: amountWei, data: buyData, chainId: CHAIN.chainId };
      const raw = signTransaction(buyTx, BigInt('0x' + privHex));
      const txHash = await rpc<string>('eth_sendRawTransaction', ['0x' + Buffer.from(raw).toString('hex')]);
      const waitMs = 30_000;
      const t0b = Date.now();
      let receipt: any = null;
      while (Date.now() - t0b < waitMs) {
        receipt = await rpc('eth_getTransactionReceipt', [txHash]);
        if (receipt) break;
        await new Promise(r => setTimeout(r, 3_000));
      }
      return {
        ...baseResult,
        txHash,
        explorer: `${CHAIN.explorer}/tx/${txHash}`,
        ok: receipt?.status === '0x1',
        block: receipt ? Number(hexToBigInt(receipt.blockNumber)) : null,
        gasUsed: receipt ? Number(hexToBigInt(receipt.gasUsed)) : null,
      };
    }
    case 'pons_sell': {
      const tokenArg = String(args.token ?? '');
      const tokenAmountArg = String(args.tokenAmount ?? '0');
      const slippageBps = BigInt(Math.max(0, Math.min(5000, Number(args.slippageBps ?? 100))));
      const dryRun = args.dryRun !== false; // default true

      if (!isAddress(tokenArg)) throw new Error('Invalid token address');

      const w64 = (v: bigint) => v.toString(16).padStart(64, '0');
      const aAddr = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

      // Look up curve via factory
      const ltRet = await ethCall(PONS_V2_FACTORY, '0x3cf28b5a' + aAddr(tokenArg));
      const ltWords = (ltRet.replace(/^0x/, '').match(/.{64}/g) ?? []);
      const curveAddr = '0x' + (ltWords[1] ?? '').slice(-40);
      const ltExists = BigInt('0x' + (ltWords[14] ?? '0')) !== 0n;
      if (!ltExists) throw new Error(`Token ${tokenArg} is not a registered pons v2 launch`);
      if (!isAddress(curveAddr) || curveAddr === '0x0000000000000000000000000000000000000000') {
        throw new Error(`Could not read curve address for token ${tokenArg}`);
      }

      // Get token decimals to parse tokenAmount
      const dec = await tokenDecimals(tokenArg).catch(() => 18);

      // Parse tokenAmount using BigInt only (no float)
      if (!/^\d+(\.\d+)?$/.test(tokenAmountArg.trim())) throw new Error(`invalid tokenAmount format '${tokenAmountArg}' — use decimal string, not scientific notation`);
      const [whTok, frTok = ''] = tokenAmountArg.trim().split('.');
      const frTokPad = frTok.slice(0, dec).padEnd(dec, '0');
      const tokensIn = BigInt(whTok || '0') * 10n ** BigInt(dec) + BigInt(frTokPad || '0');
      if (tokensIn <= 0n) throw new Error('tokenAmount must be > 0');

      // Read curve state
      const [resRet, feeBpsRet, creatorTaxRet, readyRet, graduatedRet] = await Promise.all([
        ethCall(curveAddr, '0x0902f1ac'), // getReserves()
        ethCall(curveAddr, '0x24a9d853'), // feeBps()
        ethCall(curveAddr, '0xc1bb8901'), // creatorTaxBps()
        ethCall(curveAddr, '0xc68360a5'), // readyToGraduate()
        ethCall(curveAddr, '0xe7c2b772'), // graduated()
      ]);
      const rw = (resRet.replace(/^0x/, '').match(/.{64}/g) ?? []);
      const quoteReserve = BigInt('0x' + (rw[0] || '0'));
      const tokenReserve = BigInt('0x' + (rw[1] || '0'));
      const feeBps = BigInt('0x' + (feeBpsRet.replace(/^0x/, '') || '0'));
      const creatorTaxBps = BigInt('0x' + (creatorTaxRet.replace(/^0x/, '') || '0'));
      const readyToGraduate = BigInt('0x' + (readyRet.replace(/^0x/, '') || '0')) !== 0n;
      const graduated = BigInt('0x' + (graduatedRet.replace(/^0x/, '') || '0')) !== 0n;
      if (graduated) throw new Error('Curve has graduated — trade via the Uniswap V4 pool');
      if (readyToGraduate) throw new Error('Curve is ready to graduate and has stopped trading — call pons_graduate, then sell via V4');

      // Quote sell using pure curve math
      const sellResult = quoteSellPure({ tokensIn, quoteReserve, tokenReserve, feeBps, creatorTaxBps });

      // Policy guard: ETH_MAX_PER_TX on expected proceeds
      const ETH_MAX_SELL = 10_000_000_000_000_000n; // 0.01 ETH
      if (sellResult.netQuote > ETH_MAX_SELL) throw new Error('Expected ETH proceeds exceed per-tx cap of 0.01 ETH (ETH_MAX_PER_TX policy)');

      const BPS_D = 10_000n;
      const minQuoteOut = sellResult.netQuote * (BPS_D - slippageBps) / BPS_D;

      // Determine signer
      const privKey = process.env.PONSMCP_PRIVATE_KEY;
      if (!dryRun && !privKey) throw new Error('PONSMCP_PRIVATE_KEY env not set — required when dryRun:false');
      let signerAddr = '0x000000000000000000000000000000000000dead';
      if (privKey) {
        const privHex = privKey.replace(/^0x/, '');
        const { privateKeyToAddress } = await import('./crypto.js');
        signerAddr = '0x' + privateKeyToAddress(BigInt('0x' + privHex)).slice(2);
      }

      // Check allowance: allowance(address,address) = 0xdd62ed3e
      const allowRet = await ethCall(tokenArg, '0xdd62ed3e' + aAddr(signerAddr) + aAddr(curveAddr));
      const currentAllowance = BigInt('0x' + (allowRet.replace(/^0x/, '') || '0'));
      const needsApproval = currentAllowance < tokensIn;

      // approve(address,uint256) = 0x095ea7b3
      const approveCalldata = '0x095ea7b3' + aAddr(curveAddr) + w64(tokensIn);
      // sell(uint256,uint256,address) = 0xd04c6983
      const sellCalldata = '0xd04c6983' + w64(tokensIn) + w64(minQuoteOut) + aAddr(signerAddr);

      // Simulate sell
      let simulation: Record<string, unknown>;
      try {
        const simRet = await rpc<string>('eth_call', [
          { from: signerAddr, to: curveAddr, data: sellCalldata, value: '0x0' },
          'latest',
        ]);
        simulation = { ok: true, returnData: simRet === '0x' ? undefined : simRet };
      } catch (e: any) {
        simulation = { ok: false, error: e?.message ?? String(e) };
      }

      const baseResult = {
        mode: dryRun ? 'dry-run' : 'broadcast',
        curve: curveAddr,
        token: tokenArg,
        tokenAmount: tokenAmountArg,
        tokensIn: tokensIn.toString(),
        quoteOut: sellResult.quoteOut.toString(),
        netQuoteOut: sellResult.netQuote.toString(),
        minQuoteOut: minQuoteOut.toString(),
        curveFee: sellResult.fee.toString(),
        creatorTax: sellResult.tax.toString(),
        slippageBps: Number(slippageBps),
        needsApproval,
        simulation,
      };

      if (dryRun) {
        return { ...baseResult, note: 'dry-run only — nothing was broadcast. Re-run with dryRun:false to send.' };
      }

      if (!(simulation as any).ok && !needsApproval) {
        throw new Error(`Sell simulation reverted: ${(simulation as any).error} — refusing to broadcast`);
      }

      const privHex = privKey!.replace(/^0x/, '');
      const { signTransaction } = await import('./crypto.js');
      const [nonce, gp] = await Promise.all([
        rpc<string>('eth_getTransactionCount', [signerAddr, 'pending']).then(hexToBigInt),
        rpc<string>('eth_gasPrice', []).then(hexToBigInt),
      ]);
      const gasPrice = gp > 100_000_000n ? (gp * 3n) / 2n : 100_000_000n;

      let approveTxHash: string | undefined;
      let currentNonce = nonce;

      if (needsApproval) {
        const approveData = Buffer.from(approveCalldata.slice(2), 'hex');
        const approveTx = { nonce: currentNonce, gasPrice, gas: 80_000n, to: tokenArg, value: 0n, data: approveData, chainId: CHAIN.chainId };
        const approveRaw = signTransaction(approveTx, BigInt('0x' + privHex));
        approveTxHash = await rpc<string>('eth_sendRawTransaction', ['0x' + Buffer.from(approveRaw).toString('hex')]);
        // Wait for approval to mine before submitting sell
        const t0a = Date.now();
        while (Date.now() - t0a < 20_000) {
          const r = await rpc('eth_getTransactionReceipt', [approveTxHash]);
          if (r) break;
          await new Promise(r => setTimeout(r, 2_000));
        }
        currentNonce = nonce + 1n;
      }

      const sellData = Buffer.from(sellCalldata.slice(2), 'hex');
      const sellTx = { nonce: currentNonce, gasPrice, gas: 150_000n, to: curveAddr, value: 0n, data: sellData, chainId: CHAIN.chainId };
      const sellRaw = signTransaction(sellTx, BigInt('0x' + privHex));
      const txHash = await rpc<string>('eth_sendRawTransaction', ['0x' + Buffer.from(sellRaw).toString('hex')]);

      const t0s = Date.now();
      let receipt: any = null;
      while (Date.now() - t0s < 30_000) {
        receipt = await rpc('eth_getTransactionReceipt', [txHash]);
        if (receipt) break;
        await new Promise(r => setTimeout(r, 3_000));
      }
      return {
        ...baseResult,
        txHash,
        ...(approveTxHash ? { approveTxHash } : {}),
        explorer: `${CHAIN.explorer}/tx/${txHash}`,
        ok: receipt?.status === '0x1',
        block: receipt ? Number(hexToBigInt(receipt.blockNumber)) : null,
        gasUsed: receipt ? Number(hexToBigInt(receipt.gasUsed)) : null,
      };
    }
    case 'pons_scan_interesting': {
      const limit = Math.min(50, Math.max(1, Number(args.limit ?? 10)));

      // Scan recent TokenLaunched events on the v2 factory
      const latestHex = await rpc<string>('eth_blockNumber', []);
      const latest = hexToBigInt(latestHex);
      const lookback = 20_000n;
      const fromBlock = latest > lookback ? latest - lookback : 0n;

      // TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)
      // topic: 0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607
      const tokenLaunchedTopic = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607';

      type RawLog = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string };
      let logs: RawLog[] = [];
      try {
        logs = await rpc<RawLog[]>('eth_getLogs', [{
          address: PONS_V2_FACTORY,
          topics: [tokenLaunchedTopic],
          fromBlock: '0x' + fromBlock.toString(16),
          toBlock: latestHex,
        }]);
      } catch { /* network failure — return empty */ }

      // Re-filter client-side (invariant: address + topic[0])
      logs = logs.filter(l =>
        l.address.toLowerCase() === PONS_V2_FACTORY.toLowerCase() &&
        l.topics[0]?.toLowerCase() === tokenLaunchedTopic.toLowerCase()
      );

      // Decode TokenLaunched entries (most recent first)
      const aAddr = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
      const launches = logs.map(log => {
        const dw = (log.data.replace(/^0x/, '').match(/.{64}/g) ?? []);
        return {
          token: '0x' + (log.topics[1] ?? '').slice(-40),
          curve: '0x' + (log.topics[2] ?? '').slice(-40),
          deployer: '0x' + (log.topics[3] ?? '').slice(-40),
          pairToken: '0x' + (dw[0] ?? '').slice(-40),
          blockNum: Number(BigInt(log.blockNumber ?? '0x0')),
          transactionHash: log.transactionHash,
        };
      }).reverse();

      // Score each candidate: fetch curve state in parallel, limit to 3x candidates
      const candidates = launches.slice(0, limit * 3);
      const nowSec = Math.floor(Date.now() / 1000);
      const scored: Array<Record<string, unknown>> = [];

      await Promise.all(candidates.map(async (launch) => {
        try {
          const [realQRet, gradThreshRet, launchedAtRet, graduatedRet] = await Promise.all([
            ethCall(launch.curve, '0x4f1f58fd').catch(() => '0x'), // realQuoteReserve()
            ethCall(launch.curve, '0x8b0bc501').catch(() => '0x'), // graduationThreshold()
            ethCall(launch.curve, '0xbf56b371').catch(() => '0x'), // launchedAt()
            ethCall(launch.curve, '0xe7c2b772').catch(() => '0x'), // graduated()
          ]);
          const realQuoteReserve = BigInt('0x' + (realQRet.replace(/^0x/, '') || '0'));
          const graduationThreshold = BigInt('0x' + (gradThreshRet.replace(/^0x/, '') || '0'));
          const launchedAt = Number(BigInt('0x' + (launchedAtRet.replace(/^0x/, '') || '0')));
          const graduated = BigInt('0x' + (graduatedRet.replace(/^0x/, '') || '0')) !== 0n;
          if (graduated) return; // exclude already-graduated tokens

          const ageSeconds = launchedAt > 0 ? Math.max(0, nowSec - launchedAt) : 0;
          const ageHours = ageSeconds / 3600;
          const graduationPct = graduationThreshold > 0n
            ? Number((realQuoteReserve * 10_000n) / graduationThreshold) / 100
            : 0;
          // Interestingness: 60% graduation progress + 40% freshness (decays over 50h)
          const gradScore = Math.min(100, graduationPct);
          const freshnessScore = Math.max(0, 100 - ageHours * 2);
          const interestScore = gradScore * 0.6 + freshnessScore * 0.4;

          scored.push({
            token: launch.token,
            curve: launch.curve,
            deployer: launch.deployer,
            pairToken: launch.pairToken,
            realQuoteReserveWei: realQuoteReserve.toString(),
            graduationThresholdWei: graduationThreshold.toString(),
            graduationPct: Math.round(graduationPct * 10) / 10,
            ageSeconds,
            ageHours: Math.round(ageHours * 10) / 10,
            launchedAt,
            blockNumber: launch.blockNum,
            interestScore: Math.round(interestScore * 10) / 10,
          });
        } catch { /* skip failed reads */ }
      }));

      scored.sort((a, b) => (b.interestScore as number) - (a.interestScore as number));

      return {
        scannedBlocks: Number(lookback),
        foundLaunches: launches.length,
        scored: scored.length,
        launches: scored.slice(0, limit),
        note: 'Interest score = 60% graduation progress + 40% freshness (freshness decays to 0 after ~50 hours)',
      };
    }
    case 'pons_recent_graduations': {
      const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20)));

      const latestHex = await rpc<string>('eth_blockNumber', []);
      const latest = hexToBigInt(latestHex);
      const lookback = 50_000n;
      const fromBlock = latest > lookback ? latest - lookback : 0n;

      // PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)
      // topic: 0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259
      const poolGraduatedTopic = '0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259';

      type RawLog = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string };
      let logs: RawLog[] = [];
      try {
        logs = await rpc<RawLog[]>('eth_getLogs', [{
          address: PONS_V2_FACTORY,
          topics: [poolGraduatedTopic],
          fromBlock: '0x' + fromBlock.toString(16),
          toBlock: latestHex,
        }]);
      } catch { /* network failure — return empty */ }

      // Re-filter client-side (address + topic[0])
      logs = logs.filter(l =>
        l.address.toLowerCase() === PONS_V2_FACTORY.toLowerCase() &&
        l.topics[0]?.toLowerCase() === poolGraduatedTopic.toLowerCase()
      );

      // Decode graduation events (most recent first)
      const graduations = logs.slice(-limit).reverse().map(log => {
        const dw = (log.data.replace(/^0x/, '').match(/.{64}/g) ?? []);
        return {
          token: '0x' + (log.topics[1] ?? '').slice(-40),
          positionId: BigInt('0x' + (dw[0] ?? '0')).toString(),
          tokenAmount: BigInt('0x' + (dw[1] ?? '0')).toString(),
          pairTokenAmount: BigInt('0x' + (dw[2] ?? '0')).toString(),
          blockNumber: Number(BigInt(log.blockNumber ?? '0x0')),
          transactionHash: log.transactionHash,
          explorer: `${CHAIN.explorer}/tx/${log.transactionHash}`,
        };
      });

      return {
        scannedFromBlock: Number(fromBlock),
        scannedToBlock: Number(latest),
        count: graduations.length,
        graduations,
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
