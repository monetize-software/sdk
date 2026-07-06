---
'@monetize.software/sdk-extension': minor
---

`paywall.billing.getCustomerPortalUrl()` is now available in the extension channel

Previously the method existed only in the base `@monetize.software/sdk` — calling it on `paywall.billing` in a popup/options/content context threw `TypeError: ... is not a function`, because `RemoteBillingClient` did not proxy it through the transport. Now it is wired end-to-end (protocol kind `billing.getCustomerPortalUrl` → offscreen handler → `RemoteBillingClient` method), same contract as the base SDK:

```ts
const { url } = await paywall.billing.getCustomerPortalUrl({
  returnUrl: 'https://your-app.com/account'
});
window.open(url, '_blank');
```

The Bearer session lives in offscreen, so this works from any extension surface without touching the token. A backend 403 (no active subscription / acquiring without a portal) surfaces as `PaywallError('forbidden')` with `status: 403`.
