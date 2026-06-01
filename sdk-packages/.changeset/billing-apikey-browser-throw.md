---
'@monetize.software/sdk': minor
---

security(billing): `BillingClient` now **throws** `PaywallError('apikey_in_browser')` from the constructor when `apiKey` is passed in a browser context (`window.document` detected), instead of merely logging `console.error` and continuing.

A server-SDK `apiKey` identifies the paywall owner and can act on any paywall the account owns; leaking it into client code exposes the whole account. The previous behavior (warn-but-proceed) let a naive integrator ship a working-looking bundle that silently leaked the key. Now the leak fails loudly on the first `new BillingClient(...)`.

```ts
// ❌ browser — throws synchronously
new BillingClient({ paywallId, apiOrigin, apiKey: 'sk_live_...' });
// PaywallError('apikey_in_browser')

// ✅ trusted backend — unchanged
new BillingClient({ paywallId, apiOrigin, apiKey: process.env.MONETIZE_API_KEY });
```

Escape hatch for deliberate browser injection (e2e/integration tests only):

```ts
new BillingClient({ paywallId, apiOrigin, apiKey, allowInsecureBrowserUsage: true });
// no throw — downgrades to a console.error warning. Never use in production.
```

Notes:

- New option `allowInsecureBrowserUsage?: boolean` (default `false`).
- This is a **client-side** guard only. The backend still honors any valid key regardless of Origin — it does not replace rotating a key that has already leaked, nor a CI grep-check for `apiKey` in client bundles.
- Server runtimes (Node/Deno/Bun/Edge — no `window.document`) are unaffected.
