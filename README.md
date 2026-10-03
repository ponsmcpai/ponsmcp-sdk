# PonsMCP

> MCP server + TypeScript SDK: autonomous agent payments in **USDG** on **Robinhood Chain** (4663) or **USDC** on **Base** (8453 · beta), read-only **pons launchpad intelligence**, and **x402** paid-resource fetching — zero runtime dependencies.

[![npm](https://img.shields.io/npm/v/@ponsmcp/sdk?color=CB3837)](https://www.npmjs.com/package/@ponsmcp/sdk)
[![tests](https://img.shields.io/badge/tests-serial%20%2B%20e2e%20passing-4ade80)](test/)
[![deps](https://img.shields.io/badge/runtime_deps-0-4ade80)](package.json)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![chain](https://img.shields.io/badge/chain-robinhood%204663%20%7C%20base%208453-F97316)](https://robinhoodchain.blockscout.com)
[![docs](https://img.shields.io/badge/docs-ponsmcp.com%2Fdocs-F97316)](https://ponsmcp.com/docs)

## Multi-chain support

PonsMCP v2.3.0 supports two chains. Set `PONSMCP_CHAIN` to switch:

| Chain | ID | Settlement | Status | Notes |
|---|:-:|---|:-:|---|
| Robinhood Chain | 4663 | USDG (`0x5fc5...`) | **active** | Default; all tools fully tested |
| Base | 8453 | USDC (`0x8335...`) | **beta** | Read-only tools verified; write ops not tested on Base |

```bash
# Default — Robinhood Chain 4663, USDG
ponsmcp

# Switch to Base (beta)
PONSMCP_CHAIN=8453 ponsmcp
```

`pons_quote` always returns costs for **both** chains so agents can compare settlement options.

## Quick Start — three commands to your agent's first payment

```bash
# 1. Install (Node >= 20) and start the stdio MCP server
npm install -g @ponsmcp/sdk && ponsmcp

# 2. Give the agent a funded wallet + spending caps (env of the MCP server process)
export PONSMCP_PRIVATE_KEY=0x…            # agent key — never in a browser or repo
export PONSMCP_MAX_PER_TX=100000000       # 100 USDG per transaction (base units, 6 dec)
export PONSMCP_DAILY_LIMIT=1000000000     # 1,000 USDG per day

# 3. Call the pay tool from any MCP host (Claude Desktop, Cursor, …)
#    pons_pay { "payTo": "0xMerchant…", "amountUsd": "2.50" }
#    → policy check → USDG transfer on chain 4663 → verified receipt → 0x…
```

Point your MCP host at the server:

```json
{ "mcpServers": { "ponsmcp": { "command": "ponsmcp" } } }
```

All 21 read-only tools work with no key at all — `ponsmcp` alone is enough for market and launch research.

## What PONS is for here (and what it isn't)

ponsfamily.com is a **launchpad** — pons v1/v2 launch tokens on Robinhood Chain. PonsMCP gives agents **read-only intelligence** over that surface, and **separate payment rails** for everything else:

| Capability | Tools | Moves funds? |
|---|---|---|
| Payments — USDG settlement between agent and merchant | `pons_quote` `pons_pay` `pons_pay_resource` `pons_tx_status` `pons_balance` | **yes** |
| x402 — paid HTTP resources with auto-settlement | `x402_fetch` `x402_discover` | **on 402 only** |
| Transfers — send any ERC-20 or native ETH | `pons_send_token` `pons_send_eth` | **yes** |
| Launchpad research — v1 metadata, feed, screening | `pons_launch_info` `pons_launch_feed` `pons_graduated_launches` `pons_launch_ranking` | no |
| v2 curves — records, quotes, snipe tax, escrow | `pons_v2_launch` `pons_v2_quote_buy/sell` `pons_v2_snipe_tax` `pons_escrow_balance` `pons_escrow_token_balance` | no |
| Market — PONS price/pairs, stock tokens (DexScreener) | `pons_price` `pons_launch_market` `pons_stocks_list` `pons_stock_price` `pons_stock_info` `pons_stocks_screen` | no |

**Payment settlement is USDG, not PONS.** PONS is the ecosystem asset of the launchpad; an agent that needs to pay for a service pays in a stable. Launch-tool research (should I buy this launch? what would the tax be? what does the creator have claimable?) is a *decision layer* — the execution of any launch trade stays in your own wallet, deliberately outside this SDK.

For launch creators: `pons_escrow_balance` reads the v2 fee escrow (`balanceOf` / `balanceOfToken`) so an agent can monitor claimable creator fees. Claiming itself (`claim()` / `claimToken()` on the escrow) is a wallet action — PonsMCP never moves someone else's fees.

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ MCP host (Claude Desktop / Cursor / your agent runtime)                │
│   owns the key: PONSMCP_PRIVATE_KEY lives ONLY here                    │
└───────────────┬────────────────────────────────────────────────────────┘
                │ stdio JSON-RPC (MCP: initialize → tools/list → tools/call)
                ▼
┌────────────────────────────────────────────────────────────────────────┐
│ ponsmcp server (this package, 34 tools)                                │
│                                                                        │
│   tools/call ──► PolicyEngine ──► per-tx cap 100 USDG                  │
│                      │             daily cap 1,000 USDG                │
│                      │             (checked BEFORE any signing)        │
│                      ▼                                                 │
│                 crypto.ts ──► keccak-256 · RLP · secp256k1             │
│                      │         canonical low-s · CSPRNG nonce · 0 deps │
│                      ▼                                                 │
│                 EIP-155 legacy tx, chainId 4663, signed locally        │
└──────┬──────────────────┬──────────────────────┬───────────────────────┘
       ▼                  ▼                      ▼
  Robinhood Chain      DexScreener           HTTP + x402
  (USDG settle,        (PONS, launch           │
   ETH gas)             & stock markets)       ▼
       │                                    402 requirement → settle →
       ▼                                    retry with X-PAYMENT proof
  receipt verified: status 0x1 +
  decoded USDG transfer matches quote
```

Never puts a private key, a browser, or a third-party signer between the policy check and the broadcast.

## The 34 tools

| Tool | Key? | What it does |
|---|:-:|---|
| `pons_chains` | — | list all supported chains with status |
| `pons_chain_info` | — | active chain facts + all supported chains |
| `pons_price` | — | PONS market snapshot |
| `pons_launch_info` | — | pons v1 launch metadata on-chain |
| `pons_launch_market` | — | live markets for a launch token |
| `pons_launch_feed` | — | recent launches (official feed) |
| `pons_graduated_launches` | — | v1 launches that reached their liquidity threshold |
| `pons_launch_ranking` | — | ranked launches with Grade A / Early Watch tiers |
| `pons_v2_launch` | — | v2 factory launch record |
| `pons_v2_quote_buy` | — | pure curve buy quote (tax-capped) |
| `pons_v2_quote_sell` | — | pure curve sell quote |
| `pons_v2_snipe_tax` | — | decaying opening tax per recipient |
| `pons_escrow_balance` | — | claimable native fees (v2 escrow) |
| `pons_escrow_token_balance` | — | claimable ERC-20 fees (v2 escrow) |
| `pons_token_info` | — | ERC-20 metadata for any token |
| `pons_quote` | — | USD → settlement-token base units, both-chain comparison |
| `pons_pay` | ✅ | policy → sign → broadcast → verified receipt |
| `pons_pay_resource` | ✅ | fetch a 402 resource, settle the exact price |
| `pons_tx_status` | — | independent receipt verification |
| `x402_fetch` | ✅ | fetch any URL; auto-settle x402 402s and retry with proof |
| `x402_discover` | — | probe a domain for x402 paid resources |
| `pons_stocks_list` | — | all 19 tokenized stock tokens with addresses |
| `pons_stock_price` | — | live DEX price for a stock token (ticker or address) |
| `pons_stock_info` | — | on-chain metadata for a stock token |
| `pons_stocks_screen` | — | screen + rank all 19 stock tokens by liquidity / tier |
| `pons_balance` | ✅ | agent wallet balance for any token |
| `pons_send_token` | ✅ | send any ERC-20 (policy caps apply) |
| `pons_send_eth` | ✅ | send native ETH (0.01 ETH/tx, 0.1 ETH/day caps) |

## Why zero dependencies

Every line that touches a private key or builds a transaction lives in this repo: keccak-256, RLP encoding, secp256k1 signing with canonical low-s, EIP-155 replay protection. It is auditable in an afternoon, and the npm tarball is byte-identical to `src/`.

## FAQ

**Is my private key safe?** It lives only in the MCP server process environment (`PONSMCP_PRIVATE_KEY`). It never reaches a browser, the web console, logs, or any API request. Signing happens locally; transactions are fully built and signed before any endpoint sees them.

**What stops an agent from overspending?** The `PolicyEngine` checks a per-transaction cap (default 100 USDG) and an in-process daily budget (default 1,000 USDG) **before** every signature. Balance is pre-checked too. The daily counter resets on restart — for hard budgets, fund the agent wallet with only what it may spend. `pons_send_eth` additionally caps at 0.01 ETH per tx / 0.1 ETH per day.

**Which chain and token?** Default: Robinhood Chain, chain ID `4663` (an Arbitrum Orbit L2), settling in USDG (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals); gas is ETH. Set `PONSMCP_CHAIN=8453` to switch to Base (USDC, `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals) — Base support is **beta**: read-only tools are verified, write operations (payments, transfers) are not tested on Base.

**How do I know a payment really went through?** `pons_pay` returns `ok: true` only after verifying an on-chain receipt: status `0x1` plus the decoded USDG `Transfer` event matching the exact quote. `pons_tx_status` re-verifies any hash independently — merchants should use it rather than trusting a caller's claim.

**What is x402 support?** Agents using the x402 convention (`HTTP 402` + `X-PAYMENT` headers) can call `x402_fetch`: it fetches a URL, settles a recognized requirement exactly (policy-checked), retries with a signed proof header, and returns the payload. `x402_discover` finds paid resources on a domain. Details: [x402 compatibility](https://ponsmcp.com/docs/x402-compatibility).

**Does PonsMCP buy or sell launch tokens?** No. Curve quotes, snipe-tax reads, and escrow balances are intelligence only. Executing trades or claiming fees stays in your own wallet by design.

**Which MCP hosts work?** Anything that speaks stdio MCP: Claude Desktop, Cursor, Claude Code, and custom runtimes. Read-only tools need no configuration beyond the server command.

## Docs

Full manual (concepts / guides / API / x402): **[ponsmcp.com/docs](https://ponsmcp.com/docs)** — also in [`ponsmcp-docs`](https://github.com/ponsmcpai/ponsmcp-docs).

## License

MIT
