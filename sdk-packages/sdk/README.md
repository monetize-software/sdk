# @monetize.software/sdk

SDK 3.0 — bundled billing client and paywall render engine. Renders the paywall
in a Shadow DOM modal on your page, with no iframe.

- **Websites:** install via npm and bundle, or load from a CDN (`esm.sh`/`unpkg`/`jsDelivr`).
- **Chrome extensions:** use the dedicated [`@monetize.software/sdk-extension`](https://www.npmjs.com/package/@monetize.software/sdk-extension)
  package and bundle as an npm dependency — Chrome Web Store MV3 policy forbids
  remote code execution, so CDN loading is **not** allowed.

## Three entrypoints

```ts
// server / headless billing — API only, no UI
import { BillingClient } from '@monetize.software/sdk/core';

// host renders its own UI but needs our modal
import { PaywallUI } from '@monetize.software/sdk/ui';

// all in one — auth layer is loaded lazily
import { PaywallUI } from '@monetize.software/sdk';
```

## Quick start

```ts
import { PaywallUI } from '@monetize.software/sdk';

const paywall = new PaywallUI({
  paywallId: 'pw_abc123',
  apiOrigin: 'https://your-paywall-domain.com',  // required: your custom_domain
  identity: { email: user.email, userId: user.id }
});

paywall.on('checkout_started', ({ url }) => {
  window.open(url, '_blank');
});

document.getElementById('upgrade').onclick = () => paywall.open();
```

`apiOrigin` must match the `custom_domain` configured for your paywall in the
platform. The SDK validates it against the bootstrap response and throws
`invalid_config` on mismatch.

## Scripts

```bash
pnpm install
pnpm dev          # local demo at http://localhost:5060/demo/
pnpm build        # ESM + CJS + .d.ts into dist/
pnpm typecheck
pnpm size         # bundle-size gate
pnpm test
```

## Architecture (in brief)

- **Preact** (not React) — 3KB instead of 45KB. Critical for the bundle budget.
- **Shadow DOM** (`{ mode: 'closed' }`) — style isolation.
- **Tailwind v4**, compiled into a CSS string and injected into the shadow root.
- **Server-driven layout** — JSON schema of blocks (`heading`, `price_grid`, `cta_button`, ...).
  SDK knows how to render blocks; the server controls order, copy, and visibility.
- **Server-driven checkout** — SDK is provider-agnostic (Stripe, Paddle, Freemius,
  Chargebee, Overpay), it just opens the `checkout_url` returned by the server.

## Metered AI proxy (`ApiGatewayClient`)

The platform supports proxying calls to OpenAI/Anthropic/any HTTP API with
token accounting against `paywall_balances`. The SDK ships a thin client to
this proxy and maintains local balance state.

```ts
import { BillingClient, AuthClient, QuotaExceededError } from '@monetize.software/sdk/core';

const auth = new AuthClient({ paywallId: 'pw_abc', apiOrigin: 'https://your-paywall-domain.com' });
const billing = new BillingClient({ paywallId: 'pw_abc', apiOrigin: 'https://your-paywall-domain.com', auth });
const gateway = billing.createApiGatewayClient();

billing.onBalanceChange((balances) => {
  // Render quota counter in UI
});

try {
  // SSE stream: returns a raw Response, no built-in parser.
  const res = await gateway.call({
    providerId: 'prov_openai',
    path: '',
    body: { model: 'gpt-4', stream: true, messages: [...] },
    signal: controller.signal
  });
  for await (const chunk of res.body!) {
    /* ... */
  }
} catch (e) {
  if (e instanceof QuotaExceededError) {
    paywall.open(); // upgrade prompt
  } else throw e;
}
```

- `BillingClient.createApiGatewayClient()` wires the Bearer from `AuthClient`,
  optimistically decrements `cachedBalances` on success, and refetches `/balances`
  on 402.
- `gateway.call()` returns the raw `Response`. Caller decides: `.json()`,
  `.body.getReader()`, or async-iter — anything that works on a `fetch` Response.
- On 402, `QuotaExceededError` is thrown with `balances` / `queryType` / `currentBalance`.

## What's included

- **Auth layer** — Email/password, OAuth (Google, Apple, Facebook, GitHub),
  password reset and OTP confirmation flows. Lazy-loaded chunk: pay for it only
  if you instantiate `AuthClient` or open the SDK with `auth: true`.
- **Trials** — time-based trial counter (LocalTrialStore on web,
  RemoteTrialStore in the extension offscreen) with server-side validation.
- **Localization** — 27 bundled locales, lazy-loaded per active language; falls
  back to canonical English baked into block strings.
- **Server-driven layout** — blocks, ordering, copy and visibility are owned by
  the platform; the SDK renders. Live preview API for the admin editor.
- **React bindings** — see [`@monetize.software/sdk-react`](https://www.npmjs.com/package/@monetize.software/sdk-react)
  for `<PaywallProvider>`, hooks and declarative gate/button components.
- **Chrome extensions** — see [`@monetize.software/sdk-extension`](https://www.npmjs.com/package/@monetize.software/sdk-extension)
  for the offscreen-backed integration (single source of truth across tabs,
  popups, side panels).
