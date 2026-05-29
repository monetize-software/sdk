---
'@monetize.software/sdk-extension': patch
---

fix(dts): rewrite emitted `.d.ts` imports from the dev-only `../sdk/src`
relative paths to the bare `@monetize.software/sdk` specifier.

Mirror of the same fix that landed in `@monetize.software/sdk-react`
(alpha.8). `vite-plugin-dts` was inlining the tsconfig `@sdk → ../sdk/src`
alias into emitted declarations as `from '../../../sdk/src/core/...'`,
which works in the monorepo but resolves to nothing in the published
npm package. Consumers saw `PaywallUI`, `BillingClient` and friends
silently typed as `any`, breaking host code like `paywall.auth`,
`paywall.open()`, and `paywall.billing.*`.

A `beforeWriteFile` hook in `vite.config.ts` rewrites these paths back
to the bare specifier at build time.
