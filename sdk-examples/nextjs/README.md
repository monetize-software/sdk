# FocusFlow — Next.js + `@monetize.software/sdk-react` example

A working Next.js 16 (App Router) demo of the
[`@monetize.software/sdk-react`](https://www.npmjs.com/package/@monetize.software/sdk-react)
package. The app is a tiny Pomodoro focus timer with a real paywall —
free tier, Pro tier, login, subscription management and gated features.

Every public export from `@monetize.software/sdk-react` is used at least
once. See the [API map](#sdk-api-map) below.

## Quick start

```bash
npm install
cp .env.example .env.local   # then edit the values
npm run dev
```

Open <http://localhost:3000>.

### Configure

You need two values from the [monetize.software](https://monetize.software)
dashboard:

| variable                          | required | what it is                                          |
| --------------------------------- | -------- | --------------------------------------------------- |
| `NEXT_PUBLIC_PAYWALL_ID`          | yes      | UUID of the paywall                                 |
| `NEXT_PUBLIC_PAYWALL_API_ORIGIN`  | yes      | Your custom domain (the SDK calls it `apiOrigin`)   |

These are read once in
[`app/providers.tsx`](app/providers.tsx) and passed to
`<PaywallProvider options={…}>`.

## Pages

| route          | what it shows                                                                  |
| -------------- | ------------------------------------------------------------------------------ |
| `/`            | Landing page. `usePaywallPrices` renders the same plans as the modal.          |
| `/pricing`     | Full pricing table with `renew` flow for existing subscribers.                 |
| `/login`       | Three managed-auth entry points: signin, signup, anonymous (headless).         |
| `/app`         | The Pomodoro timer. Custom presets gated with `<PaywallGate>`.                 |
| `/app/stats`   | Stats window: 7 days free, 90 days Pro (`usePaywallAccess`).                   |
| `/app/themes`  | Pro themes behind a `<PaywallGate>` with explanatory fallback.                 |
| `/app/export`  | `<PaywallGate openOnBlocked>` — auto-opens the paywall for free users.         |
| `/account`     | User snapshot, purchases, region/trial debug.                                  |

## SDK API map

### Provider

| API                  | used in                              |
| -------------------- | ------------------------------------ |
| `PaywallProvider`    | [`app/providers.tsx`](app/providers.tsx) |

### Hooks

| hook                    | used in                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `usePaywall`            | [Navbar](app/components/Navbar.tsx), [/login](app/login/page.tsx), [/app](app/app/page.tsx), [/account](app/account/page.tsx) |
| `usePaywallState`       | [/](app/page.tsx) — pulses the CTA while the modal is opening                      |
| `usePaywallUser`        | [Navbar](app/components/Navbar.tsx), [/pricing](app/pricing/page.tsx), [/account](app/account/page.tsx) |
| `usePaywallEvent`       | [EventToaster](app/components/EventToaster.tsx)                                    |
| `usePaywallAccess`      | [/app](app/app/page.tsx), [/app/stats](app/app/stats/page.tsx), [/app/layout](app/app/layout.tsx) |
| `usePaywallPrices`      | [/](app/page.tsx), [/pricing](app/pricing/page.tsx)                                |
| `usePaywallTrial`       | [TrialBanner](app/components/TrialBanner.tsx), [/account](app/account/page.tsx)    |
| `usePaywallVisibility`  | [VisibilityBadge](app/components/VisibilityBadge.tsx), [/account](app/account/page.tsx) |

### Components

| component              | used in                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `PaywallGate`          | [/app](app/app/page.tsx) (manual CTA), [/app/themes](app/app/themes/page.tsx), [/app/export](app/app/export/page.tsx) (`openOnBlocked`) |
| `PaywallButton`        | every page that has a CTA. Modes used: default `paywall`, `signin`, `signup`, `auth` (`render`-prop), `renew` flag |
| `PaywallSupportButton` | [Footer](app/components/Footer.tsx), [/pricing](app/pricing/page.tsx), [/account](app/account/page.tsx) |

### Direct `PaywallUI` methods

Reached through `usePaywall()`:

| method                  | used in                                  |
| ----------------------- | ---------------------------------------- |
| `track(name, props)`    | [/app](app/app/page.tsx) (`host:focus_session_started`) |
| `signInAnonymously()`   | [/login](app/login/page.tsx)             |
| `auth?.signOut()`       | [Navbar](app/components/Navbar.tsx), [/account](app/account/page.tsx), [/login](app/login/page.tsx) |
| `getUserLanguage()`     | [/account](app/account/page.tsx) (debug) |

## Notes

- **App Router**: the SDK ships with a top-level `'use client'` directive,
  so `<PaywallProvider>` can be dropped into a server layout. We still wrap
  it in our own `app/providers.tsx` because we want to display a fallback
  banner when env vars are missing.
- **SSR**: hooks return `null` / `loading` before hydration. Don't rely on
  `usePaywallAccess` for SEO-critical decisions — gate features after mount.
- **Strict mode**: in dev mode React double-mounts components; the provider
  destroys and re-creates `PaywallUI` once. This is expected.
- **TypeScript**: `strict: true` works out of the box.

## Pinning vs. tracking alpha

This example pins `@monetize.software/sdk@3.0.0-alpha.9` and
`@monetize.software/sdk-react@3.0.0-alpha.9`. If you'd rather track the
alpha channel, change both to the `alpha` tag:

```json
"@monetize.software/sdk": "alpha",
"@monetize.software/sdk-react": "alpha"
```

Be aware: alpha versions can rename APIs between releases.
