# @monetize.software SDK

Drop-in paywall and subscription billing SDK for web and Chrome extensions.

This is the **monorepo** for the published packages:

| Package | Description | npm |
|---|---|---|
| [`@monetize.software/sdk`](sdk-packages/sdk) | Core SDK — `PaywallUI`, `BillingClient`, `AuthClient`, full paywall rendering and checkout flow. | [![npm](https://img.shields.io/npm/v/@monetize.software/sdk?label=)](https://www.npmjs.com/package/@monetize.software/sdk) |
| [`@monetize.software/sdk-extension`](sdk-packages/sdk-extension) | Chrome MV3 extension wrapper — same public API as the core SDK, single source of truth via offscreen document. | [![npm](https://img.shields.io/npm/v/@monetize.software/sdk-extension?label=)](https://www.npmjs.com/package/@monetize.software/sdk-extension) |
| [`@monetize.software/sdk-react`](sdk-packages/sdk-react) | React bindings — Provider, hooks, declarative components. Works with both SDKs above. | [![npm](https://img.shields.io/npm/v/@monetize.software/sdk-react?label=)](https://www.npmjs.com/package/@monetize.software/sdk-react) |

## Quick start

Pick the package(s) that match your stack — platform is independent of UI framework:

|  | Vanilla JS / TS | React |
|---|---|---|
| **Website** | `sdk` | `sdk` + `sdk-react` |
| **Chrome extension (MV3)** | `sdk-extension` | `sdk-extension` + `sdk-react` |

```bash
# Vanilla on a website
pnpm add @monetize.software/sdk

# Vanilla in a Chrome extension
pnpm add @monetize.software/sdk-extension

# React on a website
pnpm add @monetize.software/sdk @monetize.software/sdk-react react

# React in a Chrome extension
pnpm add @monetize.software/sdk-extension @monetize.software/sdk-react react
```

`sdk-react` works with both web and extension SDKs — same Provider, same hooks, same components.

**React frameworks:** `sdk-react` is SSR-safe out of the box — the Provider creates the `PaywallUI` instance inside `useEffect` and hooks return `null` / `loading` until then. Works with Next.js (App Router and Pages Router), Remix, TanStack Start, Astro, and React Server Components (use `'use client'` on the Provider).

**Other frameworks (Vue, Svelte, Solid, vanilla):** use the core `sdk` directly — its event-based API (`paywall.on('purchase_completed', ...)`) is framework-agnostic. The React bindings are a thin convenience layer, not a hard requirement.

## Via CDN (no build step)

All three packages are also reachable through any npm-fronting CDN ([esm.sh](https://esm.sh), [unpkg](https://unpkg.com), [jsDelivr](https://cdn.jsdelivr.net)). Useful for landing pages, prototypes, and embeds that don't have a bundler.

### Core SDK — single `<script>` tag

```html
<script type="module">
  import { PaywallUI } from 'https://esm.sh/@monetize.software/sdk@alpha';

  const paywall = new PaywallUI({ paywallId: 'YOUR_ID', auth: true });
  document.getElementById('upgrade').onclick = () => paywall.open();
</script>
```

Pin a specific version for production: `…/sdk@3.0.0-alpha.3` instead of `@alpha`. The `@alpha` tag floats to the latest alpha and is ideal during early integration.

Same pattern works for `@monetize.software/sdk-extension` if you're loading it from a CDN inside a Chrome extension's content script.

### React — via import map

`sdk-react` peer-depends on `react` and `@monetize.software/sdk`, so the CDN setup needs an import map that resolves all three:

```html
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@18",
    "react/jsx-runtime": "https://esm.sh/react@18/jsx-runtime",
    "react-dom/client": "https://esm.sh/react-dom@18/client",
    "@monetize.software/sdk": "https://esm.sh/@monetize.software/sdk@alpha",
    "@monetize.software/sdk-react": "https://esm.sh/@monetize.software/sdk-react@alpha?external=react,@monetize.software/sdk"
  }
}
</script>

<div id="root"></div>

<script type="module">
  import { createRoot } from 'react-dom/client';
  import { jsx } from 'react/jsx-runtime';
  import { PaywallProvider, PaywallButton } from '@monetize.software/sdk-react';

  createRoot(document.getElementById('root')).render(
    jsx(PaywallProvider, {
      options: { paywallId: 'YOUR_ID', auth: true },
      children: jsx(PaywallButton, { children: 'Upgrade' })
    })
  );
</script>
```

The `?external=react,@monetize.software/sdk` query on the `sdk-react` URL tells esm.sh to leave those imports alone so the import map can resolve them to one shared React instance — without that flag esm.sh would bundle a second React, and hooks would break with "invalid hook call".

### Alternative CDNs

- **unpkg**: `https://unpkg.com/@monetize.software/sdk@alpha`
- **jsDelivr**: `https://cdn.jsdelivr.net/npm/@monetize.software/sdk@alpha`

unpkg and jsDelivr serve the raw npm tarball — they work for ESM imports but don't rewrite bare imports the way esm.sh does, so you'll need import maps for peer deps even for core `sdk`. esm.sh is the most ergonomic for React; unpkg/jsDelivr are fine for vanilla.

### Trade-offs

CDN loading is convenient but not zero-cost: every cold visit fetches the package from the CDN edge (5–50 KB gzipped for SDK), and you don't control cache TTL or rollback. For production sites with non-trivial traffic, a real bundler (`pnpm add @monetize.software/sdk` + Vite/webpack) is faster and more predictable.

```ts
import { PaywallUI } from '@monetize.software/sdk';

const paywall = new PaywallUI({
  paywallId: 'YOUR_ID',
  auth: true
});

paywall.on('purchase_completed', (payload) => {
  console.log('User upgraded:', payload);
});

document.getElementById('upgrade')!.onclick = () => paywall.open();
```

Each package ships full TypeScript types and a thorough JSDoc-covered public surface. See per-package READMEs for in-depth usage, hooks reference, and React/extension specifics.

## Why three packages?

- **`sdk`** is the foundation — Preact rendered inside Shadow DOM, zero host CSS interference, bundled core + UI under ~70 KB gzip.
- **`sdk-extension`** is **drop-in compatible** with `sdk`'s public API. Same `PaywallUI` shape, but billing/auth/trial state lives in an offscreen document so all extension surfaces (popup, content script, background) share one source of truth.
- **`sdk-react`** is a thin (~2 KB gzip) bindings layer. It works with **any** drop-in compatible `PaywallUI` — either the web SDK or the extension SDK — via Provider's `instance={...}` prop.

A React app on a regular website uses `sdk` + `sdk-react`. A React-built Chrome extension uses `sdk-extension` + `sdk-react`. Same hooks, same components.

## Repository layout

```
sdk-packages/
├── sdk/              @monetize.software/sdk
├── sdk-extension/    @monetize.software/sdk-extension
└── sdk-react/        @monetize.software/sdk-react
```

The monorepo is a pnpm workspace. All three packages share lockfile, dependency hoisting, and release orchestration via [Changesets](.changeset/README.md).

## Development

```bash
pnpm install                # install everything
pnpm dev                    # sdk in --watch + sdk-react dev server, concurrently
pnpm typecheck              # tsc --noEmit across all packages
pnpm test                   # vitest run across all packages
pnpm build                  # build all packages topologically (sdk → sdk-react)
```

Run scoped commands with pnpm filters:

```bash
pnpm --filter @monetize.software/sdk-react test
pnpm --filter @monetize.software/sdk build
```

## Releases

Release orchestration is handled by [Changesets](https://github.com/changesets/changesets) — automatic transitive version bumps, CHANGELOG generation, and topological npm publishing.

```bash
# Describe a change (interactive)
pnpm changeset

# Cut a stable release
pnpm release

# Cut an alpha release
pnpm release:alpha
```

See [`.changeset/README.md`](.changeset/README.md) for the full release flow including alpha-channel and prerelease modes.

## Contributing

Issues and pull requests are welcome. Each package directory has its own focused README and tests; the type-level contract in [`sdk-react/src/contract.ts`](sdk-packages/sdk-react/src/contract.ts) catches breaking changes between `sdk` and `sdk-react` at TypeScript compile time.

## License

MIT — see [LICENSE](sdk-packages/sdk/LICENSE).
