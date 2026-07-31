---
'@monetize.software/sdk-extension': minor
'@monetize.software/sdk': minor
---

The purchase continues after a rescued OAuth sign-in

3.5.0-rc.0 let a sign-in survive its surface being destroyed, but the purchase
behind it did not: the user signed in, the tab closed, and they had to reopen the
extension and click buy a second time before the payment page appeared.

The pending checkout now travels with the flow. `signInWithOAuth` takes a
`resumeCheckout` intent (price, resolved offer, renew), which `PaywallUI` passes
automatically from the auth gate; offscreen holds it for the lifetime of the
flow, creates the checkout the moment the session lands, and the service worker
sends that same provider tab to the payment page. Provider → payment in one move.

Offscreen also writes the checkout-pending marker and tracks `checkout_started`
itself, since the surface that normally would is gone — so the next open doesn't
flash the paywall at someone mid-payment, and the funnel stays honest.

A user who already owns the subscription gets no second checkout: the 409 leaves
the sign-in standing, the tab closes, and the restored state shows on their next
open.

In the plain SDK `resumeCheckout` is accepted and ignored — there the caller is
still alive when the sign-in resolves and drives the checkout itself.
