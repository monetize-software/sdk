---
'@monetize.software/sdk': patch
---

Export `PaywallPurchaseDetailed` from the package root — the rich purchase
shape returned by `BillingClient.listPurchases()` (used to render customer-
portal subscription lists). Was already implemented and documented, just
missing from the public re-export barrel.
