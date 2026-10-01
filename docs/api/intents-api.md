# Payment intents API

The web console and merchant resources run on a small D1-backed API on the Pages deployment.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/intents` | POST | Create a payment intent (merchant, amount, optional `service_id`) |
| `/api/intents` | GET | List recent intents (public demo ledger) |
| `/api/intents/:id/verify` | POST | Verify a tx hash against an intent (replay-safe) |
| `/api/merchant/services` | GET | Public service catalog |
| `/api/merchant/services` | POST | Register a service (onboarding secret required) |
| `/api/merchant/r/:serviceId` | GET | 402 until paid → 200 after verified settlement |
| `/api/rpc` | POST | Read-only chain proxy (method whitelist + rate limit) |
| `/api/price` | GET | PONS market proxy (30 s edge cache) |

## Intent lifecycle

```text
pending → (verify with matching receipt) → paid
pending → (verify with wrong receipt)    → 422, stays pending
paid    → (verify again, same hash)      → idempotent 200
paid    → (verify with different hash)   → 409
```

A transaction hash can settle at most one intent — uniqueness is enforced at the database level.
