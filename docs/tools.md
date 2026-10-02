# Tool reference

PonsMCP currently exposes fourteen MCP tools.

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
| `pons_pay_resource` | `url`, optional `waitMs` | fetch a 402 resource, parse the price, settle exactly that price; requires private key |
| `pons_v2_launch` | `token` | pons v2 factory launch record (deployer, paired token, pool fee) |
| `pons_v2_snipe_tax` | `curve`, `recipient` | decaying opening snipe tax in bps for a specific recipient |
| `pons_v2_quote_buy` | reserve/fee inputs | pure curve buy quote: tokens out, fee, tax, refund |
| `pons_v2_quote_sell` | reserve/fee inputs | pure curve sell quote: gross, fee, tax, net |
| `pons_escrow_balance` | `recipient` | claimable native fees on the v2 fee escrow |
| `pons_escrow_token_balance` | `recipient`, `token` | claimable ERC-20 fees (quote asset / buyback vest) |
| `pons_launch_feed` | optional `limit` | recent pons launches from the official feed |
| `pons_tx_status` | `txHash` | receipt state and decoded ERC-20 transfers |

## Input validation

Token and recipient addresses must be a `0x` prefixed 40-hex-character EVM address. Transaction hashes must be `0x` plus 64 hex characters. Calls with invalid identifiers fail before chain work begins.

## Read tools versus write tools

`pons_pay` is the only payment-writing tool. A quote does not reserve funds or approve anything. A receipt lookup does not prove a transaction matches a particular merchant invoice unless the caller compares token, recipient, and amount against that invoice.
