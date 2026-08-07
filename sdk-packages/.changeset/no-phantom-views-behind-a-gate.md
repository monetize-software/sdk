---
'@monetize.software/sdk': patch
'@monetize.software/sdk-extension': patch
---

Analytics: a blocking gate no longer leaves a phantom `paywall_viewed` / `paywall_closed` pair

On the mount-then-load path the modal is mounted before bootstrap arrives, so the layout can render — and emit `ready` — while the gates are still deciding. The subscription gate awaits `getSettledUser()` (a network round-trip), which pushes the decision hundreds of ms past the render. A gate that then blocked closed the modal, but `paywall_viewed` had already been tracked and `paywall_closed` paired with it: the events dashboard showed views and closes for a paywall nobody was ever allowed to see. On a disabled paywall that was effectively every event — a live paywall reported ~800 views/day with visibility off, and its funnel read as "lots of traffic, no sales".

`paywall_viewed` is now held while a delayed gate is pending and only released once the gates pass. If a gate blocks, the held view is dropped and just the gate's own event (`visibility_blocked` / `trial_blocked`, or nothing for the subscription suppress) reaches analytics. A `ready` arriving after the mount is over no longer tracks a view either.

Real views are unaffected: when the gates pass — or when the user closes the modal themselves while a gate is still pending, having seen the layout — the `paywall_viewed` / `paywall_closed` pair lands as before. Both the base SDK tracker and the sdk-extension `bindAnalytics` mirror carry the same hold.
