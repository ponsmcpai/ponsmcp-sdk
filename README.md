# PonsMCP

> MCP server + TypeScript SDK: autonomous agent payments in **USDG** on **Robinhood Chain** (4663), plus read-only **pons launchpad intelligence**.

[![npm](https://img.shields.io/npm/v/@ponsmcp/sdk?color=CB3837)](https://www.npmjs.com/package/@ponsmcp/sdk)
[![e2e](https://img.shields.io/badge/e2e-20_passing-4ade80)](test/e2e.ts)
[![deps](https://img.shields.io/badge/runtime_deps-0-4ade80)](package.json)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![docs](https://img.shields.io/badge/docs-ponsmcp.com%2Fdocs-F97316)](https://ponsmcp.com/docs)

---

## Install

```bash
npm install -g @ponsmcp/sdk
ponsmcp        # stdio MCP server — add to Claude Desktop / Cursor / any MCP host
```

## What PONS is for here (and what it isn't)

ponsfamily.com is a **launchpad** — pons v1/v2 launch tokens on Robinhood Chain. PonsMCP gives agents **read-only intelligence** over that surface, and **separate payment rails** for everything else:

| Capability | Tools | Moves funds? |
|---|---|---|
| Launchpad research — v1 launch metadata, v2 curve quotes, snipe-tax reads, launch feed, fee-escrow balances | `pons_launch_info` `pons_v2_launch` `pons_v2_quote_buy/sell` `pons_v2_snipe_tax` `pons_launch_feed` `pons_escrow_balance` | **no** |
| Payments — USDG settlement between agent and merchant | `pons_quote` `pons_pay` `pons_pay_resource` `pons_tx_status` | **yes** |
| Market — PONS price/pairs (DexScreener) | `pons_price` `pons_launch_market` | no |

**Payment settlement is USDG, not PONS.** PONS is the ecosystem asset of the launchpad; an agent that needs to pay for a service pays in a stable. Launch-tool research (should I buy this launch? what would the tax be? what does the creator have claimable?) is a *decision layer* — the execution of any launch trade stays in your own wallet, deliberately outside this SDK.

For launch creators: `pons_escrow_balance` reads the v2 fee escrow (`balanceOf` / `balanceOfToken`) so an agent can monitor claimable creator fees. Claiming itself (`claim()` / `claimToken()` on the escrow) is a wallet action — PonsMCP never moves someone else's fees.

## Architecture

```
agent runtime (owns the key)
   │ stdio JSON-RPC (MCP)
   ▼
ponsmcp server ──── policy.ts ── caps: 100 USDG/tx, 1,000/day (checked BEFORE signing)
   │                    │
   │                 crypto.ts ── keccak · RLP · secp256k1 (low-s, CSPRNG)  [0 deps]
   │                    │
   ├─► Alchemy 4663 ───┼─► Robinhood Chain: USDG 0x5fc5…d168 (settle) · PONS 0x39dB…4571 (research)
   ├─► nodeflare ──────┘
   └─► DexScreener ── pons market data
```

## The 14 tools

| Tool | Key? | What it does |
|---|:-:|---|
| `pons_chain_info` | — | chain facts, canonical addresses |
| `pons_price` | — | PONS market snapshot |
| `pons_launch_info` | — | pons v1 launch metadata on-chain |
| `pons_launch_market` | — | live markets for a launch token |
| `pons_launch_feed` | — | recent launches (official feed) |
| `pons_v2_launch` | — | v2 factory launch record |
| `pons_v2_quote_buy` | — | pure curve buy quote (tax-capped) |
| `pons_v2_quote_sell` | — | pure curve sell quote |
| `pons_v2_snipe_tax` | — | decaying opening tax per recipient |
| `pons_escrow_balance` | — | claimable native fees (v2 escrow) |
| `pons_escrow_token_balance` | — | claimable ERC-20 fees (v2 escrow) |
| `pons_token_info` | — | ERC-20 metadata for any token |
| `pons_quote` | — | USD → USDG base units |
| `pons_pay` | ✅ | policy → sign → broadcast → verified receipt |
| `pons_pay_resource` | ✅ | fetch a 402 resource, settle the exact price |
| `pons_tx_status` | — | independent receipt verification |

## Why zero dependencies

Every line that touches a private key or builds a transaction lives in this repo: keccak-256, RLP encoding, secp256k1 signing with canonical low-s, EIP-155 replay protection. It is auditable in an afternoon, and the npm tarball is byte-identical to `src/`.

## Docs

Full manual (concepts / guides / API): **[ponsmcp.com/docs](https://ponsmcp.com/docs)** — also in [`ponsmcp-docs`](https://github.com/ponsmcpai/ponsmcp-docs).

## License

MIT
