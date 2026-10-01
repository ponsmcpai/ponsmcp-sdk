# TypeScript SDK guide

`@ponsmcp/sdk` exposes one client class for the full payment flow.

## Install

```bash
npm install @ponsmcp/sdk
```

## Client

```ts
import { PonsMCPClient } from '@ponsmcp/sdk'

const client = new PonsMCPClient({
  privateKey: process.env.PONSMCP_PRIVATE_KEY, // optional — reads work without it
  policy: {
    maxPerTx: 100_000_000n,   // 100 USDG
    dailyLimit: 1_000_000_000n, // 1,000 USDG
  },
})
```

## Quote (no execution)

```ts
const q = await client.quote('5.00')
// { token, symbol: 'USDG', amountBase: 5000000n, amountHuman: '5', usd: '5.00' }
```

## Pay

```ts
const result = await client.pay({ payTo: '0x…', amountUsd: '5.00' })
if (result.ok) {
  console.log(result.txHash)      // 0x…
  console.log(result.explorer)    // blockscout link
  console.log(result.transfers)   // decoded USDG transfer
} else {
  console.log(result.stage, result.error) // policy_denied | failed | timeout
}
```

`pay()` runs the full sequence: policy check → balance check → EIP-155 signing (chain 4663) → broadcast → receipt wait (30 s default) → decoded transfers.

## Verify a hash later

```ts
const status = await client.txStatus('0x…')
// { found, status: 'success' | 'reverted', blockNumber, gasUsed, transfers }
```

## Read tools (no wallet needed)

`price()`, `tokenInfo()`, plus the MCP tools `pons_launch_info` / `pons_launch_market` for pons v1 tokens.
