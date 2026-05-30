---
'@monetize.software/sdk': minor
---

`billing.getCustomerPortalUrl({ returnUrl })` — host-controlled return URL.

Adds an optional `returnUrl` parameter to `getCustomerPortalUrl()`. When
set, the hosted portal's "Return to ..." button sends the user back to
that URL — typically the host app's account page
(`https://your-app.com/account`). Threads through Stripe (`return_url`),
Paddle (`return_url`) and Chargebee (`redirect_url`).

Previously the SDK sent nothing and the backend chose `shop_url` (the
paywall-level "Shop URL" setting) or fell back to the online service's
own paywall page (`NEXT_PUBLIC_ONLINE_ORIGIN/paywall/<id>/customer-portal/return`).
For self-hosted apps both paths were off-brand — the user round-tripped
through the online-service domain instead of landing in the host's UI.

Backend (`online`) is required for the round trip — without the matching
backend deploy `returnUrl` is silently ignored and the old fallback chain
kicks in. The backend deploy also:

- Adds `custom_domain/paywall/<id>/customer-portal/return` to the
  fallback chain (between `shop_url` and `NEXT_PUBLIC_ONLINE_ORIGIN`) so
  even hosts that don't pass `returnUrl` get a sensible URL when their
  paywall has a custom domain.
- Re-enables `return_url` in the Paddle portal request body (was
  commented out).
- Forwards `redirect_url` to Chargebee `/portal_sessions`.
- Propagates the actual Stripe error message when checkout fails instead
  of swallowing it as `{ errorRedirect }` (was returning a malformed
  shape that callers couldn't diagnose).

Example:

```ts
const { url } = await paywall.billing.getCustomerPortalUrl({
  returnUrl: `${window.location.origin}/account`
});
window.open(url, '_blank', 'noopener,noreferrer');
```
