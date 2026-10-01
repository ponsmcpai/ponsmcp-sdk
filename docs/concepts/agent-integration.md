# Agent integration patterns

PonsMCP is a stdio MCP server, so it plugs into any MCP client runtime. Three patterns cover most agent architectures.

## Pattern 1: direct tool calls

The agent runtime lists the nine tools and calls them as needed. This is the default path — no extra wiring.

```text
tools: pons_chain_info, pons_price, pons_launch_info, pons_launch_market,
       pons_token_info, pons_balance, pons_quote, pons_pay, pons_tx_status
```

## Pattern 2: intent-driven (web console + agent)

A browser console creates a **persistent payment intent** (merchant, amount, service). The agent receives the intent ID and executes `pons_pay` against it. The console then verifies the returned hash against the exact intent — this is what PonsMCP's Mission Control does.

## Pattern 3: 402 resource unlock

A merchant service returns `402 PAYMENT-REQUIRED` with a price. The agent:
1. quotes the price with `pons_quote`,
2. settles with `pons_pay` to the payTo address,
3. retries the resource with the transaction hash,
4. the merchant verifies the receipt (exact token, recipient, amount, uniqueness) and unlocks the response.

This is the loop implemented by the PonsMCP registry endpoints (`/api/merchant/r/:serviceId`).
