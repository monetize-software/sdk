# @monetize.software/sdk-react

## 3.0.0-alpha.5

### Patch Changes

- docs: README cleanup across all three packages

  - **sdk**: dropped stale "Not in this version (alpha)" block that listed Auth, trials, i18n, React adapter and tests as missing — all shipped. Replaced with an accurate "What's included" section. Added required `apiOrigin` (custom_domain) to Quick start and ApiGateway examples. Expanded provider list to the real set: Stripe / Paddle / Freemius / Chargebee / Overpay. Removed broken `../TODO.md` link. Clarified CDN policy: allowed for websites, forbidden for Chrome extensions.
  - **sdk-extension**: fixed `host_permissions` manifest snippet — was `["https://api.monetize.software/*"]` (a domain that doesn't exist), now points to the host's own `apiOrigin` (custom_domain) with a placeholder. Removed the misleading `"permissions": ["identity"]` optional line — SDK does not use `chrome.identity` (OAuth runs via a popup window against the host's `apiOrigin`). Removed the stale "Phase 0 — skeleton" status block and "Usage (target shape, when complete)" framing — package is published and in use. Architecture diagram annotation corrected to reflect the popup-window OAuth flow.
  - **sdk-react**: translated README from Russian to English to match the other two packages. Added required `apiOrigin` to Quick start and SSR/Next.js examples.

  No code changes.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.7

## 3.0.0-alpha.4

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.6

## 3.0.0-alpha.3

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.5

## 3.0.0-alpha.2

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.4

## 3.0.0-alpha.1

### Minor Changes

- Initial alpha release of `@monetize.software/sdk-react` — React bindings for `@monetize.software/sdk`.

  Includes:

  - `<PaywallProvider>` with two modes: `options={...}` (Provider creates the instance) or `instance={...}` (host supplies a ready PaywallUI from sdk-extension or a shared singleton)
  - 8 hooks: `usePaywall`, `usePaywallState`, `usePaywallUser`, `usePaywallAccess`, `usePaywallPrices`, `usePaywallEvent`, `usePaywallTrial`, `usePaywallVisibility`
  - 3 declarative components: `<PaywallGate>`, `<PaywallButton>`, `<PaywallSupportButton>`
  - `'use client'` directive for Next.js App Router and other RSC-aware bundlers
  - Type-level contract (`src/contract.ts`) that breaks the build at `tsc` time if the public surface of `@monetize.software/sdk` shifts

  SSR-safe out of the box (Next.js, Remix, Astro, RSC). Bundle: ~2 KB gzip.
