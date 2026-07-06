---
'@monetize.software/sdk': minor
'@monetize.software/sdk-extension': minor
'@monetize.software/sdk-react': minor
---

A/B price experiments (SDK side)

The bootstrap payload may now carry an `experiment` block (`{ id, kind, variants[] }`). The SDK deterministically buckets the device by its stable visitor id (fnv1a hash over `visitorId:experimentId`, weights-proportional), persists the assignment in storage (first-touch stickiness), and for `kind='prices'` materializes the assigned variant into the bootstrap: variant prices replace the control ones and every price-id reference (price_grid, cta_button, offers) is remapped. Control and unknown experiment kinds render unchanged.

Attribution: every analytics event now carries `experiment_id` + `variant` in its props while an experiment is assigned, and `createCheckout` sends `visitorId`, `experimentId` and `variantKey` to `/start-checkout` so server-confirmed purchases can be joined back to the variant.

New public API: `billing.getExperimentAssignment()` (also mirrored on the extension's RemoteBillingClient). Experiments never break the paywall: any assignment/storage failure falls back to the control experience.
