---
'@monetize.software/sdk': minor
'@monetize.software/sdk-extension': minor
---

Subscription gate no longer races the cold start — subscribers can't leak onto the plan picker

- **Settled-user gate.** `paywall.open()` for the layout view now resolves the user through the new `billing.getSettledUser()` before deciding: it waits for the auth session hydrate → identity sync → persisted user cache → `/user-state`, instead of reading the sync in-memory cache that is empty for the first moments of an extension-popup lifecycle. The 3.3.0 leak — a hydrated persisted bootstrap (which stores no user) let the gate fall through on `null` and mount the picker for a subscriber — is closed. Hosts without managed-auth and identity keep the fully synchronous mount path.
- **Post-mount corrective.** If the subscription truth still arrives after a blind open() mounted the layout (network hiccup during the settle, cross-context broadcast), the modal closes and the host gets the same `purchase_completed{restored:true}` signal. Renew flows, started checkouts and in-modal auth flows are untouched.
- **EMPTY_USER poisoning fixed.** `getUser()` called before the auth session hydrated used to stamp-and-persist an empty user under the guest storage key, feeding the next popup's gate a confident "no subscription". It now waits for the hydrate (identity is final afterwards); the guest-key hydrate is skipped entirely when managed-auth is on.
- **`getAccess()`** resolves through the same settled user — no more intermittent `blocked/no_subscription` with `purchases: []` for an active subscriber on a cold popup start.
- `@monetize.software/sdk-extension`: `RemoteBillingClient.getSettledUser()` proxies to the offscreen client over the new `billing.getSettledUser` transport request; degrades to the cached user if the port is gone.
