# PONS in PonsMCP — what it's for

ponsfamily.com is a token **launchpad** on Robinhood Chain (v1 pools, v2 bonding curves graduating to locked Uniswap v4 pools). PonsMCP treats it as a research surface for agents — deliberately **read-only**.

## What agents can do

| Question an agent asks | Tool |
|---|---|
| "What is this launch token?" | `pons_launch_info`, `pons_v2_launch` |
| "What would buying cost after tax?" | `pons_v2_quote_buy` (snipe-tax-capped) |
| "What would selling return?" | `pons_v2_quote_sell` |
| "What's the opening tax for this wallet right now?" | `pons_v2_snipe_tax` |
| "What launched recently?" | `pons_launch_feed` |
| "What fees has a creator got claimable?" | `pons_escrow_balance`, `pons_escrow_token_balance` |

## What PonsMCP deliberately does not do

- **Launch tokens** — public launching on pons v2 is closed (`canLaunch` whitelist), and executing a `launchAndBuy` is a wallet decision outside this SDK.
- **Execute curve trades** — quotes and tax reads are intelligence; the buy itself stays in your wallet.
- **Claim someone's fees** — `pons_escrow_balance` shows claimable balances; `claim()` / `claimToken()` on the fee escrow (`0xd3AF…c9e`) is a wallet action by the recipient.

## Why settlement is USDG, not PONS

A payment rail needs a stable unit. PONS is the launchpad's ecosystem asset with market volatility — settling a 5.00 USD service in PONS would make pricing nondeterministic. So: **payments settle in USDG (6 decimals)**, and **PONS is what the research tools read**. Both are first-class; they just do different jobs.
