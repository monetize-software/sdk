---
'@monetize.software/sdk-extension': patch
---

fix(dts): broaden the published `.d.ts` path rewrite to cover `../sdk/src/ui/...`
imports as well — the previous fix only matched `core/...`. Result: `PaywallUI`
extends `BasePaywallUI` and now resolves to real method signatures
(`auth`, `billing`, `open()`, `signInAnonymously()`, `on()`, …) for downstream
hosts instead of `any`.
