---
'@monetize.software/sdk': patch
'@monetize.software/sdk-extension': patch
---

Post-purchase reopen no longer flashes the paywall once

The first popup open after a purchase mounted the plan picker for a moment and immediately closed it (the post-mount corrective). Cause: the popup dies when the user leaves for the checkout tab, so nothing updates the persisted user — for up to 30 minutes it keeps saying `has_active_subscription: false`, and the settled-user gate trusted it.

- `checkout_started` now persists a one-shot **checkout-pending marker**. While it's fresh, `getSettledUser()` distrusts a cached/persisted "no subscription" and re-checks `/user-state` (with `force`, deduped against the in-flight auto-refetch) before the gate decides — the post-purchase reopen suppresses cleanly, nothing mounts.
- The marker is consumed on first use and capped at the persisted-user TTL: an abandoned checkout costs exactly one extra re-check, free users without a checkout keep the no-network fast path.
- The open()/`getAccess()` gates now also settle when the cached user is *negative* (not only when it's missing) — covers hosts where identity is known at construction (hybrid mode) and the stale snapshot hydrates before `open()`.
