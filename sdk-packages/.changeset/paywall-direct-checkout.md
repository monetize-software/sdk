---
'@monetize.software/sdk': minor
'@monetize.software/sdk-react': minor
---

Add `paywall.checkout(priceId, opts?)` — direct-checkout API.

Lets hosts that render their own pricing UI (cards / table) send the
click straight to the hosted checkout, **skipping the plan-picker layout**
inside the modal. The modal still owns the parts that are hard to rebuild:
preauth signin, popup-blocked retry under a fresh user gesture, and the
awaiting-payment screen with "I've paid" / "Open checkout again".

**Core SDK** (`@monetize.software/sdk`):

- `PaywallUI.checkout(priceId, opts?)` — new method. Reuses `OpenOptions`
  (`identity`, `renew`, `skipTrial`, `skipVisibility`).
- **Headless reject for already-paid.** When the user already has an
  active subscription — cached user, fresh bootstrap, preauth-resume, or
  `409 hasActivePurchase` from the backend — the SDK emits
  `purchase_completed { priceId, restored: true }` and does **not** show
  the "Subscription restored" view. The modal stays closed (or closes if
  it was already mounted for the auth-gate). The host decides how to
  surface that (toast, redirect, badge via `userChange`).
- **No layout fallback on error.** On any `createCheckout` failure the
  modal closes and `error` is emitted. The plan-picker is never shown,
  not even for a frame — the host owns that surface.
- Requires `identity.email` (via opts, earlier `setIdentity`, or
  managed-auth). Without it the backend rejects `/start-checkout`.
- For fully-headless flows (host renders its own awaiting-payment
  screen), `paywall.billing.createCheckout({ priceId })` is still the
  raw escape hatch.

**React bindings** (`@monetize.software/sdk-react`):

- `<PaywallButton priceId={...}>` — when set, the click calls
  `paywall.checkout(priceId, opts)` instead of `paywall.open(opts)`.
  `mode` is ignored: a button is either a layout-opener or a
  direct-checkout trigger, never both.
- Contract assertion (`contract.ts`) covers the new `checkout` method
  signature.

Example:

```tsx
import { usePaywallPrices, PaywallButton } from '@monetize.software/sdk-react';

function PricingCards() {
  const { prices } = usePaywallPrices();
  return prices?.map((p) => (
    <Card key={p.id}>
      <h3>{p.label}</h3>
      <PaywallButton priceId={p.id}>Get this plan</PaywallButton>
    </Card>
  ));
}
```
