# Settlement on Robinhood Chain

PonsMCP settles agent payments in **USDG** on **Robinhood Chain** (chain ID 4663), an Arbitrum Orbit L2. Gas is paid in ETH.

| Parameter | Value |
|---|---|
| Chain ID | 4663 |
| Settlement token | USDG — `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 decimals) |
| Gas token | ETH |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` |
| PONS reference token | `0x39dBED3a2bd333467115dE45665cC57F813C4571` |

## Why USDG for settlement

A stable, 6-decimal asset keeps payment amounts exact: a quote of 5.00 USD settles as exactly 5,000,000 base units. PONS is the ecosystem/reference token and has its own market tools, but **payment settlement is USDG** — this distinction is deliberate and documented.

## How receipts are verified

A payment is complete only when all of these hold:

1. The receipt status is `0x1`.
2. The receipt contains a `Transfer` event on the USDG contract.
3. The recipient equals the expected merchant address.
4. The transferred base units equal the quoted amount.

`pons_pay` performs checks 1–4 automatically before returning. `pons_tx_status` lets an agent or merchant re-verify at any time.
