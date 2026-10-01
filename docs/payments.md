# Payment lifecycle

PonsMCP payment execution is intentionally narrow:

```text
amount request → USDG quote → policy check → balance check → local signing
→ transaction broadcast → receipt wait → decoded transfer result
```

## 1. Quote

`pons_quote` parses a human USD amount into USDG base units using six decimals. It performs no approval, signing, or broadcast.

## 2. Policy and balance

`pons_pay` checks the local per-transaction and daily limits before signing. It then checks the configured wallet balance for USDG. A denied policy or insufficient balance does not broadcast a transaction.

## 3. Signing and broadcast

The server derives the agent wallet address from `PONSMCP_PRIVATE_KEY`, builds an ERC-20 `transfer` call to USDG, signs a legacy EIP-155 transaction for chain 4663, and broadcasts it.

## 4. Receipt

The server polls for a receipt for the configured wait window (30 seconds by default). A successful receipt returns the transaction hash, explorer URL, block number, gas used, and decoded ERC-20 transfers.

## Important limits

The policy counter is in-process. Restarting the MCP process resets its in-memory daily record. It is a safety guard for a local agent runtime, not an accounting ledger or merchant authorization system.

## Merchant integration

A payment recipient and amount must come from a trusted merchant requirement. Before treating a receipt as payment for a resource, a merchant needs to verify the receipt's USDG token, recipient, amount, chain, successful status, and replay/idempotency condition against its own payment intent.
