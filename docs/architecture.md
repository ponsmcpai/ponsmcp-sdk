# Architecture

## Runtime layers

```text
MCP client
  ↕ stdio JSON-RPC
PonsMCP server (`src/mcp.ts`)
  ↕
read helpers / policy engine / signing implementation
  ↕
Robinhood Chain RPC + DexScreener market API
```

## Main modules

| Module | Responsibility |
|---|---|
| `src/mcp.ts` | MCP initialize, `tools/list`, and `tools/call` dispatch |
| `src/index.ts` | `PonsMCPClient` quote, policy, payment, receipt flow |
| `src/pons.ts` | pons v1 self-describing launch-token reads |
| `src/dexscreener.ts` | PONS and arbitrary launch-token market snapshots |
| `src/erc20.ts` | basic ERC-20 reads |
| `src/chain.ts` | JSON-RPC, ABI helper functions, transfer extraction |
| `src/policy.ts` | local payment limits |
| `src/crypto.ts` | in-repository keccak, RLP, secp256k1 signing |

## RPC behavior

The runtime uses the official public Robinhood Chain endpoint by default and can use a fallback for reads when that endpoint fails. Operators who require a particular provider should set `PONSMCP_RPC_URL` explicitly.

## Web console

The companion Pages app is a browser control surface for payment intents and receipt review. It is not a key vault and it does not sign payments in the browser.
