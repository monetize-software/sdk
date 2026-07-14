---
'@monetize.software/sdk-extension': patch
'@monetize.software/sdk': patch
---

Extension analytics: `paywall_viewed` / `paywall_closed` are gated to the real paywall view (`'layout'`), matching the base SDK

The extension's tracker bindings mirror `PaywallUI.initTracker` but were missing the `lastMountedView` gate: mounting the support / standalone-auth / awaiting_payment views (`openSupport()`, `openAuth()`, the direct `checkout()` flow) also emits the public `ready`/`close` events, and the `extension` channel counted them as paywall views — inflating `paywall_viewed` and producing odd sequences like `checkout_started` → `paywall_viewed` within a single direct-checkout flow. In `@monetize.software/sdk`, `PaywallUI.lastMountedView` is now `protected` (was `private`) so subclass tracker mirrors can apply the same gate; no behavior change in the base SDK itself.
