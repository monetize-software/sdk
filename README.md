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
