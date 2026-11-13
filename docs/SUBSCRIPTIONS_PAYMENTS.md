# Subscriptions & payments

Provider-independent billing for Dating Cloud Plus. Controllers talk only to `subscription.service.js`. Provider adapters live under `src/payments/`.

## Architecture

```
Client → /subscriptions/* → subscription.service → PaymentProvider
                                      ↓
                         SubscriptionEntitlement + PaymentTransaction
                                      ↓
                              entitlement:updated (socket)
```

| Adapter | Status | Environment |
|---------|--------|-------------|
| `demo` | Working | Always `demo` |
| `razorpay` | Placeholder | `test` / `live` when keys are set |

Select the active provider with `PAYMENT_PROVIDER`. Never put Razorpay or demo-specific logic in controllers.

## Environment

```env
PAYMENT_PROVIDER=demo          # development default; production default is razorpay
DEMO_PAYMENTS_ENABLED=true     # required for demo; refused in production unless explicitly true
DEMO_WEBHOOK_SECRET=...        # optional; header x-demo-signature for /webhooks/demo

# Future Razorpay (do not commit real secrets)
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
RAZORPAY_ENVIRONMENT=test
```

Demo is **disabled by default in production**. Enabling it requires `DEMO_PAYMENTS_ENABLED=true`.

## Member APIs

All routes are under `/api/v1/subscriptions`. Auth required except webhooks.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/products` | Paywall catalog + `billing` status |
| GET | `/entitlement` | Current FREE/PLUS state |
| POST | `/checkout` | Create provider checkout session |
| POST | `/verify` | Server-side verify + activate entitlement |
| POST | `/restore` | Re-apply from ledger / store proofs |
| POST | `/cancel` | Stop auto-renew (access until `expiresAt`) |
| GET | `/history` | Paginated payment ledger |
| POST | `/webhooks/:provider` | Provider webhooks (`demo` \| `razorpay`) |

### Checkout

```json
POST /subscriptions/checkout
{ "productId": "dc_plus_monthly", "platform": "WEB", "idempotencyKey": "optional-uuid" }
```

Products: `dc_plus_monthly` (₹499 / 30 days), `dc_plus_yearly` (₹3,999 / 365 days).

### Demo verify

```json
POST /subscriptions/verify
{ "checkoutId": "chk_…", "providerProof": { "outcome": "SUCCESS" } }
```

Use `"FAILURE"` to simulate a declined payment. Demo rows are always `provider=demo`, `environment=demo`, and `isDemo=true` in API responses. They can never be written as Razorpay entitlements.

### Legacy store body

```json
{ "platform": "ANDROID", "productId": "dc_plus_monthly", "transactionProof": "…" }
```

Still validated, then returns `501 FEATURE_NOT_CONFIGURED` until a store adapter is wired.

## Shared entitlement engine

- `applyVerifiedEntitlement(userId, change, { provider, environment })` is the only write path for Plus.
- Premium gates (`isPremium`) are unchanged.
- Expiry job (`subscription-expiry`, every 15 minutes) sets `isActive=false` on expired rows.
- Socket event: `entitlement:updated` `{ tier, isActive, provider, environment }`.

## Adding Razorpay later

1. Set `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` and `PAYMENT_PROVIDER=razorpay`.
2. Implement methods on `src/payments/razorpay.provider.js` only:
   - `createCheckout` → Razorpay order
   - `verifyPayment` → signature check
   - `handleWebhook` → webhook signature + events
   - `cancelSubscription` / `restorePurchase` as needed
3. Do **not** change route contracts, `SubscriptionEntitlement` shape, or swipe premium gates.

## Security notes

- Client-submitted payment status is ignored except as a **demo simulation switch**.
- Checkout ownership is checked on verify.
- Duplicate `originalTransactionId` / idempotency keys are rejected.
- Webhook signatures are verified per provider.
- Payment secrets stay in backend env only.
