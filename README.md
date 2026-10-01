# PonsMCP — MCP server + SDK

> Model Context Protocol server for autonomous MPP payments with **PONS** on **Robinhood Chain** (chainId 4663).

[![npm version](https://img.shields.io/npm/v/@ponsmcp/sdk)](https://www.npmjs.com/package/@ponsmcp/sdk)
[![GitHub](https://img.shields.io/badge/github-ponsmcppayment%2Fsdk-181717)](https://github.com/ponsmcppayment/sdk)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Robinhood Chain](https://img.shields.io/badge/chain-Robinhood_Chain_4663-6c47ff)](https://robinhoodchain.blockscout.com)

---

## What is this?

`@ponsmcp/sdk` ships an **MCP server** (`ponsmcp` binary) plus a TypeScript client that lets AI agents pay for services autonomously using Stripe's Machine Payments Protocol semantics — settled on-chain in **USDG** on Robinhood Chain, with the **PONS** token as the ecosystem asset.

Everything is real: live RPC calls, real ECDSA signing, real receipt verification. No mocks.

## Tools exposed to the agent

| Tool | What it does |
|------|-------------|
| `pons_chain_info` | Chain facts: RPC, chainId 4663, explorer, canonical token addresses |
| `pons_price` | Live PONS price, liquidity, top pairs (DexScreener) |
| `pons_launch_info` | Verified onchain pons v1 launch metadata, canonical pool, and social links |
| `pons_launch_market` | Live Robinhood Chain markets for a pons launch-token address |
| `pons_token_info` | On-chain ERC-20 metadata for any token |
| `pons_balance` | Agent wallet balance (USDG by default) |
| `pons_quote` | USD → USDG settlement plan (no execution) |
| `pons_pay` | **Execute** a payment: policy → transfer → receipt verification |
| `pons_tx_status` | Receipt lookup with decoded transfers |

## Quick start (as an MCP server)

```bash
npm install -g @ponsmcp/sdk

export PONSMCP_PRIVATE_KEY=0x...        # agent wallet (funded with a little ETH for gas + USDG)
export PONSMCP_MAX_PER_TX=100000000     # optional: 100 USDG cap per tx (micro-units)
export PONSMCP_DAILY_LIMIT=1000000000   # optional: 1000 USDG daily cap

ponsmcp
```

Then register in any MCP client:

```json
{
  "mcpServers": {
    "ponsmcp": {
      "command": "ponsmcp",
      "env": { "PONSMCP_PRIVATE_KEY": "0x..." }
    }
  }
}
```

## Quick start (as a library)

```ts
import { PonsMCPClient } from '@ponsmcp/sdk'

const client = new PonsMCPClient({ privateKey: process.env.PONSMCP_PRIVATE_KEY })

// Quote
const q = await client.quote('5.00')  // → 5_000_000 USDG micro-units

// Pay: policy check → ERC-20 transfer → receipt verification
const result = await client.pay({
  payTo: '0x...',
  amountUsd: '5.00',
})

console.log(result.stage)   // 'confirmed'
console.log(result.txHash)
console.log(result.explorer)
```

## Network

| Setting | Value |
|---------|-------|
| Chain | Robinhood Chain (Arbitrum Orbit L2) |
| Chain ID | `4663` |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` |
| PONS | `0x39dBED3a2bd333467115dE45665cC57F813C4571` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 decimals) |

## Safety model

- **Policy engine** — hard per-tx and daily caps (env-tunable), checked *before* any broadcast
- **Balance pre-check** — refuses to broadcast when funds are insufficient
- **Receipt verification** — a payment is "confirmed" only when the on-chain receipt is status `0x1` with the expected USDG Transfer event
- **Deterministic signing** — canonical low-s ECDSA signatures, EIP-155 replay protection (chainId 4663)

## Architecture

```
src/
├── mcp.ts         # MCP stdio server (tools/list, tools/call)
├── index.ts       # PonsMCPClient: quote → policy → sign → broadcast → verify
├── chain.ts       # Robinhood Chain JSON-RPC + ABI helpers
├── erc20.ts       # ERC-20 reads
├── dexscreener.ts # PONS / pons launch-token live market data
├── pons.ts        # pons v1 launch-token metadata + canonical pool reads
├── policy.ts      # spending-policy engine
└── crypto.ts      # keccak256 + RLP + secp256k1 (zero deps, live-tested)
```

## License

MIT — see [LICENSE](LICENSE).
