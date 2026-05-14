# @monetize.software/sdk

SDK 3.0 — bundled billing client and paywall render engine. Embeds into Chrome
extensions and websites via npm / CDN, with no iframe and no remote code.

Status: **alpha, WIP**. See [TODO.md](../TODO.md).

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
  identity: { email: user.email, userId: user.id }
});

paywall.on('checkout_started', ({ url }) => {
  window.open(url, '_blank');
});

document.getElementById('upgrade').onclick = () => paywall.open();
```

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
- **Server-driven checkout** — SDK is provider-agnostic (Stripe/Paddle/Chargebee),
  it just opens the `checkout_url` returned by the server.

## Metered AI proxy (`ApiGatewayClient`)

The platform supports proxying calls to OpenAI/Anthropic/any HTTP API with
token accounting against `paywall_balances`. The SDK ships a thin client to
this proxy and maintains local balance state.

```ts
import { BillingClient, AuthClient, QuotaExceededError } from '@monetize.software/sdk/core';

const auth = new AuthClient({ paywallId: 'pw_abc' });
const billing = new BillingClient({ paywallId: 'pw_abc', auth });
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

## Not in this version (alpha)

- Auth layer (Google / Apple / Email) — coming after the hybrid beta.
- Timer-based trials, A/B variants, localization.
- Framework adapters (`@monetize/react`).
- Tests.
