# @monetize.software/sdk-extension

## 3.0.0

### Minor Changes

- 3b7a329: Auth flow overhaul, signout listener fixes, i18n gate, support form polish

  **sdk — new auth API**

  - `paywall.openSignin()` / `paywall.openSignup()` — explicit shortcuts for opening the auth gate directly in signin or signup mode. `openAuth()` retained as an alias for signin (back-compat).
  - `paywall.signInAnonymously()` — headless promise-returning method for anonymous signin. No modal, host manages loading state on its own button.

  **sdk — BREAKING removals**

  - `paywall.openAnonGate()` removed — replaced by headless `signInAnonymously()`. The half-empty modal-with-spinner pattern was poor UX; hosts already render their own loading state on the triggering button.
  - `AnonGate` component, `'anon'` from `PaywallView` union, `'anon_gate'` from `GateState` — all related rendering and state-machine plumbing removed (~290 LoC gone).

  **sdk — auth flow fixes**

  - `AuthPanel`: new `signup_verify` mode separate from `reset_verify` — after signup with `confirmation_required` the form no longer shows the misleading "Reset password" header + password field. Header reads "Confirm your email" with a single OTP-code input.
  - `AuthPanel`: removed redundant "Last used · email" badge above the signin submit button — the email field is already pre-filled from `getLastLogin()`.
  - `BillingClient.setIdentity(undefined)` (signout) now emits `applyUser(EMPTY_USER)` + `applyBalances([])` so `onUserChange` / `onBalanceChange` listeners receive the guest-state transition. Previously listeners never fired on signout, leaving consumers with stale premium state in their cache (visible bug in extension content-script widgets).
  - `PaywallRoot`: `openSupport()` / `openSignin()` / `openSignup()` on a paywall for an already-subscribed user no longer get hijacked by the `purchase_success` restored-view on first click. Standalone flows now bypass the auto-restored gate.
  - `PaywallRoot.AwaitingPaymentView`: added horizontal padding so the "← Back" button and "Checkout window didn't open" card no longer collide with the dialog X-close button.
  - `SupportGate`: submit button no longer silently disabled when input is invalid. Validation fires on click with inline errors under each field; previously users couldn't tell why the button was greyed out (e.g. subject < 3 chars).

  **sdk — i18n**

  - Per-locale gate: SDK now only loads the static UI chunk when there is a dynamic override for the resolved locale in `bootstrap.locales`. Previously a paywall translated to RU only would still load the NL static chunk for NL users, producing a mixed NL UI + EN content paywall. Now an NL user with no NL dynamic override gets the clean EN fallback.
  - New keys: `auth.confirm_email_title`, `auth.confirm_email_subtitle` for the signup-confirm flow (RU + 10 major locales translated).
  - Filled missing RU/UK translations for: `auth.reset_password_subtitle`, `payment.awaiting_subtitle`, `payment.still_processing`, `payment.popup_help_text`, `payment.tab_closed_retry`, `payment.popup_blocked_title`, `payment.popup_blocked_message`.

  **sdk-extension**

  - Picks up the SDK changes via workspace dep — no API surface change in `sdk-extension` itself.
  - Demo extension (`demo-extension/`) is not published; included for development reference only. It exercises all the new SDK APIs: `openSignin` / `openSignup` / `signInAnonymously` / `openSupport`, the floating widget reactively shows guest/premium state through the now-correct signout listener fires, and the 401 recovery flow uses headless anon signin instead of the removed `openAnonGate()`.

  **sdk-react — BREAKING changes**

  - `<PaywallButton>` `mode` prop:
    - **Removed** `'anon'` — for anonymous signin use `usePaywall().signInAnonymously()` directly so you can render your own button-level loading state.
    - **Added** `'signin'` (explicit alternative to `'auth'`) and `'signup'` (opens the auth gate directly in signup mode).
    - `'auth'` retained as alias for `'signin'` (back-compat).
  - Contract assertions in `contract.ts` updated: `openSignin` / `openSignup` / `signInAnonymously` now required, `openAnonGate` removed from `RequiredMethods`. TypeScript will surface any host code still calling the removed method.

  **Backend (online) — also updated alongside this release**

  `/api/v1/paywall/[id]/auth/password/request-reset`, `/auth/email/signup`, `/auth/email/resend` and `/auth/otp/send` now resolve `redirect_to` from `custom_domain` server-side. GoTrue magic-links in confirmation / recovery emails redirect to `<custom_domain>/paywall/auth/reset` or `<custom_domain>/paywall/auth/confirm` (new landing page added). Previously links fell back to the platform default Site URL.

- 088397f: Auth/extension/i18n fixes:

  - **Anonymous sign-in option renamed.** `AuthClient.signInAnonymously({ forceCaptcha })` → `signInAnonymously({ forceNewAnon })`. Same semantics (skip idempotent + resume, force a fresh anon `/signin`), clearer name now that captcha is no longer in the flow. The extension transport (`auth.signInAnonymously`) field is renamed too. **Breaking** for callers that passed `forceCaptcha: true` — search/replace to `forceNewAnon: true`.
  - **MV3 onConnect duplicate-handler fix (sdk-extension).** `chrome.runtime.connect` is delivered to _every_ extension context with an `onConnect` listener — including offscreen, alongside the SW. With a single shared port name, one `popup.connect()` opened two ports in offscreen (SW relay + direct popup), so each popup → SW send was handled twice. Split into `PORT_NAME` (content/popup → SW) and `RELAY_PORT_NAME` (SW → offscreen); offscreen now accepts only the relay name.
  - **AuthPanel double-submit guard.** `useRef` synchronous guard around `onSubmit`/`onOAuth`. `setBusy` is async setState; back-to-back submits in one tick (Enter + click, demo-ext double-mount, transport race) both passed the `if (busy) return` check and fired the network request twice (e.g. double `requestPasswordReset`).
  - **i18n: `auth.rate_limited` copy.** "Too many requests. Please try again **later**." (was "in a moment"). More accurate for Supabase rate-limit windows (minutes, not seconds). Translated across all 27 locales.

### Patch Changes

- 5902c36: UI: last-sign-in-method badge next to the OAuth buttons — "Last" → "Last used" (clearer that it means "last used method").

  Renamed in canonical EN, the `AuthPanel` inline fallbacks and across all 27 locales
  (`auth.last_used` / `auth.last_used_no_email`): EN `Last used · {email}`, RU
  `Последний вход · …`, DE `Zuletzt genutzt`, ES `Última vez`, JA `前回使用`, etc.
  Also closed a coverage gap — previously `auth.last_used` (with email) was only
  partially translated and some locales fell back to the English inline fallback.

- c13ffc5: Auth: `AuthUser` now carries the profile from the OAuth provider — `name` and `avatar`.

  Previously the SDK exposed only `{ id, email, country, is_anonymous }`, and the avatar (Google
  puts it in `user_metadata.avatar_url`) was never surfaced anywhere. Added
  optional `name` / `avatar` to `AuthUser` — filled from the OAuth profile at
  `/oauth/exchange` and available from the session (`auth.getCachedUser()?.avatar`,
  `onAuthChange`) without an extra request. For email/anon users they are `null` (no avatar).

  Requires a paired online deploy (`/oauth/exchange` now puts `name`/`avatar` from
  `user_metadata`). Without it the fields will be `undefined` — does not break existing behavior.

- 8b859cb: Fix the awaiting screen hanging after payment on an extension page.

  The awaiting→success transition was wired **exclusively** to `UserWatcher.onActive`,
  and the watcher itself didn't run for the entire `chrome-extension://` protocol
  (`shouldRunUserWatcher` treated any such context as an ephemeral action-popup).
  On a full extension page (side panel / standalone tab) that survives the
  checkout, the poller was off and there was no one to close the awaiting screen — even
  the manual "I've paid" button only sent `window.postMessage` to wake a
  nonexistent watcher. The purchase went through, `/user-state` returned
  `has_active_subscription: true`, and the screen kept hanging.

  - The transition is centralized in the idempotent `handlePurchaseDetected`, which
    is called from `billing.onUserChange` — any source of fresh active
    user-state (manual `getUser`, cross-context broadcast, watcher) closes the
    awaiting screen. Gated on the checkout views (`awaiting_payment`/`popup_blocked`) so that
    opening the paywall for an already-subscribed user doesn't trigger a false positive.
  - `shouldRunUserWatcher` no longer cuts off `chrome-extension://` — a surviving
    page both can and should poll; an ephemeral action-popup harmlessly
    tears down with its context (detection there covers bootstrap on the
    next open).

- c6418f7: Server-SDK: manual token credit/debit — `BillingClient.creditTokens()` / `debitTokens()`.

  apiKey-only methods that adjust the token balance of a user of a tokenized paywall on behalf of
  the merchant backend (identity by email/userId). `creditTokens` adds, `debitTokens`
  subtracts and throws `PaywallError('insufficient')` if it would go below zero.
  Not available from the browser (no apiKey → `apikey_required`) — a client must not be able to
  credit itself tokens. They return `{ type, count }` with the new balance.

  Requires a paired deploy: online endpoint `POST /api/v1/paywall/[id]/balances` +
  applying the SQL migration `adjust_paywall_balance` (atomic delta in JSONB, with no
  lost-update from concurrent api-gateway debits). Does not overwrite daily-trial balances above
  the limit.

- a6b7a3a: Removed the `paywall_opened` analytics event. Showing a paywall now records
  a single signal — `paywall_viewed` (emitted on `'ready'`, after the
  bootstrap loads, with `prices_count`/`offers_count`/`is_test_mode`). `'open'` is no longer
  tracked separately in either the main SDK or the extension channel.

  Motivation: `opened` and `viewed` duplicated each other in the dominant pattern
  (warm bootstrap → both events in one batch), and the extra event on every
  open multiplied the POST load on `/events` and the rows in `paywall_sdk_events`
  at prod scale (thousands of simultaneous opens). The funnel is built from
  `viewed`. The server (`online`) no longer accepts `paywall_opened` in the whitelist.

- 63dc291: Fix diverging focus and selection when the paywall opens.

  On auto-open of the modal (without a preceding user gesture) the browser's
  `:focus-visible` heuristic drew a ring on the first focusable control — but the
  first `button` in the DOM is the first plan card (e.g. monthly), whereas the
  _selected_ plan is the popular one (`popular_price_id`), which has the accent border.
  The focus ring landed on one card and the selection highlight on another; two
  conflicting "active" states were confusing.

  `Modal` no longer moves focus to the first interactive element — focus goes
  to the dialog container itself (`tabIndex=-1`, `outline-none` → no ring). The focus
  trap keeps the anchor inside the dialog, `Tab` walks the controls as before, and for
  screen readers focus on the `aria-modal` dialog is correct. Added an explicit opt-in
  `[data-pw-autofocus]` for views that need input autofocus.

- da0c8c5: OAuth identity-already-linked: classification by error description — resilience to version skew callback↔SDK.

  In prod it turned out that the hosted OAuth-callback may forward only the
  human-readable `error_description` ("Identity is already linked to another
  user"), but NOT the machine `error_code` (the callback page deploys independently of the
  npm-SDK; an old/cached build doesn't pass `error_code`). beta.9
  classified switch-account only by `errorCode`, so
  `identity_already_exists` arrived as a generic `oauth_failed` → "Sign-in failed"
  with no button.

  - `isIdentityAlreadyLinked()` now matches both `errorCode === 'identity_already_exists'`
    and the error text (`already linked` / `identity_already_exists`) as a fallback —
    the "sign in with that account" button is shown regardless of whether the
    deployed callback forwards `error_code`.

- f128fd3: OAuth: auto-switch to an existing account on `identity_already_exists` + clear UX for the email collision.

  Previously, signing in via Google/Apple under an anonymous session went through `linkIdentity`, and if
  the provider was already linked to another account, GoTrue returned `identity_already_exists`,
  and the SDK showed a dead-end "Sign-in failed".

  - `signInWithOAuth` catches `identity_already_exists` and seamlessly switches to a regular
    signin, **reusing the same popup** (`popup.location.replace` to the signin flow with the same
    state; the provider SSO is already active → near-instant). Added `switchAccount` to
    `signInWithOAuth`/`startOAuthFlow` (doesn't send Bearer → no linkIdentity) and `waitForOAuthResult`
    (a structured outcome with `errorCode`, doesn't close the popup itself). If the popup can't be reused
    (COOP severed the handle) — a fallback "sign in to that account" button (a fresh user gesture).
    Mirrored in the `sdk-extension` split-flow (`auth.oauthStart` got
    `switchAccount`/`reuseState`).
  - Email collision: due to anti-enumeration GoTrue masks a taken email (including an OAuth-only one)
    as "confirm your email". `signUp` now returns `already_registered`, and `AuthPanel`
    routes the user to the signin form with a clear hint instead of the "check your email" dead-end.
  - New i18n keys `auth.email_already_registered` / `auth.identity_already_linked`
    (canonical EN + 27 locales).

  Requires a paired deploy of the online part (the v3 OAuth callback now passes `error_code` and
  doesn't close the popup on `identity_already_exists`; `/auth/email/signup` returns
  `already_registered`). An old SDK with the new callback and a new SDK with the old callback
  degrade gracefully — without endless popups.

- 4a8a00a: OAuth `identity_already_exists`: reliable one-click "switch account" instead of seamless popup-reuse.

  beta.8 tried to seamlessly switch accounts by reusing the same popup
  (`popup.location.replace`). In a real environment this is unstable: COOP (Google)
  severs the opener↔popup handle, and a second exchange in the same flow added a point of failure —
  ending up surfacing a generic "Sign-in failed" instead of the switch branch.

  - Dropped popup-reuse. `identity_already_exists` is now passed straight through as
    `oauth_identity_already_linked`, and `AuthPanel` shows clear text +
    a "Continue with <provider>" button. A fresh click → `signInWithOAuth({ switchAccount: true })`
    → a clean signin (new popup, new PKCE exchange) into the account that owns the
    identity. Parity with the legacy `switch_account` branch.
  - `AuthPanel` logs the actual OAuth-error code/description to `console.warn` —
    previously the generic fallback hid the cause.
  - Removed the unused `reuseState` from `startOAuthFlow` and `auth.oauthStart`.

- 67e0954: Paywall modal fixes and success-screen wording.

  **1. Scroll for self-contained status views.** The modal dialog is height-constrained
  (`max-h … overflow-hidden`), but the scroll zone (`flex-1 min-h-0 overflow-y-auto`)
  was set up only by `Renderer`/`AuthGate`/`SupportGate`. Simple status views
  (`PurchaseSuccessView`, `LoadingView`, `ErrorView`, `AwaitingPaymentView`,
  `PopupBlockedView`) rendered without a wrapper and, when height was short (small
  screens, an extension popup ~600px), were clipped with no way to scroll.
  Added a shared `Scroll` wrapper for these views; `Renderer`/`AuthGate`/`SupportGate`
  are not wrapped — they have their own scroll + a pinned footer.

  **2. Horizontal padding for `PurchaseSuccessView`.** The view root had only
  vertical padding, while the `Continue` button was `w-full`, so it
  stretched to the dialog edges and its glow/shimmer spilled over the edge. Added
  `px-6 sm:px-8` — matching the neighboring views.

  **3. Neutral success/restored wording.** "Your subscription is now
  active." / "Subscription restored" are incorrect for lifetime purchases (those aren't
  a subscription). Success subtitle → "You're all set — enjoy!", restored title →
  "Welcome back", restored subtitle → the same "You're all set — enjoy!". Updated the
  EN reference, inline fallbacks and all 27 locales (`tools/sdk-translations.mjs` +
  regenerating `gen-locales.mjs`).

- 9399d2e: docs: README cleanup across all three packages

  - **sdk**: dropped stale "Not in this version (alpha)" block that listed Auth, trials, i18n, React adapter and tests as missing — all shipped. Replaced with an accurate "What's included" section. Added required `apiOrigin` (custom_domain) to Quick start and ApiGateway examples. Expanded provider list to the real set: Stripe / Paddle / Freemius / Chargebee / Overpay. Removed broken `../TODO.md` link. Clarified CDN policy: allowed for websites, forbidden for Chrome extensions.
  - **sdk-extension**: fixed `host_permissions` manifest snippet — was `["https://api.monetize.software/*"]` (a domain that doesn't exist), now points to the host's own `apiOrigin` (custom_domain) with a placeholder. Removed the misleading `"permissions": ["identity"]` optional line — SDK does not use `chrome.identity` (OAuth runs via a popup window against the host's `apiOrigin`). Removed the stale "Phase 0 — skeleton" status block and "Usage (target shape, when complete)" framing — package is published and in use. Architecture diagram annotation corrected to reflect the popup-window OAuth flow.
  - **sdk-react**: translated README from Russian to English to match the other two packages. Added required `apiOrigin` to Quick start and SSR/Next.js examples.

  No code changes.

- c72ee97: docs/meta: README trim + npm keywords

  - **sdk**: dropped the "Status: alpha" note from the README.
  - **all three**: added `keywords` to `package.json` for npm discoverability (paywall, billing, subscriptions, monetization, checkout, …; plus per-package react / chrome-extension / manifest-v3 terms).
  - Monorepo README: removed the CDN "React via import map", "Alternative CDNs" and "Trade-offs" subsections; React-on-website now points at the bundler install path.

  No code changes.

- 3b263a1: docs: prominent warning that Chrome Web Store MV3 policy forbids loading any `@monetize.software/*` package from a CDN (esm.sh / unpkg / jsDelivr) inside content scripts, popups, or service workers. Extension authors must `pnpm add @monetize.software/sdk-extension` and bundle it like a regular npm dependency — `sdk-extension` exists as a separate package precisely so the content-script build inlines all SDK code at build time and never fetches remote JS at runtime.

  No code changes. README-only update so the warning shows on the npm package page in addition to the GitHub repo.

- 7ef8553: fix(dts): broaden the published `.d.ts` path rewrite to cover `../sdk/src/ui/...`
  imports as well — the previous fix only matched `core/...`. Result: `PaywallUI`
  extends `BasePaywallUI` and now resolves to real method signatures
  (`auth`, `billing`, `open()`, `signInAnonymously()`, `on()`, …) for downstream
  hosts instead of `any`.
- 7ef8553: fix(dts): rewrite emitted `.d.ts` imports from the dev-only `../sdk/src`
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

- 3b263a1: Popup bug fixes + UI polish

  - `PaywallRoot`: an anon session no longer blocks the "Restore Purchases" button and preauth-checkout (treated as "not logged in" in both places, consistent with `CurrentSession`/`AuthPanel`)
  - `PaywallRoot`: the X-close returns to standalone `openAuth()` — without the Back arrow the modal couldn't be closed except via ESC
  - `PaywallRoot`: `useLayoutEffect` instead of `useEffect` for syncing gate-state on `open/initialView` — fixes a flash of the plans layout on a repeat `openAuth()` (noticeable in the extension popup because of RemoteAuth/RemoteBilling RTT)
  - `RemoteAuthClient`: implemented `getLastLogin()` (was not mirrored, AuthPanel crashed with `r.getLastLogin is not a function` in the popup console)
  - `AuthPanel`: defensive guard on `getLastLogin` — old sdk-extension builds / custom AuthClients don't break the signin form
  - Compile-time tests: `RemoteAuthClient.test-d.ts` and `RemoteBillingClient.test-d.ts` catch divergences of the proxy classes from the base ones already at `tsc --noEmit`

- 0605621: The SDK version is injected from package.json at build time rather than hardcoded.

  `SDK_VERSION` sat as a hardcoded literal `'3.0.0-alpha.0'` through all
  releases (alpha.x → beta.x) — it was never bumped. It goes into `X-SDK-Version`
  on all requests, into `sdk_version` of every analytics event (ClickHouse) and into
  ApiGateway, so all version analytics were blind: events from all releases were
  written as a single version.

  Now the version is passed from package.json via vite `define`
  (`__SDK_VERSION__`) — a string literal in the bundle, in `.d.ts` it stays
  `const SDK_VERSION: string`. `define` is duplicated in vitest.config (it does not
  inherit vite.config), otherwise the token wouldn't be substituted in tests.

- Updated dependencies [3b7a329]
- Updated dependencies [5902c36]
- Updated dependencies [088397f]
- Updated dependencies [2851b7f]
- Updated dependencies [f513233]
- Updated dependencies [619730d]
- Updated dependencies [c13ffc5]
- Updated dependencies [8b859cb]
- Updated dependencies [179e4a6]
- Updated dependencies [088397f]
- Updated dependencies [c6418f7]
- Updated dependencies [e9f3308]
- Updated dependencies [0e757ec]
- Updated dependencies [a6b7a3a]
- Updated dependencies [4845938]
- Updated dependencies [63dc291]
- Updated dependencies [da0c8c5]
- Updated dependencies [f128fd3]
- Updated dependencies [4a8a00a]
- Updated dependencies [638fa26]
- Updated dependencies [8250085]
- Updated dependencies [d6fce2e]
- Updated dependencies [87c0607]
- Updated dependencies [73d9627]
- Updated dependencies [67e0954]
- Updated dependencies [50d3378]
- Updated dependencies [9399d2e]
- Updated dependencies [c72ee97]
- Updated dependencies [3b263a1]
- Updated dependencies [7ef8553]
- Updated dependencies [49a342e]
- Updated dependencies [3b263a1]
- Updated dependencies [0605621]
- Updated dependencies [3d325f9]
  - @monetize.software/sdk@3.0.0

## 3.0.0-beta.13

### Patch Changes

- Server-SDK: manual token credit/debit — `BillingClient.creditTokens()` / `debitTokens()`.

  apiKey-only methods that adjust the token balance of a user of a tokenized paywall on behalf of
  the merchant backend (identity by email/userId). `creditTokens` adds, `debitTokens`
  subtracts and throws `PaywallError('insufficient')` if it would go below zero.
  Not available from the browser (no apiKey → `apikey_required`) — a client must not be able to
  credit itself tokens. They return `{ type, count }` with the new balance.

  Requires a paired deploy: online endpoint `POST /api/v1/paywall/[id]/balances` +
  applying the SQL migration `adjust_paywall_balance` (atomic delta in JSONB, with no
  lost-update from concurrent api-gateway debits). Does not overwrite daily-trial balances above
  the limit.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.13

## 3.0.0-beta.12

### Patch Changes

- Auth: `AuthUser` now carries the profile from the OAuth provider — `name` and `avatar`.

  Previously the SDK exposed only `{ id, email, country, is_anonymous }`, and the avatar (Google
  puts it in `user_metadata.avatar_url`) was never surfaced anywhere. Added
  optional `name` / `avatar` to `AuthUser` — filled from the OAuth profile at
  `/oauth/exchange` and available from the session (`auth.getCachedUser()?.avatar`,
  `onAuthChange`) without an extra request. For email/anon users they are `null` (no avatar).

  Requires a paired online deploy (`/oauth/exchange` now puts `name`/`avatar` from
  `user_metadata`). Without it the fields will be `undefined` — does not break existing behavior.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.12

## 3.0.0-beta.11

### Patch Changes

- UI: last-sign-in-method badge next to the OAuth buttons — "Last" → "Last used" (clearer that it means "last used method").

  Renamed in canonical EN, the `AuthPanel` inline fallbacks and across all 27 locales
  (`auth.last_used` / `auth.last_used_no_email`): EN `Last used · {email}`, RU
  `Последний вход · …`, DE `Zuletzt genutzt`, ES `Última vez`, JA `前回使用`, etc.
  Also closed a coverage gap — previously `auth.last_used` (with email) was only
  partially translated and some locales fell back to the English inline fallback.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.11

## 3.0.0-beta.10

### Patch Changes

- OAuth identity-already-linked: classification by error description — resilience to version skew callback↔SDK.

  In prod it turned out that the hosted OAuth-callback may forward only the
  human-readable `error_description` ("Identity is already linked to another
  user"), but NOT the machine `error_code` (the callback page deploys independently of the
  npm-SDK; an old/cached build doesn't pass `error_code`). beta.9
  classified switch-account only by `errorCode`, so
  `identity_already_exists` arrived as a generic `oauth_failed` → "Sign-in failed"
  with no button.

  - `isIdentityAlreadyLinked()` now matches both `errorCode === 'identity_already_exists'`
    and the error text (`already linked` / `identity_already_exists`) as a fallback —
    the "sign in with that account" button is shown regardless of whether the
    deployed callback forwards `error_code`.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.10

## 3.0.0-beta.9

### Patch Changes

- OAuth `identity_already_exists`: reliable one-click "switch account" instead of seamless popup-reuse.

  beta.8 tried to seamlessly switch accounts by reusing the same popup
  (`popup.location.replace`). In a real environment this is unstable: COOP (Google)
  severs the opener↔popup handle, and a second exchange in the same flow added a point of failure —
  ending up surfacing a generic "Sign-in failed" instead of the switch branch.

  - Dropped popup-reuse. `identity_already_exists` is now passed straight through as
    `oauth_identity_already_linked`, and `AuthPanel` shows clear text +
    a "Continue with <provider>" button. A fresh click → `signInWithOAuth({ switchAccount: true })`
    → a clean signin (new popup, new PKCE exchange) into the account that owns the
    identity. Parity with the legacy `switch_account` branch.
  - `AuthPanel` logs the actual OAuth-error code/description to `console.warn` —
    previously the generic fallback hid the cause.
  - Removed the unused `reuseState` from `startOAuthFlow` and `auth.oauthStart`.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.9

## 3.0.0-beta.8

### Patch Changes

- OAuth: auto-switch to an existing account on `identity_already_exists` + clear UX for the email collision.

  Previously, signing in via Google/Apple under an anonymous session went through `linkIdentity`, and if
  the provider was already linked to another account, GoTrue returned `identity_already_exists`,
  and the SDK showed a dead-end "Sign-in failed".

  - `signInWithOAuth` catches `identity_already_exists` and seamlessly switches to a regular
    signin, **reusing the same popup** (`popup.location.replace` to the signin flow with the same
    state; the provider SSO is already active → near-instant). Added `switchAccount` to
    `signInWithOAuth`/`startOAuthFlow` (doesn't send Bearer → no linkIdentity) and `waitForOAuthResult`
    (a structured outcome with `errorCode`, doesn't close the popup itself). If the popup can't be reused
    (COOP severed the handle) — a fallback "sign in to that account" button (a fresh user gesture).
    Mirrored in the `sdk-extension` split-flow (`auth.oauthStart` got
    `switchAccount`/`reuseState`).
  - Email collision: due to anti-enumeration GoTrue masks a taken email (including an OAuth-only one)
    as "confirm your email". `signUp` now returns `already_registered`, and `AuthPanel`
    routes the user to the signin form with a clear hint instead of the "check your email" dead-end.
  - New i18n keys `auth.email_already_registered` / `auth.identity_already_linked`
    (canonical EN + 27 locales).

  Requires a paired deploy of the online part (the v3 OAuth callback now passes `error_code` and
  doesn't close the popup on `identity_already_exists`; `/auth/email/signup` returns
  `already_registered`). An old SDK with the new callback and a new SDK with the old callback
  degrade gracefully — without endless popups.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.8

## 3.0.0-beta.7

### Patch Changes

- Fix the awaiting screen hanging after payment on an extension page.

  The awaiting→success transition was wired **exclusively** to `UserWatcher.onActive`,
  and the watcher itself didn't run for the entire `chrome-extension://` protocol
  (`shouldRunUserWatcher` treated any such context as an ephemeral action-popup).
  On a full extension page (side panel / standalone tab) that survives the
  checkout, the poller was off and there was no one to close the awaiting screen — even
  the manual "I've paid" button only sent `window.postMessage` to wake a
  nonexistent watcher. The purchase went through, `/user-state` returned
  `has_active_subscription: true`, and the screen kept hanging.

  - The transition is centralized in the idempotent `handlePurchaseDetected`, which
    is called from `billing.onUserChange` — any source of fresh active
    user-state (manual `getUser`, cross-context broadcast, watcher) closes the
    awaiting screen. Gated on the checkout views (`awaiting_payment`/`popup_blocked`) so that
    opening the paywall for an already-subscribed user doesn't trigger a false positive.
  - `shouldRunUserWatcher` no longer cuts off `chrome-extension://` — a surviving
    page both can and should poll; an ephemeral action-popup harmlessly
    tears down with its context (detection there covers bootstrap on the
    next open).

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.7

## 3.0.0-beta.6

### Patch Changes

- The SDK version is injected from package.json at build time rather than hardcoded.

  `SDK_VERSION` sat as a hardcoded literal `'3.0.0-alpha.0'` through all
  releases (alpha.x → beta.x) — it was never bumped. It goes into `X-SDK-Version`
  on all requests, into `sdk_version` of every analytics event (ClickHouse) and into
  ApiGateway, so all version analytics were blind: events from all releases were
  written as a single version.

  Now the version is passed from package.json via vite `define`
  (`__SDK_VERSION__`) — a string literal in the bundle, in `.d.ts` it stays
  `const SDK_VERSION: string`. `define` is duplicated in vitest.config (it does not
  inherit vite.config), otherwise the token wouldn't be substituted in tests.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.6

## 3.0.0-beta.5

### Patch Changes

- Fix diverging focus and selection when the paywall opens.

  On auto-open of the modal (without a preceding user gesture) the browser's
  `:focus-visible` heuristic drew a ring on the first focusable control — but the
  first `button` in the DOM is the first plan card (e.g. monthly), whereas the
  _selected_ plan is the popular one (`popular_price_id`), which has the accent border.
  The focus ring landed on one card and the selection highlight on another; two
  conflicting "active" states were confusing.

  `Modal` no longer moves focus to the first interactive element — focus goes
  to the dialog container itself (`tabIndex=-1`, `outline-none` → no ring). The focus
  trap keeps the anchor inside the dialog, `Tab` walks the controls as before, and for
  screen readers focus on the `aria-modal` dialog is correct. Added an explicit opt-in
  `[data-pw-autofocus]` for views that need input autofocus.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.5

## 3.0.0-beta.4

### Patch Changes

- Paywall modal fixes and success-screen wording.

  **1. Scroll for self-contained status views.** The modal dialog is height-constrained
  (`max-h … overflow-hidden`), but the scroll zone (`flex-1 min-h-0 overflow-y-auto`)
  was set up only by `Renderer`/`AuthGate`/`SupportGate`. Simple status views
  (`PurchaseSuccessView`, `LoadingView`, `ErrorView`, `AwaitingPaymentView`,
  `PopupBlockedView`) rendered without a wrapper and, when height was short (small
  screens, an extension popup ~600px), were clipped with no way to scroll.
  Added a shared `Scroll` wrapper for these views; `Renderer`/`AuthGate`/`SupportGate`
  are not wrapped — they have their own scroll + a pinned footer.

  **2. Horizontal padding for `PurchaseSuccessView`.** The view root had only
  vertical padding, while the `Continue` button was `w-full`, so it
  stretched to the dialog edges and its glow/shimmer spilled over the edge. Added
  `px-6 sm:px-8` — matching the neighboring views.

  **3. Neutral success/restored wording.** "Your subscription is now
  active." / "Subscription restored" are incorrect for lifetime purchases (those aren't
  a subscription). Success subtitle → "You're all set — enjoy!", restored title →
  "Welcome back", restored subtitle → the same "You're all set — enjoy!". Updated the
  EN reference, inline fallbacks and all 27 locales (`tools/sdk-translations.mjs` +
  regenerating `gen-locales.mjs`).

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.4

## 3.0.0-beta.3

### Patch Changes

- a6b7a3a: Removed the `paywall_opened` analytics event. Showing a paywall now records
  a single signal — `paywall_viewed` (emitted on `'ready'`, after the
  bootstrap loads, with `prices_count`/`offers_count`/`is_test_mode`). `'open'` is no longer
  tracked separately in either the main SDK or the extension channel.

  Motivation: `opened` and `viewed` duplicated each other in the dominant pattern
  (warm bootstrap → both events in one batch), and the extra event on every
  open multiplied the POST load on `/events` and the rows in `paywall_sdk_events`
  at prod scale (thousands of simultaneous opens). The funnel is built from
  `viewed`. The server (`online`) no longer accepts `paywall_opened` in the whitelist.

- Updated dependencies [a6b7a3a]
  - @monetize.software/sdk@3.0.0-beta.3

## 3.0.0-beta.2

### Patch Changes

- Updated dependencies [179e4a6]
  - @monetize.software/sdk@3.0.0-beta.2

## 3.0.0-beta.1

### Patch Changes

- docs/meta: README trim + npm keywords

  - **sdk**: dropped the "Status: alpha" note from the README.
  - **all three**: added `keywords` to `package.json` for npm discoverability (paywall, billing, subscriptions, monetization, checkout, …; plus per-package react / chrome-extension / manifest-v3 terms).
  - Monorepo README: removed the CDN "React via import map", "Alternative CDNs" and "Trade-offs" subsections; React-on-website now points at the bundler install path.

  No code changes.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.1

## 3.0.0-beta.0

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.0

## 3.0.0-alpha.25

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.22

## 3.0.0-alpha.24

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.21

## 3.0.0-alpha.23

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.20

## 3.0.0-alpha.22

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.19

## 3.0.0-alpha.21

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.18

## 3.0.0-alpha.20

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.17

## 3.0.0-alpha.19

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.16

## 3.0.0-alpha.18

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.15

## 3.0.0-alpha.17

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.14

## 3.0.0-alpha.16

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.13

## 3.0.0-alpha.15

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.12

## 3.0.0-alpha.14

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.11

## 3.0.0-alpha.13

### Patch Changes

- fix(dts): broaden the published `.d.ts` path rewrite to cover `../sdk/src/ui/...`
  imports as well — the previous fix only matched `core/...`. Result: `PaywallUI`
  extends `BasePaywallUI` and now resolves to real method signatures
  (`auth`, `billing`, `open()`, `signInAnonymously()`, `on()`, …) for downstream
  hosts instead of `any`.

## 3.0.0-alpha.12

### Patch Changes

- fix(dts): rewrite emitted `.d.ts` imports from the dev-only `../sdk/src`
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

## 3.0.0-alpha.11

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.10

## 3.0.0-alpha.10

### Minor Changes

- Auth/extension/i18n fixes:

  - **Anonymous sign-in option renamed.** `AuthClient.signInAnonymously({ forceCaptcha })` → `signInAnonymously({ forceNewAnon })`. Same semantics (skip idempotent + resume, force a fresh anon `/signin`), clearer name now that captcha is no longer in the flow. The extension transport (`auth.signInAnonymously`) field is renamed too. **Breaking** for callers that passed `forceCaptcha: true` — search/replace to `forceNewAnon: true`.
  - **MV3 onConnect duplicate-handler fix (sdk-extension).** `chrome.runtime.connect` is delivered to _every_ extension context with an `onConnect` listener — including offscreen, alongside the SW. With a single shared port name, one `popup.connect()` opened two ports in offscreen (SW relay + direct popup), so each popup → SW send was handled twice. Split into `PORT_NAME` (content/popup → SW) and `RELAY_PORT_NAME` (SW → offscreen); offscreen now accepts only the relay name.
  - **AuthPanel double-submit guard.** `useRef` synchronous guard around `onSubmit`/`onOAuth`. `setBusy` is async setState; back-to-back submits in one tick (Enter + click, demo-ext double-mount, transport race) both passed the `if (busy) return` check and fired the network request twice (e.g. double `requestPasswordReset`).
  - **i18n: `auth.rate_limited` copy.** "Too many requests. Please try again **later**." (was "in a moment"). More accurate for Supabase rate-limit windows (minutes, not seconds). Translated across all 27 locales.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.9

## 3.0.0-alpha.9

### Minor Changes

- Auth flow overhaul, signout listener fixes, i18n gate, support form polish

  **sdk — new auth API**

  - `paywall.openSignin()` / `paywall.openSignup()` — explicit shortcuts for opening the auth gate directly in signin or signup mode. `openAuth()` retained as an alias for signin (back-compat).
  - `paywall.signInAnonymously()` — headless promise-returning method for anonymous signin. No modal, host manages loading state on its own button.

  **sdk — BREAKING removals**

  - `paywall.openAnonGate()` removed — replaced by headless `signInAnonymously()`. The half-empty modal-with-spinner pattern was poor UX; hosts already render their own loading state on the triggering button.
  - `AnonGate` component, `'anon'` from `PaywallView` union, `'anon_gate'` from `GateState` — all related rendering and state-machine plumbing removed (~290 LoC gone).

  **sdk — auth flow fixes**

  - `AuthPanel`: new `signup_verify` mode separate from `reset_verify` — after signup with `confirmation_required` the form no longer shows the misleading "Reset password" header + password field. Header reads "Confirm your email" with a single OTP-code input.
  - `AuthPanel`: removed redundant "Last used · email" badge above the signin submit button — the email field is already pre-filled from `getLastLogin()`.
  - `BillingClient.setIdentity(undefined)` (signout) now emits `applyUser(EMPTY_USER)` + `applyBalances([])` so `onUserChange` / `onBalanceChange` listeners receive the guest-state transition. Previously listeners never fired on signout, leaving consumers with stale premium state in their cache (visible bug in extension content-script widgets).
  - `PaywallRoot`: `openSupport()` / `openSignin()` / `openSignup()` on a paywall for an already-subscribed user no longer get hijacked by the `purchase_success` restored-view on first click. Standalone flows now bypass the auto-restored gate.
  - `PaywallRoot.AwaitingPaymentView`: added horizontal padding so the "← Back" button and "Checkout window didn't open" card no longer collide with the dialog X-close button.
  - `SupportGate`: submit button no longer silently disabled when input is invalid. Validation fires on click with inline errors under each field; previously users couldn't tell why the button was greyed out (e.g. subject < 3 chars).

  **sdk — i18n**

  - Per-locale gate: SDK now only loads the static UI chunk when there is a dynamic override for the resolved locale in `bootstrap.locales`. Previously a paywall translated to RU only would still load the NL static chunk for NL users, producing a mixed NL UI + EN content paywall. Now an NL user with no NL dynamic override gets the clean EN fallback.
  - New keys: `auth.confirm_email_title`, `auth.confirm_email_subtitle` for the signup-confirm flow (RU + 10 major locales translated).
  - Filled missing RU/UK translations for: `auth.reset_password_subtitle`, `payment.awaiting_subtitle`, `payment.still_processing`, `payment.popup_help_text`, `payment.tab_closed_retry`, `payment.popup_blocked_title`, `payment.popup_blocked_message`.

  **sdk-extension**

  - Picks up the SDK changes via workspace dep — no API surface change in `sdk-extension` itself.
  - Demo extension (`demo-extension/`) is not published; included for development reference only. It exercises all the new SDK APIs: `openSignin` / `openSignup` / `signInAnonymously` / `openSupport`, the floating widget reactively shows guest/premium state through the now-correct signout listener fires, and the 401 recovery flow uses headless anon signin instead of the removed `openAnonGate()`.

  **sdk-react — BREAKING changes**

  - `<PaywallButton>` `mode` prop:
    - **Removed** `'anon'` — for anonymous signin use `usePaywall().signInAnonymously()` directly so you can render your own button-level loading state.
    - **Added** `'signin'` (explicit alternative to `'auth'`) and `'signup'` (opens the auth gate directly in signup mode).
    - `'auth'` retained as alias for `'signin'` (back-compat).
  - Contract assertions in `contract.ts` updated: `openSignin` / `openSignup` / `signInAnonymously` now required, `openAnonGate` removed from `RequiredMethods`. TypeScript will surface any host code still calling the removed method.

  **Backend (online) — also updated alongside this release**

  `/api/v1/paywall/[id]/auth/password/request-reset`, `/auth/email/signup`, `/auth/email/resend` and `/auth/otp/send` now resolve `redirect_to` from `custom_domain` server-side. GoTrue magic-links in confirmation / recovery emails redirect to `<custom_domain>/paywall/auth/reset` or `<custom_domain>/paywall/auth/confirm` (new landing page added). Previously links fell back to the platform default Site URL.

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.8

## 3.0.0-alpha.8

### Patch Changes

- docs: README cleanup across all three packages

  - **sdk**: dropped stale "Not in this version (alpha)" block that listed Auth, trials, i18n, React adapter and tests as missing — all shipped. Replaced with an accurate "What's included" section. Added required `apiOrigin` (custom_domain) to Quick start and ApiGateway examples. Expanded provider list to the real set: Stripe / Paddle / Freemius / Chargebee / Overpay. Removed broken `../TODO.md` link. Clarified CDN policy: allowed for websites, forbidden for Chrome extensions.
  - **sdk-extension**: fixed `host_permissions` manifest snippet — was `["https://api.monetize.software/*"]` (a domain that doesn't exist), now points to the host's own `apiOrigin` (custom_domain) with a placeholder. Removed the misleading `"permissions": ["identity"]` optional line — SDK does not use `chrome.identity` (OAuth runs via a popup window against the host's `apiOrigin`). Removed the stale "Phase 0 — skeleton" status block and "Usage (target shape, when complete)" framing — package is published and in use. Architecture diagram annotation corrected to reflect the popup-window OAuth flow.
  - **sdk-react**: translated README from Russian to English to match the other two packages. Added required `apiOrigin` to Quick start and SSR/Next.js examples.

  No code changes.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.7

## 3.0.0-alpha.7

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.6

## 3.0.0-alpha.6

### Patch Changes

- Popup bug fixes + UI polish

  - `PaywallRoot`: an anon session no longer blocks the "Restore Purchases" button and preauth-checkout (treated as "not logged in" in both places, consistent with `CurrentSession`/`AuthPanel`)
  - `PaywallRoot`: the X-close returns to standalone `openAuth()` — without the Back arrow the modal couldn't be closed except via ESC
  - `PaywallRoot`: `useLayoutEffect` instead of `useEffect` for syncing gate-state on `open/initialView` — fixes a flash of the plans layout on a repeat `openAuth()` (noticeable in the extension popup because of RemoteAuth/RemoteBilling RTT)
  - `RemoteAuthClient`: implemented `getLastLogin()` (was not mirrored, AuthPanel crashed with `r.getLastLogin is not a function` in the popup console)
  - `AuthPanel`: defensive guard on `getLastLogin` — old sdk-extension builds / custom AuthClients don't break the signin form
  - Compile-time tests: `RemoteAuthClient.test-d.ts` and `RemoteBillingClient.test-d.ts` catch divergences of the proxy classes from the base ones already at `tsc --noEmit`

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.5

## 3.0.0-alpha.5

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.4

## 3.0.0-alpha.4

### Patch Changes

- docs: prominent warning that Chrome Web Store MV3 policy forbids loading any `@monetize.software/*` package from a CDN (esm.sh / unpkg / jsDelivr) inside content scripts, popups, or service workers. Extension authors must `pnpm add @monetize.software/sdk-extension` and bundle it like a regular npm dependency — `sdk-extension` exists as a separate package precisely so the content-script build inlines all SDK code at build time and never fetches remote JS at runtime.

  No code changes. README-only update so the warning shows on the npm package page in addition to the GitHub repo.
