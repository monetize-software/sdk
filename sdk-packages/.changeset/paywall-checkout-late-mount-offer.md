---
'@monetize.software/sdk': minor
'@monetize.software/sdk-react': minor
---

`paywall.checkout(priceId)`: late-mount UX + auto-apply offers.

**Late-mount** — `paywall.checkout()` no longer shows a loading modal while
preparing the hosted checkout. Bootstrap, visibility / trial gates and the
`createCheckout` call now run headlessly; the modal mounts **only when
actual UI is needed** (preauth signin, popup-blocked, awaiting-payment).
The host's CTA button is the only "I'm working" surface during the
200–500 ms prep window.

A new `state.processing: boolean` field on `PaywallStateSnapshot` tells the
host when direct-checkout is in flight. `<PaywallButton priceId>` consumes
it automatically — the button is `disabled` and exposes `aria-busy="true"`
while `processing === true`; the `render` prop receives `processing` as a
third arg so custom triggers can draw their own spinners.

**Offer fix** — `createCheckout` now sends `offerId` to the backend, both
from the new headless path in `paywall.checkout()` and from the existing
`runCheckout` in the modal layout flow. Previously `duration_minutes`-offers
(countdown stored in `clientStorage`) silently lost their discount on the
hosted checkout because the backend couldn't validate the timer and the
SDK never told it which offer the user had been seeing. End-date offers
were auto-resolved server-side by email, but threading the explicit
`offerId` is more reliable.

Backend (`online/app/api/v1/paywall/[id]/start-checkout/route.ts`) now reads
`offerId` from the body and forwards it to `checkoutWithAcquiring`.

**Core SDK** (`@monetize.software/sdk`):

- `PaywallStateSnapshot.processing: boolean` (additive, defaulted to false
  for back-compat).
- `BillingClient.createCheckout({ offerId })` — new param.
- `PaywallUI.checkout()` rewritten as `runDirectCheckout`: async sequence
  bootstrap → gates → preauth-resolve → headless `createCheckout` →
  `mountAndShow('awaiting_payment' | 'popup_blocked', { priceId, url })`
  or `mountAndShow('auth', { checkoutPriceId })` for the preauth branch.
- `PaywallView` extended with `'awaiting_payment'` and `'popup_blocked'` as
  initial-view options; `PaywallRoot` accepts `initialCheckoutPriceId` +
  `initialCheckoutUrl` to mount directly into either screen.
- Internal `direct_checkout_pending` gate-kind removed (no longer needed —
  late-mount path bypasses the intermediate loading state).
- `'checkout'` removed from `PaywallView` (was alpha.12-only; internal).

**React bindings** (`@monetize.software/sdk-react`):

- `<PaywallButton priceId>` reads `state.processing` via `usePaywallState`
  and disables itself while direct-checkout is preparing.
- `PaywallButtonRenderArgs` gains `processing: boolean`.
- Contract assertion (`contract.ts`) now requires `processing` on
  `PaywallStateSnapshot`.

Example:

```tsx
<PaywallButton priceId={price.id}>
  Get this plan
</PaywallButton>
// During the 200-500ms prep, the button is disabled with aria-busy="true".
// On success, modal opens directly in awaiting_payment view — no loading flash.
```
