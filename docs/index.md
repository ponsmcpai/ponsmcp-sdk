# PonsMCP documentation

PonsMCP is a local Model Context Protocol server and TypeScript SDK for agents operating on Robinhood Chain (chain ID `4663`). It has two distinct capability groups:

1. **pons intelligence**: read PONS market data and read self-describing pons v1 launch tokens directly onchain.
2. **payment execution**: quote USDG, apply local limits, sign from the configured agent wallet, broadcast, and inspect receipts.

## Start here

- [Installation](installation.md)
- [MCP configuration](configuration.md)
- [All nine tools](tools.md)
- [pons launch intelligence](pons-launches.md)
- [Payment lifecycle](payments.md)
- [Security model](security.md)
- [Architecture](architecture.md)
- [Troubleshooting](troubleshooting.md)

## Honest availability

- The MCP server runs locally over stdio today.
- The agent wallet private key never belongs in the browser UI.
- PonsMCP payments settle in USDG; PONS/pons market reads are separate tools.
- `$MCP` contract address, distribution, market links, and utility are **not announced**. Do not infer them from a ticker name.
- npm and GitHub publishing links will be added when official release destinations are supplied.
