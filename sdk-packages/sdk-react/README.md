# @monetize.software/sdk-react

React bindings for [`@monetize.software/sdk`](../sdk) — Provider, hooks and
declarative paywall components. Works with the web SDK and the extension SDK
(any drop-in-compatible `PaywallUI`).

- **Bundle**: < 2 KB gzip (bindings only — the UI lives inside the SDK).
- **React**: >= 18, uses `useSyncExternalStore` for concurrent-safe snapshot reads.
- **SSR**: safe out of the box. On the server, hooks return `null` /
  `{ status: 'loading' }`; the `PaywallUI` instance is created only on the client.
- **TypeScript**: full type-level contract ([`src/contract.ts`](src/contract.ts)) —
  if the public surface of the SDK shifts, the `sdk-react` build fails at `tsc`.

## Installation

```bash
pnpm add @monetize.software/sdk-react @monetize.software/sdk react
```

## Quick start

```tsx
import {
  PaywallProvider,
  PaywallGate,
  PaywallButton,
  usePaywallUser
} from '@monetize.software/sdk-react';

function App() {
  return (
    <PaywallProvider
      options={{
        paywallId: 'YOUR_ID',
        apiOrigin: 'https://your-paywall-domain.com',
        auth: true
      }}
    >
      <PaywallGate fallback={<UpgradeCTA />}>
        <PremiumFeature />
      </PaywallGate>

      <PaywallButton>Upgrade</PaywallButton>
    </PaywallProvider>
  );
}

function UpgradeCTA() {
  const user = usePaywallUser();
  return <p>Hi, {user?.email ?? 'guest'}! Unlock full access.</p>;
}
```

`apiOrigin` must match the `custom_domain` configured for your paywall in the
platform.

## Provider

`<PaywallProvider>` accepts one of two props:

```tsx
// Option 1 — Provider creates the instance itself
<PaywallProvider options={{ paywallId, apiOrigin, auth: true }}>

// Option 2 — host supplies a ready instance (extension / shared singleton / tests)
import { createPaywallUI } from '@monetize.software/sdk-extension';
const paywall = createPaywallUI({ paywallId, apiOrigin });

<PaywallProvider instance={paywall}>
```

If `paywallId` changes dynamically, remount the Provider via
`<PaywallProvider key={paywallId} options={...}>` — reactive option rebuilds are
intentionally not performed.

## Hooks

| Hook | Returns | When it triggers a rerender |
|---|---|---|
| `usePaywall()` | `PaywallUI \| null` | instance change (rare) |
| `usePaywallState()` | `{ open, view, error }` | any state-machine change |
| `usePaywallUser()` | `PaywallUser \| null` | `userChange` event |
| `usePaywallAccess(opts?)` | `{ status, result }` | `userChange` / `purchase_completed` |
| `usePaywallPrices()` | `{ prices, loading, error }` | bootstrap refresh |
| `usePaywallTrial()` | `TrialStatus \| null` | `trial_blocked` / `trial_expired` |
| `usePaywallVisibility()` | `VisibilityStatus \| null` | `ready` / `visibility_blocked` |
| `usePaywallEvent(event, handler)` | — | subscribes with a stable handler ref |

All hooks are safe before the Provider mounts (they return `null` / loading) —
you can use them in SSR without `'use client'` wrappers on the consuming subtree.

## Components

### `<PaywallGate>`

Declarative gate: loading → fallback → children.

```tsx
<PaywallGate
  loading={<Skeleton />}
  fallback={({ open }) => <button onClick={open}>Upgrade</button>}
  openOnBlocked={false}  // if true — calls paywall.open() automatically
>
  <PremiumFeature />
</PaywallGate>
```

### `<PaywallButton>` / `<PaywallSupportButton>`

Sugar over `paywall.open()`. By default renders a native `<button>` with all
your `className`/`disabled`/`aria-*` props forwarded. For a custom element use
the render prop:

```tsx
<PaywallButton render={({ open, ready }) => (
  <MyButton onClick={open} disabled={!ready}>Upgrade</MyButton>
)} />
```

`mode` switches between `open()` / `openSupport()` / `openAuth()` / `openAnonGate()`:

```tsx
<PaywallButton mode="support">Need help?</PaywallButton>
<PaywallButton mode="auth">Sign in</PaywallButton>
```

## SSR / Next.js

```tsx
'use client';  // on the Provider, not on the consumer subtree

import { PaywallProvider } from '@monetize.software/sdk-react';

export function PaywallProviders({ children }) {
  return (
    <PaywallProvider
      options={{
        paywallId: process.env.NEXT_PUBLIC_PAYWALL_ID!,
        apiOrigin: process.env.NEXT_PUBLIC_PAYWALL_ORIGIN!
      }}
    >
      {children}
    </PaywallProvider>
  );
}
```

Hooks can be called from server components in typed-null scenarios (they'll
return `null` / loading anyway). The recommendation is to keep hook logic in a
client component.

## SDK contract guard

`pnpm typecheck` validates [`src/contract.ts`](src/contract.ts) — it lists every
point of contact with the public SDK API (`PaywallUI` methods, snapshot fields,
event names). Any drift in `../sdk` is caught here before it hits production.

After SDK changes, refresh the dist for type resolution:

```bash
cd ../sdk && pnpm build
cd ../sdk-react && pnpm typecheck
```

## Development

```bash
pnpm install
pnpm dev          # → http://localhost:5080/demo/
pnpm typecheck    # TS validation + contract guard
pnpm test         # vitest + @testing-library/react
pnpm test:e2e     # playwright against the demo
pnpm build        # ESM + CJS + d.ts → dist/
```

## API reference

Full JSDoc comments on every public export are inline in the sources:

- [`src/PaywallProvider.tsx`](src/PaywallProvider.tsx) — Provider, lifecycle
- [`src/hooks/`](src/hooks/) — all hooks
- [`src/components/`](src/components/) — declarative components
- [`src/contract.ts`](src/contract.ts) — SDK contact points
