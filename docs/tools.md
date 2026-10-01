# Tool reference

PonsMCP currently exposes nine MCP tools.

| Tool | Input | Result |
|---|---|---|
| `pons_chain_info` | none | Robinhood Chain network, block height, gas price, PONS/USDG/WETH addresses |
| `pons_price` | none | PONS market snapshot and up to five deepest Robinhood Chain pairs from DexScreener |
| `pons_launch_info` | `token` | pons v1 launch metadata read from the token contract: pool, supply, logo, description, socials |
| `pons_launch_market` | `token` | live DEX pairs for a pons launch token |
| `pons_token_info` | `token` | ERC-20 name, symbol, decimals, and total supply |
| `pons_balance` | optional `token` | configured agent wallet balance; requires `PONSMCP_PRIVATE_KEY` |
| `pons_quote` | `amountUsd` | USD decimal amount converted to six-decimal USDG settlement units; no transaction |
| `pons_pay` | `payTo`, `amountUsd`, optional `waitMs` | policy decision, broadcast attempt, and receipt result; requires private key |
| `pons_tx_status` | `txHash` | receipt state and decoded ERC-20 transfers |

## Input validation

Token and recipient addresses must be a `0x` prefixed 40-hex-character EVM address. Transaction hashes must be `0x` plus 64 hex characters. Calls with invalid identifiers fail before chain work begins.

## Read tools versus write tools

`pons_pay` is the only payment-writing tool. A quote does not reserve funds or approve anything. A receipt lookup does not prove a transaction matches a particular merchant invoice unless the caller compares token, recipient, and amount against that invoice.
