---
'@monetize.software/sdk': patch
'@monetize.software/sdk-extension': patch
'@monetize.software/sdk-react': patch
---

docs: README cleanup across all three packages

- **sdk**: dropped stale "Not in this version (alpha)" block that listed Auth, trials, i18n, React adapter and tests as missing — all shipped. Replaced with an accurate "What's included" section. Added required `apiOrigin` (custom_domain) to Quick start and ApiGateway examples. Expanded provider list to the real set: Stripe / Paddle / Freemius / Chargebee / Overpay. Removed broken `../TODO.md` link. Clarified CDN policy: allowed for websites, forbidden for Chrome extensions.
- **sdk-extension**: fixed `host_permissions` manifest snippet — was `["https://api.monetize.software/*"]` (a domain that doesn't exist), now points to the host's own `apiOrigin` (custom_domain) with a placeholder. Removed the misleading `"permissions": ["identity"]` optional line — SDK does not use `chrome.identity` (OAuth runs via a popup window against the host's `apiOrigin`). Removed the stale "Phase 0 — skeleton" status block and "Usage (target shape, when complete)" framing — package is published and in use. Architecture diagram annotation corrected to reflect the popup-window OAuth flow.
- **sdk-react**: translated README from Russian to English to match the other two packages. Added required `apiOrigin` to Quick start and SSR/Next.js examples.

No code changes.
