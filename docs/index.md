# PonsMCP documentation

PonsMCP is a local Model Context Protocol server and TypeScript SDK for agents operating on Robinhood Chain (chain ID `4663`). It has two capability groups:

1. **pons intelligence** — read PONS market data and self-describing pons launch tokens directly onchain.
2. **payment execution** — quote USDG, apply local limits, sign from the configured agent wallet, broadcast, and inspect receipts.

## Documentation structure

```
docs/
├── concepts/
│   ├── mpp-protocol.md          # What is MPP and HTTP 402
│   ├── robinhood-settlement.md  # USDG settlement on chain 4663
│   └── agent-integration.md     # Agent payment patterns
├── guides/
│   ├── typescript-sdk.md        # Full SDK guide
│   ├── merchant-integration.md  # Accept agent payments
│   └── security.md              # Keys, policy, signing
└── api/
    ├── sdk-reference.md         # Client API
    └── intents-api.md           # Intents + merchant registry
```

## Quick links

- [What is MPP?](concepts/mpp-protocol.md)
- [Robinhood Chain settlement](concepts/robinhood-settlement.md)
- [TypeScript SDK guide](guides/typescript-sdk.md)
- [Merchant integration](guides/merchant-integration.md)
- [SDK reference](api/sdk-reference.md)
- [Payment intents API](api/intents-api.md)

## Honest availability

- The MCP server runs locally over stdio today (npm: `@ponsmcp/sdk`).
- The agent wallet private key never belongs in the browser UI.
- Payments settle in USDG; PONS/pons market reads are separate tools.
- `$MCP` contract address, distribution, market links, and utility are **not announced**. Do not infer them from a ticker name.
