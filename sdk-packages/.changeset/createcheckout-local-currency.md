---
'@monetize.software/sdk': patch
---

`BillingClient.createCheckout`: auto-send `localCurrency`.

Resolves the user's local currency from the cached bootstrap
(`price.local.currency` on the target `priceId`) and threads it into the
`/start-checkout` body. Without this the backend fell back to the base
currency on the hosted checkout — the SDK showed £9.99 on the paywall
and Stripe opened with $9.99, a literal UI/checkout mismatch.

No host code changes required: the resolution happens automatically
inside `createCheckout` from `cachedBootstrap.prices`. The backend
contract field (`localCurrency`) and the body comment already mentioned
it — the SDK simply wasn't sending it.
