---
'@monetize.software/sdk': minor
'@monetize.software/sdk-react': minor
---

Expose offers to host code with a resolver-style API.

**Core SDK** (`@monetize.software/sdk`):

- `new module: core/offer` — pure resolvers (`resolveOffer`, `findApplicableOffer`,
  `offerStartStorageKey`, `readBrowserOfferStart`) shared by the renderer and
  host-side helpers.
- `PaywallUI.getCachedOffers()` — sync snapshot of the bootstrap's offer list
  (server-side targeting already applied by the backend).
- `PaywallUI.getOfferForPrice(priceId)` — `ResolvedOffer | null` accounting
  for `price_id` matching, `expires_at`, and `duration_minutes` from
  `clientStorage` `pw-offer-{id}-start`. **Read-only** — does NOT start the
  `duration_minutes` timer (the renderer owns activation on first paywall
  view). Pages-side hosts that call this before the user has opened the
  modal will get `null` for duration-only offers, which is intentional.
- `billing.getCachedOffers()` — same data, BillingClient-level.
- Internal: `PriceGrid` renderer now imports the shared `findApplicableOffer`
  instead of duplicating the logic.

**React bindings** (`@monetize.software/sdk-react`):

- `usePaywallOffer(priceId)` — reactive `ResolvedOffer | null` with a 1Hz
  tick while the countdown is live, auto-stopping when the offer expires.
- `usePaywallOffers()` — the raw cached offers list, refreshed on `ready`.
- Re-exports `ResolvedOffer` from the core SDK.

Example usage:

```tsx
const offer = usePaywallOffer(price.id);
if (!offer) return <Amount value={price.amount} />;
const discounted = price.amount * (1 - offer.discountPercent / 100);
return (
  <>
    <Strike>{format(price.amount)}</Strike>
    <strong>{format(discounted)}</strong>
    <Badge>-{offer.discountPercent}%</Badge>
    {offer.remainingMs !== null && <Countdown ms={offer.remainingMs} />}
  </>
);
```
