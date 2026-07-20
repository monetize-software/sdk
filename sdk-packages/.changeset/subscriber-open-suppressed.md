---
'@monetize.software/sdk': minor
---

Blind `paywall.open()` for a user with an active subscription no longer shows any modal

- **Behavior change.** `open()` used to switch an already-subscribed user to the restored success view — and, due to a state-machine bug, any reopen within the same page-life showed the full plan picker (reported from an extension popup: a subscriber clicking a gated feature landed on prices). The subscription check is now a pre-mount gate in `PaywallUI`, symmetric with the visibility/trial gates: nothing mounts, the host receives `purchase_completed{restored: true}` once per instance lifetime. The restored success view remains where the user explicitly recovers access: signin auth-resume, Restore purchases, and the 409 `already_purchased` path in checkout. `open({renew: true})` still always shows the plans.
- **Fix.** `bootstrap()` on the `unchanged` revalidate path returned the raw cached bootstrap, whose `user` is absent (persisted bootstraps are stored without it) or stale. `bootstrap().user` now carries the fresh user from the response — same contract as the cache-fresh path.
- **Fix.** Closing the modal while the first bootstrap was still in flight (a delayed visibility/trial gate closing a mount-then-load open) left the loader state stuck — every subsequent `open()` showed an infinite spinner. The stale in-flight state now resets on close and the next open restarts the load.
- Trial gating is unchanged: an active trial still suppresses `open()` with `trial_blocked`; an expired trial still opens the plan picker.
