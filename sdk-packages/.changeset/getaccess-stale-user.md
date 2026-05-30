---
'@monetize.software/sdk': patch
---

`paywall.getAccess()`: read fresh user from `cachedUser` instead of stale
`getCachedBootstrap().user`.

Before: when bootstrap was cached (typical after the pricing page loaded
it), `getAccess()` resolved `user` from `getCachedBootstrap().user` — the
snapshot taken at the time bootstrap was fetched. After a successful
purchase the UserWatcher poll updates `billing.cachedUser` and emits
`userChange`, host's `usePaywallAccess` re-runs `getAccess()` — but the
cached bootstrap still has the pre-purchase user snapshot, so the hook
returns `blocked` even though the user really has an active subscription.

After: prefer `billing.getCachedUser()` (which reflects every userChange),
falling back to `bootstrap.user` only when the user cache is empty (cold
start, post-signOut). `getCachedBootstrap()` continues to return the raw
structure — it's used elsewhere for non-user fields and we don't want to
pay a re-merge cost on every call.

Symptom this fixes: `<PaywallGate>` and `usePaywallAccess` staying in
`blocked` after a successful checkout (UI didn't react to Pro). Account
page kept working because `usePaywallUser` reads `getCachedUser()`
directly — only the access-resolution path was hitting the stale view.

Async path (cold bootstrap) was already correct: `BillingClient.bootstrap()`
overlays cachedUser onto the returned bootstrap (`{ ...cachedBootstrap, user: cachedUser ?? undefined }`).
