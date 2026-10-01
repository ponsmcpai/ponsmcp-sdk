# What is the Machine Payments Protocol?

The Machine Payments Protocol (MPP) is the pattern behind HTTP 402 Payment Required: a service refuses a request with a machine-readable price, the caller settles it on-chain, and retries with proof. No accounts, no API keys, no human in the loop.

```text
GET /resource → 402 PAYMENT-REQUIRED { price, payTo, chain: 4663 }
agent: quote 5.00 USD → 5,000,000 USDG base units
agent: policy check (per-tx cap 100 USDG, daily budget)
agent: pons_pay → USDG transfer → receipt 0x1
agent: retry with tx hash → merchant verifies → 200 + payload
```

## Why agents specifically

Agents can complete every step without UI: parse the 402 body, decide whether the price is worth it, pay, and verify. Humans rarely can — which is why MPP-style payments are an agent-first primitive.

## What PonsMCP adds

PonsMCP packages this loop into an MCP server: `pons_quote` to preview, `pons_pay` to settle with policy enforcement, `pons_tx_status` to independently confirm. Pons launch-intelligence tools sit alongside so agents can also research pons tokens before deciding to pay for paid data about them.
