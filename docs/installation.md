# Installation

## Requirements

- Node.js 20 or later (the project is tested with Node 26).
- A reachable Robinhood Chain RPC endpoint. The official public endpoint is used first; the runtime also has a read fallback for availability.
- Only for `pons_balance` and `pons_pay`: an agent wallet with ETH for gas and USDG for settlement.

## Local repository

From the repository directory:

```bash
npm install
npm run build
node dist/mcp.js
```

The process uses standard input/output for JSON-RPC. Do not write logs to stdout because MCP frames also use stdout.

## npm package

The eventual package name is `@ponsmcp/sdk`. It is not represented here as a completed public release until the official npm publication occurs.

## Configure a wallet only when execution is intended

`pons_chain_info`, `pons_price`, `pons_launch_info`, `pons_launch_market`, `pons_token_info`, `pons_quote`, and `pons_tx_status` work without a private key.

Set `PONSMCP_PRIVATE_KEY` only in the MCP server process environment when the agent must read its wallet balance or execute a payment. Never put this value into a web form, frontend bundle, git repository, or chat message.
