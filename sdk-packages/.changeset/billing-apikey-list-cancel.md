---
'@monetize.software/sdk': minor
---

feat(billing): `listPurchases` and `cancelSubscription` now accept `apiKey` + `identity` (server-SDK path), in addition to the existing Bearer (`AuthClient`) path.

Before this change, both methods required a connected `AuthClient` and threw `PaywallError('auth_required')` when called without one — making them unusable for headless integrations whose customers don't run monetize.software's auth.

Now:

```ts
const billing = new BillingClient({
  paywallId, apiOrigin,
  apiKey: process.env.MONETIZE_API_KEY!,
  identity: { email: user.email, userId: user.id }
});

const purchases = await billing.listPurchases();
await billing.cancelSubscription({ subscriptionId, reason: '...' });
```

Notes:

- Identity (email or your stable `userId`) is sent as `?email=` / `?user_id=` (listPurchases) or in the body (cancelSubscription).
- Bearer path is unchanged — UI customer portals built on `AuthClient` keep working.
- Without either path, both methods now throw `identity_required` (was `auth_required`).
- The backend additionally verifies the identity is linked to your paywall (via `user_paywalls` or any prior purchase). Querying users that never interacted with your paywall returns `identity_not_on_paywall` (404) — cross-paywall lookup is blocked by design.
- `cancelSubscription` adds a `paywall_id` filter on the apiKey path, so the owner of paywall A cannot cancel a subscription on paywall B even by guessing IDs.
