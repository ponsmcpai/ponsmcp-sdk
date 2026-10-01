# pons launch intelligence

PonsMCP separates **PONS** the existing reference token from **pons** the launch protocol, and from **$MCP**, which is not announced yet.

## `pons_launch_info`

This read-only tool is designed for a pons v1 launch-token address. It calls public token getters for:

- ERC-20 name, symbol, decimals, and fixed total supply
- `logo()` and `description()`
- `liquidityPool()` — the token's canonical pool address
- `socials()` — Twitter, Telegram, Discord, website, and Farcaster fields

Names and tickers are not token identity. Use the contract address. A token that does not implement the documented pons v1 getters returns an error instead of pretending it is a pons launch.

## `pons_launch_market`

This tool accepts a token address and returns current Robinhood Chain DEX pairs. It reports the deepest available pair separately, then up to five pairs with price, liquidity, 24-hour change, and chart URL. This is market data, not an execution quote.

## `pons_price`

The PONS reference-token price tool resolves the deepest Robinhood Chain pair returned by DexScreener. It does not imply that PONS is the settlement asset. Payment settlement uses USDG.

## Protocol context

The pons documentation describes two protocol generations. PonsMCP launch metadata reads currently target self-describing **v1** tokens. Do not assume that a v2 curve or post-graduation v4 pool exposes the same token getters without checking its deployed interface.
