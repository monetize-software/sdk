---
'@monetize.software/sdk': patch
---

Fix `getAccess()` locking subscribers out when bootstrap fails on load

When `bootstrap()` threw, the offline fallback decided from `getCachedUser()` alone. That is the page-side mirror, and in the extension build it is empty on **every** fresh load: `RemoteBillingClient` starts with `cachedUser = null` and only fills from a successful bootstrap or a `userChange` broadcast, while the real cache — persisted user, auth hydration — lives in the offscreen document. So a single network hiccup during page load resolved to `blocked` / `no_subscription` for anyone, including a paying subscriber, and the host would then open a paywall with prices in front of them. The offline fallback promised in the docs never actually worked in the extension build.

The fallback now consults a new `BillingClient.peekCachedUser()` — a pure read that awaits storage hydration and returns the cache, overridden in `RemoteBillingClient` to ask the offscreen context where the real cache lives.

Deliberately NOT `getSettledUser()`, even though the success path uses it: this branch already knows the network is down, and a settle there would fire a second doomed request, consume the one-shot checkout-pending marker on it (resurrecting the post-purchase paywall flash that marker exists to prevent), and — for an anonymous visitor — persist `EMPTY_USER` and emit `userChange` from a method documented as a pure read.

Deliberately narrow: the settled user is used **only** when it reports an active subscription. A settle for a guest without identity resolves to `EMPTY_USER` rather than `null`, and letting that through would change the `user` field hosts read as "unknown", so every other offline outcome is unchanged.
