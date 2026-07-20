---
'@monetize.software/sdk': patch
'@monetize.software/sdk-extension': patch
---

Analytics: `purchase_completed{restored:true}` is no longer tracked; `paywall_closed` only pairs with a tracked `paywall_viewed`

- **restored ≠ purchase.** The restored variants of `purchase_completed` (suppressed open for a subscriber, headless `checkout()` reject, 409 `already_purchased`, signin auth-resume) were tracked to the events dashboard identically to real purchases — merchants saw "purchases" with no transaction behind them. Restored emits are now excluded from analytics entirely; the public event still reaches the host.
- **No more closed-without-viewed.** A delayed gate (visibility / trial / the new subscription gate) closing the mount-then-load spinner tracked `paywall_closed` for a paywall nobody ever saw, breaking the viewed/closed funnel. `paywall_closed` is now tracked only when the same mount session actually tracked `paywall_viewed`. Support/auth/standalone mounts stay untracked as before.

Both the base SDK tracker and the sdk-extension `bindAnalytics` mirror carry the same gates.
