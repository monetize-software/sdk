---
'@monetize.software/sdk': patch
---

Numeric price ids no longer silently drop the local currency or a targeted offer

`priceId` is typed as a string, but plain-JS hosts routinely pass the number from
their own config. Two lookups compared it strictly and just missed: the bootstrap
price lookup in `createCheckout`, which meant `localCurrency` was dropped and the
user who saw £9.99 on the paywall got a base-USD Stripe page; and
`findApplicableOffer`, which skipped a price-targeted discount and fell through
to the global one. Neither failed loudly — the checkout still succeeded, just
wrong. Both sides are now coerced before comparing.
