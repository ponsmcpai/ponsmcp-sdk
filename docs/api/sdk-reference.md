# SDK API reference

## `PonsMCPClient`

Constructor options:

| Option | Type | Meaning |
|---|---|---|
| `privateKey` | `string` | 64-hex agent key; omit for read-only use |
| `rpcUrl` | `string` | override default chain-4663 endpoint |
| `policy.maxPerTx` | `bigint` | USDG base units per transaction |
| `policy.dailyLimit` | `bigint` | USDG base units per day |

### Methods

| Method | Returns | Notes |
|---|---|---|
| `quote(amountUsd)` | `{ token, symbol, amountBase, amountHuman, usd }` | pure conversion, 6 decimals |
| `pay({ payTo, amountUsd, waitMs? })` | `PayResult` | full policy → sign → broadcast → verify |
| `txStatus(hash)` | receipt state + transfers | independent re-verification |
| `getBalance(token?)` | `{ raw, human, decimals }` | needs private key |
| `tokenInfo(token)` | `{ name, symbol, decimals }` | read-only |
| `price()` | PONS market snapshot | DexScreener-backed |

### `PayResult`

```ts
{
  ok: boolean
  stage: 'policy_denied' | 'broadcast' | 'confirmed' | 'failed' | 'timeout'
  quote: { token, symbol, amountBase, amountHuman, usd }
  txHash?: string
  explorer?: string
  blockNumber?: bigint
  gasUsed?: bigint
  transfers?: Array<{ token, from, to, amountHuman }>
  error?: string
}
```

## MCP tools (9)

`pons_chain_info`, `pons_price`, `pons_launch_info`, `pons_launch_market`, `pons_token_info`, `pons_balance`, `pons_quote`, `pons_pay`, `pons_tx_status` — see the main docs site for per-tool inputs.
