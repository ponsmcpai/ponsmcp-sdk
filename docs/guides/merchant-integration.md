# Merchant integration

A merchant on PonsMCP is an address that receives USDG for a priced resource. The registry flow is intentionally small.

## 1. Register a service

Server-side (requires the onboarding secret in the platform environment):

```text
POST /api/merchant/services
{
  "merchant_address": "0x…",
  "name": "Agentic market brief",
  "resource_path": "market-brief",
  "price_usdg": "2.50",
  "registration_secret": "…"
}
```

The price is stored server-side. Clients cannot name their own amount for a registered service.

## 2. Serve the 402

```text
GET /api/merchant/r/market-brief?intent=pi_…
→ 402 { price, payTo: merchant, chain_id: 4663 }
```

## 3. Agent pays

The agent quotes and pays exactly the advertised price to the merchant address, then retries with the transaction hash.

## 4. Verify + unlock

The platform verifies the receipt against the intent: USDG contract, merchant recipient, exact base units, status `0x1`, and the hash has never been used for another intent. On success the same URL returns `200` with the payload and `tx_hash`.

## Requirements for a trustworthy merchant endpoint

- Verify the receipt yourself before unlocking — do not trust the client's claim.
- Enforce hash uniqueness (one transaction pays one intent).
- Keep prices server-side.
- Idempotent verification: re-verifying a paid intent returns the same result without side effects.
