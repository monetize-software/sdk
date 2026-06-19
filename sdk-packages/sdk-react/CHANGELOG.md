# @monetize.software/sdk-react

## 3.0.0

### Major Changes

- 14e5eb1: **BREAKING**: `usePaywallUser()` now returns a discriminated `PaywallUserState`
  union instead of `PaywallUser | null`.

  ```ts
  type PaywallUserState =
    | { status: "loading"; user: null; session: null }
    | { status: "guest"; user: null; session: null }
    | {
        status: "signed_in";
        user: PaywallUser | null;
        session: AuthSession | null;
      };
  ```

  Why: the old shape conflated three states under `null` — Provider not yet
  mounted, bootstrap in flight, and "really signed out". Hosts had to fall back
  to reading `paywall.auth?.getCachedSession()` to distinguish "guest" from
  "loading", which was both undocumented and easy to forget. The new shape
  makes the lifecycle explicit and lets `PaywallUserState['status']` narrow the
  rest of the snapshot.

  The hook now also subscribes to `authChange` (not just `userChange`), so
  sign-in / sign-out transitions update the component automatically.

  Migration:

  ```tsx
  // before
  const user = usePaywallUser();
  if (!user) return <SignInCTA />;
  return <Profile user={user} />;

  // after
  const account = usePaywallUser();
  if (account.status === "loading") return <Skeleton />;
  if (account.status === "guest") return <SignInCTA />;
  if (!account.user) return <Skeleton />;
  return <Profile user={account.user} />;
  ```

  Also exports `PaywallUserState` and re-exports `AuthSession` for convenience.

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

- d6fce2e: Expose offers to host code with a resolver-style API.

  **Core SDK** (`@monetize.software/sdk`):

  - `new module: core/offer` — pure resolvers (`resolveOffer`, `findApplicableOffer`,
    `offerStartStorageKey`, `readBrowserOfferStart`) shared by the renderer and
    host-side helpers.
  - `PaywallUI.getCachedOffers()` — sync snapshot of the bootstrap's offer list
    (server-side targeting already applied by the backend).
  - `PaywallUI.getOfferForPrice(priceId)` — `ResolvedOffer | null` accounting
    for `price_id` matching, `expires_at`, and `duration_minutes` from
    `clientStorage` `pw-offer-{id}-start`. **Read-only** — does NOT start the
    `duration_minutes` timer (the renderer owns activation on first paywall
    view). Pages-side hosts that call this before the user has opened the
    modal will get `null` for duration-only offers, which is intentional.
  - `billing.getCachedOffers()` — same data, BillingClient-level.
  - Internal: `PriceGrid` renderer now imports the shared `findApplicableOffer`
    instead of duplicating the logic.

  **React bindings** (`@monetize.software/sdk-react`):

  - `usePaywallOffer(priceId)` — reactive `ResolvedOffer | null` with a 1Hz
    tick while the countdown is live, auto-stopping when the offer expires.
  - `usePaywallOffers()` — the raw cached offers list, refreshed on `ready`.
  - Re-exports `ResolvedOffer` from the core SDK.

  Example usage:

  ```tsx
  const offer = usePaywallOffer(price.id);
  if (!offer) return <Amount value={price.amount} />;
  const discounted = price.amount * (1 - offer.discountPercent / 100);
  return (
    <>
      <Strike>{format(price.amount)}</Strike>
      <strong>{format(discounted)}</strong>
      <Badge>-{offer.discountPercent}%</Badge>
      {offer.remainingMs !== null && <Countdown ms={offer.remainingMs} />}
    </>
  );
  ```

- 87c0607: `paywall.checkout(priceId)`: late-mount UX + auto-apply offers.

  **Late-mount** — `paywall.checkout()` no longer shows a loading modal while
  preparing the hosted checkout. Bootstrap, visibility / trial gates and the
  `createCheckout` call now run headlessly; the modal mounts **only when
  actual UI is needed** (preauth signin, popup-blocked, awaiting-payment).
  The host's CTA button is the only "I'm working" surface during the
  200–500 ms prep window.

  A new `state.processing: boolean` field on `PaywallStateSnapshot` tells the
  host when direct-checkout is in flight. `<PaywallButton priceId>` consumes
  it automatically — the button is `disabled` and exposes `aria-busy="true"`
  while `processing === true`; the `render` prop receives `processing` as a
  third arg so custom triggers can draw their own spinners.

  **Offer fix** — `createCheckout` now sends `offerId` to the backend, both
  from the new headless path in `paywall.checkout()` and from the existing
  `runCheckout` in the modal layout flow. Previously `duration_minutes`-offers
  (countdown stored in `clientStorage`) silently lost their discount on the
  hosted checkout because the backend couldn't validate the timer and the
  SDK never told it which offer the user had been seeing. End-date offers
  were auto-resolved server-side by email, but threading the explicit
  `offerId` is more reliable.

  Backend (`online/app/api/v1/paywall/[id]/start-checkout/route.ts`) now reads
  `offerId` from the body and forwards it to `checkoutWithAcquiring`.

  **Core SDK** (`@monetize.software/sdk`):

  - `PaywallStateSnapshot.processing: boolean` (additive, defaulted to false
    for back-compat).
  - `BillingClient.createCheckout({ offerId })` — new param.
  - `PaywallUI.checkout()` rewritten as `runDirectCheckout`: async sequence
    bootstrap → gates → preauth-resolve → headless `createCheckout` →
    `mountAndShow('awaiting_payment' | 'popup_blocked', { priceId, url })`
    or `mountAndShow('auth', { checkoutPriceId })` for the preauth branch.
  - `PaywallView` extended with `'awaiting_payment'` and `'popup_blocked'` as
    initial-view options; `PaywallRoot` accepts `initialCheckoutPriceId` +
    `initialCheckoutUrl` to mount directly into either screen.
  - Internal `direct_checkout_pending` gate-kind removed (no longer needed —
    late-mount path bypasses the intermediate loading state).
  - `'checkout'` removed from `PaywallView` (was alpha.12-only; internal).

  **React bindings** (`@monetize.software/sdk-react`):

  - `<PaywallButton priceId>` reads `state.processing` via `usePaywallState`
    and disables itself while direct-checkout is preparing.
  - `PaywallButtonRenderArgs` gains `processing: boolean`.
  - Contract assertion (`contract.ts`) now requires `processing` on
    `PaywallStateSnapshot`.

  Example:

  ```tsx
  <PaywallButton priceId={price.id}>Get this plan</PaywallButton>
  // During the 200-500ms prep, the button is disabled with aria-busy="true".
  // On success, modal opens directly in awaiting_payment view — no loading flash.
  ```

- 73d9627: Add `paywall.checkout(priceId, opts?)` — direct-checkout API.

  Lets hosts that render their own pricing UI (cards / table) send the
  click straight to the hosted checkout, **skipping the plan-picker layout**
  inside the modal. The modal still owns the parts that are hard to rebuild:
  preauth signin, popup-blocked retry under a fresh user gesture, and the
  awaiting-payment screen with "I've paid" / "Open checkout again".

  **Core SDK** (`@monetize.software/sdk`):

  - `PaywallUI.checkout(priceId, opts?)` — new method. Reuses `OpenOptions`
    (`identity`, `renew`, `skipTrial`, `skipVisibility`).
  - **Headless reject for already-paid.** When the user already has an
    active subscription — cached user, fresh bootstrap, preauth-resume, or
    `409 hasActivePurchase` from the backend — the SDK emits
    `purchase_completed { priceId, restored: true }` and does **not** show
    the "Subscription restored" view. The modal stays closed (or closes if
    it was already mounted for the auth-gate). The host decides how to
    surface that (toast, redirect, badge via `userChange`).
  - **No layout fallback on error.** On any `createCheckout` failure the
    modal closes and `error` is emitted. The plan-picker is never shown,
    not even for a frame — the host owns that surface.
  - Requires `identity.email` (via opts, earlier `setIdentity`, or
    managed-auth). Without it the backend rejects `/start-checkout`.
  - For fully-headless flows (host renders its own awaiting-payment
    screen), `paywall.billing.createCheckout({ priceId })` is still the
    raw escape hatch.

  **React bindings** (`@monetize.software/sdk-react`):

  - `<PaywallButton priceId={...}>` — when set, the click calls
    `paywall.checkout(priceId, opts)` instead of `paywall.open(opts)`.
    `mode` is ignored: a button is either a layout-opener or a
    direct-checkout trigger, never both.
  - Contract assertion (`contract.ts`) covers the new `checkout` method
    signature.

  Example:

  ```tsx
  import {
    usePaywallPrices,
    PaywallButton,
  } from "@monetize.software/sdk-react";

  function PricingCards() {
    const { prices } = usePaywallPrices();
    return prices?.map((p) => (
      <Card key={p.id}>
        <h3>{p.label}</h3>
        <PaywallButton priceId={p.id}>Get this plan</PaywallButton>
      </Card>
    ));
  }
  ```

- 3b263a1: Initial alpha release of `@monetize.software/sdk-react` — React bindings for `@monetize.software/sdk`.

  Includes:

  - `<PaywallProvider>` with two modes: `options={...}` (Provider creates the instance) or `instance={...}` (host supplies a ready PaywallUI from sdk-extension or a shared singleton)
  - 8 hooks: `usePaywall`, `usePaywallState`, `usePaywallUser`, `usePaywallAccess`, `usePaywallPrices`, `usePaywallEvent`, `usePaywallTrial`, `usePaywallVisibility`
  - 3 declarative components: `<PaywallGate>`, `<PaywallButton>`, `<PaywallSupportButton>`
  - `'use client'` directive for Next.js App Router and other RSC-aware bundlers
  - Type-level contract (`src/contract.ts`) that breaks the build at `tsc` time if the public surface of `@monetize.software/sdk` shifts

  SSR-safe out of the box (Next.js, Remix, Astro, RSC). Bundle: ~2 KB gzip.

### Patch Changes

- 5902c36: UI: last-used sign-in method badge next to the OAuth buttons — "Last" → "Last used" (clearer that it means "the last method used").

  Renamed in the canonical EN, the `AuthPanel` inline fallbacks and across all 27 locales
  (`auth.last_used` / `auth.last_used_no_email`): EN `Last used · {email}`, RU
  `Последний вход · …`, DE `Zuletzt genutzt`, ES `Última vez`, JA `前回使用`, etc.
  Also closed a coverage gap — previously `auth.last_used` (with email) was only
  partially translated and some locales fell back to the English inline fallback.

- c13ffc5: Auth: `AuthUser` now carries the profile from the OAuth provider — `name` and `avatar`.

  Previously the SDK only returned `{ id, email, country, is_anonymous }`, and the avatar (Google
  puts it in `user_metadata.avatar_url`) was never surfaced anywhere. Added
  optional `name` / `avatar` to `AuthUser` — populated from the OAuth profile at
  `/oauth/exchange` and available from the session (`auth.getCachedUser()?.avatar`,
  `onAuthChange`) without an extra request. For email/anon users they are `null` (no avatar).

  Requires a paired online deploy (`/oauth/exchange` now puts `name`/`avatar` from
  `user_metadata`). Without it the fields will be `undefined` — does not break existing behavior.

- 8b859cb: Fix awaiting screen hanging after payment in an extension page.

  The awaiting→success transition was tied **exclusively** to `UserWatcher.onActive`,
  but the watcher itself never started for the whole `chrome-extension://` protocol
  (`shouldRunUserWatcher` treated any such context as an ephemeral action popup).
  In a full extension page (side panel / dedicated tab) that survives the checkout,
  the poller was disabled and nobody could close the awaiting screen — even the
  manual "I've paid" button only sent `window.postMessage` to wake a
  non-existent watcher. The purchase went through, `/user-state` returned
  `has_active_subscription: true`, and the screen kept hanging.

  - The transition is centralized in an idempotent `handlePurchaseDetected`, which
    is invoked from `billing.onUserChange` — any source of a fresh active
    user-state (manual `getUser`, cross-context broadcast, watcher) closes
    awaiting. Gated on the checkout views (`awaiting_payment`/`popup_blocked`), so
    opening the paywall for an already-subscribed user doesn't cause a false trigger.
  - `shouldRunUserWatcher` no longer cuts off `chrome-extension://` — a surviving
    page both can and should poll; the ephemeral action popup harmlessly
    tears down with its context (detection there is covered by bootstrap on the
    next open).

- c6418f7: Server-SDK: manual token credit/debit — `BillingClient.creditTokens()` / `debitTokens()`.

  apiKey-only methods that adjust the token balance of a tokenized-paywall user on behalf of
  the merchant's backend (identity by email/userId). `creditTokens` adds, `debitTokens`
  subtracts and throws `PaywallError('insufficient')` if it would go below zero.
  Not available from the browser (no apiKey → `apikey_required`) — a client must not be able to
  credit itself tokens. They return `{ type, count }` with the new balance.

  Requires a paired deploy: the online endpoint `POST /api/v1/paywall/[id]/balances` +
  applying the SQL migration `adjust_paywall_balance` (atomic delta in JSONB, no
  lost-update from concurrent debits by the api-gateway). Daily-trial balances above
  the limit are not overwritten.

- 63dc291: Fix focus and selection diverging when the paywall opens.

  On auto-opening the modal (without a preceding user gesture) the browser's
  `:focus-visible` heuristic drew a ring on the first focusable control — and the
  first `button` in the DOM is the first price card (e.g. monthly), whereas the
  _selected_ one is the popular plan (`popular_price_id`), which has the accent border.
  The focus ring landed on one card and the selection highlight on another; two
  conflicting "active" states were confusing.

  `Modal` no longer moves focus to the first interactive element — focus goes
  to the dialog container itself (`tabIndex=-1`, `outline-none` → no ring). The focus
  trap keeps the anchor inside the dialog, `Tab` cycles through controls as before, and for
  screen readers focus on the `aria-modal` dialog is correct. Added an explicit opt-in
  `[data-pw-autofocus]` for views that need input autofocus.

- da0c8c5: OAuth identity-already-linked: classify by the error description — resilience to callback↔SDK version skew.

  In production it turned out the hosted OAuth callback may forward only the
  human-readable `error_description` ("Identity is already linked to another
  user"), but NOT the machine `error_code` (the callback page deploys independently of
  the npm SDK; an old/cached build doesn't pass `error_code`). beta.9
  classified switch-account by `errorCode` only, so
  `identity_already_exists` arrived as a generic `oauth_failed` → "Sign-in failed"
  without a button.

  - `isIdentityAlreadyLinked()` now matches both `errorCode === 'identity_already_exists'`
    and the error text (`already linked` / `identity_already_exists`) as a fallback —
    the "sign in with that account" button shows regardless of whether the deployed
    callback forwards `error_code`.

- f128fd3: OAuth: auto-switch to the existing account on `identity_already_exists` + clear UX for the email collision.

  Previously, signing in via Google/Apple under an anonymous session went through `linkIdentity`, and if
  the provider was already linked to another account, GoTrue returned `identity_already_exists`,
  and the SDK showed a dead-end "Sign-in failed".

  - `signInWithOAuth` catches `identity_already_exists` and seamlessly switches to a regular
    signin, **reusing the same popup** (`popup.location.replace` to the signin flow with the same
    state; the provider's SSO is already active → almost instant). Added `switchAccount` to
    `signInWithOAuth`/`startOAuthFlow` (doesn't send Bearer → no linkIdentity) and `waitForOAuthResult`
    (a structured outcome with `errorCode`, doesn't close the popup itself). If the popup can't be
    reused (COOP severed the handle) — a fallback "sign in to that account" button (a fresh user gesture).
    Mirrored in the `sdk-extension` split-flow (`auth.oauthStart` gained
    `switchAccount`/`reuseState`).
  - Email collision: due to anti-enumeration, GoTrue masks a taken email (including OAuth-only)
    as "confirm your email". `signUp` now returns `already_registered`, and `AuthPanel`
    leads the user to the signin form with a clear hint instead of the "check your email" dead-end.
  - New i18n keys `auth.email_already_registered` / `auth.identity_already_linked`
    (canonical EN + 27 locales).

  Requires a paired online deploy (the v3 OAuth callback now passes `error_code` and
  does not close the popup on `identity_already_exists`; `/auth/email/signup` returns
  `already_registered`). An old SDK with the new callback and a new SDK with the old callback
  degrade gracefully — no infinite popups.

- 4a8a00a: OAuth `identity_already_exists`: reliable one-click "switch account" instead of seamless popup-reuse.

  beta.8 tried to seamlessly switch the account by reusing the same popup
  (`popup.location.replace`). In a real environment that's unstable: COOP (Google)
  severs the opener↔popup handle, and a second exchange in the same flow added a point of failure —
  the result being a generic "Sign-in failed" instead of the switch branch.

  - Removed popup-reuse. `identity_already_exists` is now propagated directly as
    `oauth_identity_already_linked`, and `AuthPanel` shows clear text +
    a "Continue with <provider>" button. A fresh click → `signInWithOAuth({ switchAccount: true })`
    → a clean signin (new popup, new PKCE exchange) into the account that owns the
    identity. Parity with the legacy `switch_account` branch.
  - `AuthPanel` logs the real OAuth-error code/description to `console.warn` —
    previously the generic fallback hid the cause.
  - Removed the unused `reuseState` from `startOAuthFlow` and `auth.oauthStart`.

- 67e0954: Paywall modal fixes and success-screen wording tweaks.

  **1. Scroll for self-contained status views.** The modal dialog is height-constrained
  (`max-h … overflow-hidden`), and the scroll zone (`flex-1 min-h-0 overflow-y-auto`)
  was set up only by `Renderer`/`AuthGate`/`SupportGate`. Simple status views
  (`PurchaseSuccessView`, `LoadingView`, `ErrorView`, `AwaitingPaymentView`,
  `PopupBlockedView`) rendered without a wrapper and, when height was tight (small
  screens, ~600px extension popup), got clipped with no way to scroll.
  Added a shared `Scroll` wrapper for these views; `Renderer`/`AuthGate`/`SupportGate`
  are not wrapped — they have their own scroll + pinned footer.

  **2. Horizontal padding for `PurchaseSuccessView`.** The view root had only
  vertical padding, while the `Continue` button was `w-full`, so it
  stretched to the edges of the dialog and its glow/shimmer spilled past the edge. Added
  `px-6 sm:px-8` — same as the neighboring views.

  **3. Neutral success/restored wording.** "Your subscription is now
  active." / "Subscription restored" are incorrect for lifetime purchases (those aren't
  subscriptions). Success subtitle → "You're all set — enjoy!", restored title →
  "Welcome back", restored subtitle → the same "You're all set — enjoy!". Updated the
  EN reference, inline fallbacks and all 27 locales (`tools/sdk-translations.mjs` +
  regeneration of `gen-locales.mjs`).

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

- d43dc67: fix(dts): rewrite emitted `.d.ts` imports from the dev-only `../sdk/src`
  relative path to the bare `@monetize.software/sdk` specifier.

  `vite-plugin-dts` was inlining the tsconfig `paths` alias
  (`@monetize.software/sdk → ../sdk`) into every emitted declaration as a
  relative path like `from '../../sdk/src'`. That works inside the
  monorepo but breaks in the published npm package — consumers don't have
  a sibling `sdk/src` directory, so TS silently resolved every imported
  type (`OpenOptions`, `PaywallUI`, `PaywallAccessResult`, …) to `any`.
  The most visible symptom: `<PaywallButton className="…" renew>` failed
  to compile because `Omit<HTMLAttrs, "children" | keyof OpenOptions>`
  stripped every attribute when `OpenOptions` resolved to `any`.

  A `beforeWriteFile` hook in `vite.config.ts` rewrites these paths back
  to the bare specifier at build time. No source changes; only emitted
  declarations are affected.

- 0605621: The SDK version is injected from package.json at build time instead of being hardcoded.

  `SDK_VERSION` sat as a hardcoded literal `'3.0.0-alpha.0'` across all
  releases (alpha.x → beta.x) — it was never bumped once. It goes into `X-SDK-Version`
  on every request, into `sdk_version` of every analytics event (ClickHouse) and into
  ApiGateway, so all version-level analytics were blind: events from every release
  were written as a single version.

  Now the version is threaded from package.json via vite `define`
  (`__SDK_VERSION__`) — a string literal in the bundle, while in `.d.ts` it stays
  `const SDK_VERSION: string`. The `define` is duplicated in vitest.config (it doesn't
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

  apiKey-only methods that adjust the token balance of a tokenized-paywall user on behalf of
  the merchant's backend (identity by email/userId). `creditTokens` adds, `debitTokens`
  subtracts and throws `PaywallError('insufficient')` if it would go below zero.
  Not available from the browser (no apiKey → `apikey_required`) — a client must not be able to
  credit itself tokens. They return `{ type, count }` with the new balance.

  Requires a paired deploy: the online endpoint `POST /api/v1/paywall/[id]/balances` +
  applying the SQL migration `adjust_paywall_balance` (atomic delta in JSONB, no
  lost-update from concurrent debits by the api-gateway). Daily-trial balances above
  the limit are not overwritten.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.13

## 3.0.0-beta.12

### Patch Changes

- Auth: `AuthUser` now carries the profile from the OAuth provider — `name` and `avatar`.

  Previously the SDK only returned `{ id, email, country, is_anonymous }`, and the avatar (Google
  puts it in `user_metadata.avatar_url`) was never surfaced anywhere. Added
  optional `name` / `avatar` to `AuthUser` — populated from the OAuth profile at
  `/oauth/exchange` and available from the session (`auth.getCachedUser()?.avatar`,
  `onAuthChange`) without an extra request. For email/anon users they are `null` (no avatar).

  Requires a paired online deploy (`/oauth/exchange` now puts `name`/`avatar` from
  `user_metadata`). Without it the fields will be `undefined` — does not break existing behavior.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.12

## 3.0.0-beta.11

### Patch Changes

- UI: last-used sign-in method badge next to the OAuth buttons — "Last" → "Last used" (clearer that it means "the last method used").

  Renamed in the canonical EN, the `AuthPanel` inline fallbacks and across all 27 locales
  (`auth.last_used` / `auth.last_used_no_email`): EN `Last used · {email}`, RU
  `Последний вход · …`, DE `Zuletzt genutzt`, ES `Última vez`, JA `前回使用`, etc.
  Also closed a coverage gap — previously `auth.last_used` (with email) was only
  partially translated and some locales fell back to the English inline fallback.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.11

## 3.0.0-beta.10

### Patch Changes

- OAuth identity-already-linked: classify by the error description — resilience to callback↔SDK version skew.

  In production it turned out the hosted OAuth callback may forward only the
  human-readable `error_description` ("Identity is already linked to another
  user"), but NOT the machine `error_code` (the callback page deploys independently of
  the npm SDK; an old/cached build doesn't pass `error_code`). beta.9
  classified switch-account by `errorCode` only, so
  `identity_already_exists` arrived as a generic `oauth_failed` → "Sign-in failed"
  without a button.

  - `isIdentityAlreadyLinked()` now matches both `errorCode === 'identity_already_exists'`
    and the error text (`already linked` / `identity_already_exists`) as a fallback —
    the "sign in with that account" button shows regardless of whether the deployed
    callback forwards `error_code`.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.10

## 3.0.0-beta.9

### Patch Changes

- OAuth `identity_already_exists`: reliable one-click "switch account" instead of seamless popup-reuse.

  beta.8 tried to seamlessly switch the account by reusing the same popup
  (`popup.location.replace`). In a real environment that's unstable: COOP (Google)
  severs the opener↔popup handle, and a second exchange in the same flow added a point of failure —
  the result being a generic "Sign-in failed" instead of the switch branch.

  - Removed popup-reuse. `identity_already_exists` is now propagated directly as
    `oauth_identity_already_linked`, and `AuthPanel` shows clear text +
    a "Continue with <provider>" button. A fresh click → `signInWithOAuth({ switchAccount: true })`
    → a clean signin (new popup, new PKCE exchange) into the account that owns the
    identity. Parity with the legacy `switch_account` branch.
  - `AuthPanel` logs the real OAuth-error code/description to `console.warn` —
    previously the generic fallback hid the cause.
  - Removed the unused `reuseState` from `startOAuthFlow` and `auth.oauthStart`.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.9

## 3.0.0-beta.8

### Patch Changes

- OAuth: auto-switch to the existing account on `identity_already_exists` + clear UX for the email collision.

  Previously, signing in via Google/Apple under an anonymous session went through `linkIdentity`, and if
  the provider was already linked to another account, GoTrue returned `identity_already_exists`,
  and the SDK showed a dead-end "Sign-in failed".

  - `signInWithOAuth` catches `identity_already_exists` and seamlessly switches to a regular
    signin, **reusing the same popup** (`popup.location.replace` to the signin flow with the same
    state; the provider's SSO is already active → almost instant). Added `switchAccount` to
    `signInWithOAuth`/`startOAuthFlow` (doesn't send Bearer → no linkIdentity) and `waitForOAuthResult`
    (a structured outcome with `errorCode`, doesn't close the popup itself). If the popup can't be
    reused (COOP severed the handle) — a fallback "sign in to that account" button (a fresh user gesture).
    Mirrored in the `sdk-extension` split-flow (`auth.oauthStart` gained
    `switchAccount`/`reuseState`).
  - Email collision: due to anti-enumeration, GoTrue masks a taken email (including OAuth-only)
    as "confirm your email". `signUp` now returns `already_registered`, and `AuthPanel`
    leads the user to the signin form with a clear hint instead of the "check your email" dead-end.
  - New i18n keys `auth.email_already_registered` / `auth.identity_already_linked`
    (canonical EN + 27 locales).

  Requires a paired online deploy (the v3 OAuth callback now passes `error_code` and
  does not close the popup on `identity_already_exists`; `/auth/email/signup` returns
  `already_registered`). An old SDK with the new callback and a new SDK with the old callback
  degrade gracefully — no infinite popups.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.8

## 3.0.0-beta.7

### Patch Changes

- Fix awaiting screen hanging after payment in an extension page.

  The awaiting→success transition was tied **exclusively** to `UserWatcher.onActive`,
  but the watcher itself never started for the whole `chrome-extension://` protocol
  (`shouldRunUserWatcher` treated any such context as an ephemeral action popup).
  In a full extension page (side panel / dedicated tab) that survives the checkout,
  the poller was disabled and nobody could close the awaiting screen — even the
  manual "I've paid" button only sent `window.postMessage` to wake a
  non-existent watcher. The purchase went through, `/user-state` returned
  `has_active_subscription: true`, and the screen kept hanging.

  - The transition is centralized in an idempotent `handlePurchaseDetected`, which
    is invoked from `billing.onUserChange` — any source of a fresh active
    user-state (manual `getUser`, cross-context broadcast, watcher) closes
    awaiting. Gated on the checkout views (`awaiting_payment`/`popup_blocked`), so
    opening the paywall for an already-subscribed user doesn't cause a false trigger.
  - `shouldRunUserWatcher` no longer cuts off `chrome-extension://` — a surviving
    page both can and should poll; the ephemeral action popup harmlessly
    tears down with its context (detection there is covered by bootstrap on the
    next open).

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.7

## 3.0.0-beta.6

### Patch Changes

- The SDK version is injected from package.json at build time instead of being hardcoded.

  `SDK_VERSION` sat as a hardcoded literal `'3.0.0-alpha.0'` across all
  releases (alpha.x → beta.x) — it was never bumped once. It goes into `X-SDK-Version`
  on every request, into `sdk_version` of every analytics event (ClickHouse) and into
  ApiGateway, so all version-level analytics were blind: events from every release
  were written as a single version.

  Now the version is threaded from package.json via vite `define`
  (`__SDK_VERSION__`) — a string literal in the bundle, while in `.d.ts` it stays
  `const SDK_VERSION: string`. The `define` is duplicated in vitest.config (it doesn't
  inherit vite.config), otherwise the token wouldn't be substituted in tests.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.6

## 3.0.0-beta.5

### Patch Changes

- Fix focus and selection diverging when the paywall opens.

  On auto-opening the modal (without a preceding user gesture) the browser's
  `:focus-visible` heuristic drew a ring on the first focusable control — and the
  first `button` in the DOM is the first price card (e.g. monthly), whereas the
  _selected_ one is the popular plan (`popular_price_id`), which has the accent border.
  The focus ring landed on one card and the selection highlight on another; two
  conflicting "active" states were confusing.

  `Modal` no longer moves focus to the first interactive element — focus goes
  to the dialog container itself (`tabIndex=-1`, `outline-none` → no ring). The focus
  trap keeps the anchor inside the dialog, `Tab` cycles through controls as before, and for
  screen readers focus on the `aria-modal` dialog is correct. Added an explicit opt-in
  `[data-pw-autofocus]` for views that need input autofocus.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.5

## 3.0.0-beta.4

### Patch Changes

- Paywall modal fixes and success-screen wording tweaks.

  **1. Scroll for self-contained status views.** The modal dialog is height-constrained
  (`max-h … overflow-hidden`), and the scroll zone (`flex-1 min-h-0 overflow-y-auto`)
  was set up only by `Renderer`/`AuthGate`/`SupportGate`. Simple status views
  (`PurchaseSuccessView`, `LoadingView`, `ErrorView`, `AwaitingPaymentView`,
  `PopupBlockedView`) rendered without a wrapper and, when height was tight (small
  screens, ~600px extension popup), got clipped with no way to scroll.
  Added a shared `Scroll` wrapper for these views; `Renderer`/`AuthGate`/`SupportGate`
  are not wrapped — they have their own scroll + pinned footer.

  **2. Horizontal padding for `PurchaseSuccessView`.** The view root had only
  vertical padding, while the `Continue` button was `w-full`, so it
  stretched to the edges of the dialog and its glow/shimmer spilled past the edge. Added
  `px-6 sm:px-8` — same as the neighboring views.

  **3. Neutral success/restored wording.** "Your subscription is now
  active." / "Subscription restored" are incorrect for lifetime purchases (those aren't
  subscriptions). Success subtitle → "You're all set — enjoy!", restored title →
  "Welcome back", restored subtitle → the same "You're all set — enjoy!". Updated the
  EN reference, inline fallbacks and all 27 locales (`tools/sdk-translations.mjs` +
  regeneration of `gen-locales.mjs`).

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.4

## 3.0.0-beta.3

### Patch Changes

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

## 3.0.0-alpha.22

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.22

## 3.0.0-alpha.21

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.21

## 3.0.0-alpha.20

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.20

## 3.0.0-alpha.19

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.19

## 3.0.0-alpha.18

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.18

## 3.0.0-alpha.17

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.17

## 3.0.0-alpha.16

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.16

## 3.0.0-alpha.15

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.15

## 3.0.0-alpha.14

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.14

## 3.0.0-alpha.13

### Minor Changes

- `paywall.checkout(priceId)`: late-mount UX + auto-apply offers.

  **Late-mount** — `paywall.checkout()` no longer shows a loading modal while
  preparing the hosted checkout. Bootstrap, visibility / trial gates and the
  `createCheckout` call now run headlessly; the modal mounts **only when
  actual UI is needed** (preauth signin, popup-blocked, awaiting-payment).
  The host's CTA button is the only "I'm working" surface during the
  200–500 ms prep window.

  A new `state.processing: boolean` field on `PaywallStateSnapshot` tells the
  host when direct-checkout is in flight. `<PaywallButton priceId>` consumes
  it automatically — the button is `disabled` and exposes `aria-busy="true"`
  while `processing === true`; the `render` prop receives `processing` as a
  third arg so custom triggers can draw their own spinners.

  **Offer fix** — `createCheckout` now sends `offerId` to the backend, both
  from the new headless path in `paywall.checkout()` and from the existing
  `runCheckout` in the modal layout flow. Previously `duration_minutes`-offers
  (countdown stored in `clientStorage`) silently lost their discount on the
  hosted checkout because the backend couldn't validate the timer and the
  SDK never told it which offer the user had been seeing. End-date offers
  were auto-resolved server-side by email, but threading the explicit
  `offerId` is more reliable.

  Backend (`online/app/api/v1/paywall/[id]/start-checkout/route.ts`) now reads
  `offerId` from the body and forwards it to `checkoutWithAcquiring`.

  **Core SDK** (`@monetize.software/sdk`):

  - `PaywallStateSnapshot.processing: boolean` (additive, defaulted to false
    for back-compat).
  - `BillingClient.createCheckout({ offerId })` — new param.
  - `PaywallUI.checkout()` rewritten as `runDirectCheckout`: async sequence
    bootstrap → gates → preauth-resolve → headless `createCheckout` →
    `mountAndShow('awaiting_payment' | 'popup_blocked', { priceId, url })`
    or `mountAndShow('auth', { checkoutPriceId })` for the preauth branch.
  - `PaywallView` extended with `'awaiting_payment'` and `'popup_blocked'` as
    initial-view options; `PaywallRoot` accepts `initialCheckoutPriceId` +
    `initialCheckoutUrl` to mount directly into either screen.
  - Internal `direct_checkout_pending` gate-kind removed (no longer needed —
    late-mount path bypasses the intermediate loading state).
  - `'checkout'` removed from `PaywallView` (was alpha.12-only; internal).

  **React bindings** (`@monetize.software/sdk-react`):

  - `<PaywallButton priceId>` reads `state.processing` via `usePaywallState`
    and disables itself while direct-checkout is preparing.
  - `PaywallButtonRenderArgs` gains `processing: boolean`.
  - Contract assertion (`contract.ts`) now requires `processing` on
    `PaywallStateSnapshot`.

  Example:

  ```tsx
  <PaywallButton priceId={price.id}>Get this plan</PaywallButton>
  // During the 200-500ms prep, the button is disabled with aria-busy="true".
  // On success, modal opens directly in awaiting_payment view — no loading flash.
  ```

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.13

## 3.0.0-alpha.12

### Minor Changes

- Add `paywall.checkout(priceId, opts?)` — direct-checkout API.

  Lets hosts that render their own pricing UI (cards / table) send the
  click straight to the hosted checkout, **skipping the plan-picker layout**
  inside the modal. The modal still owns the parts that are hard to rebuild:
  preauth signin, popup-blocked retry under a fresh user gesture, and the
  awaiting-payment screen with "I've paid" / "Open checkout again".

  **Core SDK** (`@monetize.software/sdk`):

  - `PaywallUI.checkout(priceId, opts?)` — new method. Reuses `OpenOptions`
    (`identity`, `renew`, `skipTrial`, `skipVisibility`).
  - **Headless reject for already-paid.** When the user already has an
    active subscription — cached user, fresh bootstrap, preauth-resume, or
    `409 hasActivePurchase` from the backend — the SDK emits
    `purchase_completed { priceId, restored: true }` and does **not** show
    the "Subscription restored" view. The modal stays closed (or closes if
    it was already mounted for the auth-gate). The host decides how to
    surface that (toast, redirect, badge via `userChange`).
  - **No layout fallback on error.** On any `createCheckout` failure the
    modal closes and `error` is emitted. The plan-picker is never shown,
    not even for a frame — the host owns that surface.
  - Requires `identity.email` (via opts, earlier `setIdentity`, or
    managed-auth). Without it the backend rejects `/start-checkout`.
  - For fully-headless flows (host renders its own awaiting-payment
    screen), `paywall.billing.createCheckout({ priceId })` is still the
    raw escape hatch.

  **React bindings** (`@monetize.software/sdk-react`):

  - `<PaywallButton priceId={...}>` — when set, the click calls
    `paywall.checkout(priceId, opts)` instead of `paywall.open(opts)`.
    `mode` is ignored: a button is either a layout-opener or a
    direct-checkout trigger, never both.
  - Contract assertion (`contract.ts`) covers the new `checkout` method
    signature.

  Example:

  ```tsx
  import {
    usePaywallPrices,
    PaywallButton,
  } from "@monetize.software/sdk-react";

  function PricingCards() {
    const { prices } = usePaywallPrices();
    return prices?.map((p) => (
      <Card key={p.id}>
        <h3>{p.label}</h3>
        <PaywallButton priceId={p.id}>Get this plan</PaywallButton>
      </Card>
    ));
  }
  ```

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.12

## 3.0.0-alpha.11

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.11

## 3.0.0-alpha.10

### Minor Changes

- Expose offers to host code with a resolver-style API.

  **Core SDK** (`@monetize.software/sdk`):

  - `new module: core/offer` — pure resolvers (`resolveOffer`, `findApplicableOffer`,
    `offerStartStorageKey`, `readBrowserOfferStart`) shared by the renderer and
    host-side helpers.
  - `PaywallUI.getCachedOffers()` — sync snapshot of the bootstrap's offer list
    (server-side targeting already applied by the backend).
  - `PaywallUI.getOfferForPrice(priceId)` — `ResolvedOffer | null` accounting
    for `price_id` matching, `expires_at`, and `duration_minutes` from
    `clientStorage` `pw-offer-{id}-start`. **Read-only** — does NOT start the
    `duration_minutes` timer (the renderer owns activation on first paywall
    view). Pages-side hosts that call this before the user has opened the
    modal will get `null` for duration-only offers, which is intentional.
  - `billing.getCachedOffers()` — same data, BillingClient-level.
  - Internal: `PriceGrid` renderer now imports the shared `findApplicableOffer`
    instead of duplicating the logic.

  **React bindings** (`@monetize.software/sdk-react`):

  - `usePaywallOffer(priceId)` — reactive `ResolvedOffer | null` with a 1Hz
    tick while the countdown is live, auto-stopping when the offer expires.
  - `usePaywallOffers()` — the raw cached offers list, refreshed on `ready`.
  - Re-exports `ResolvedOffer` from the core SDK.

  Example usage:

  ```tsx
  const offer = usePaywallOffer(price.id);
  if (!offer) return <Amount value={price.amount} />;
  const discounted = price.amount * (1 - offer.discountPercent / 100);
  return (
    <>
      <Strike>{format(price.amount)}</Strike>
      <strong>{format(discounted)}</strong>
      <Badge>-{offer.discountPercent}%</Badge>
      {offer.remainingMs !== null && <Countdown ms={offer.remainingMs} />}
    </>
  );
  ```

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.10

## 3.0.0-alpha.9

### Major Changes

- **BREAKING**: `usePaywallUser()` now returns a discriminated `PaywallUserState`
  union instead of `PaywallUser | null`.

  ```ts
  type PaywallUserState =
    | { status: "loading"; user: null; session: null }
    | { status: "guest"; user: null; session: null }
    | {
        status: "signed_in";
        user: PaywallUser | null;
        session: AuthSession | null;
      };
  ```

  Why: the old shape conflated three states under `null` — Provider not yet
  mounted, bootstrap in flight, and "really signed out". Hosts had to fall back
  to reading `paywall.auth?.getCachedSession()` to distinguish "guest" from
  "loading", which was both undocumented and easy to forget. The new shape
  makes the lifecycle explicit and lets `PaywallUserState['status']` narrow the
  rest of the snapshot.

  The hook now also subscribes to `authChange` (not just `userChange`), so
  sign-in / sign-out transitions update the component automatically.

  Migration:

  ```tsx
  // before
  const user = usePaywallUser();
  if (!user) return <SignInCTA />;
  return <Profile user={user} />;

  // after
  const account = usePaywallUser();
  if (account.status === "loading") return <Skeleton />;
  if (account.status === "guest") return <SignInCTA />;
  if (!account.user) return <Skeleton />;
  return <Profile user={account.user} />;
  ```

  Also exports `PaywallUserState` and re-exports `AuthSession` for convenience.

## 3.0.0-alpha.8

### Patch Changes

- fix(dts): rewrite emitted `.d.ts` imports from the dev-only `../sdk/src`
  relative path to the bare `@monetize.software/sdk` specifier.

  `vite-plugin-dts` was inlining the tsconfig `paths` alias
  (`@monetize.software/sdk → ../sdk`) into every emitted declaration as a
  relative path like `from '../../sdk/src'`. That works inside the
  monorepo but breaks in the published npm package — consumers don't have
  a sibling `sdk/src` directory, so TS silently resolved every imported
  type (`OpenOptions`, `PaywallUI`, `PaywallAccessResult`, …) to `any`.
  The most visible symptom: `<PaywallButton className="…" renew>` failed
  to compile because `Omit<HTMLAttrs, "children" | keyof OpenOptions>`
  stripped every attribute when `OpenOptions` resolved to `any`.

  A `beforeWriteFile` hook in `vite.config.ts` rewrites these paths back
  to the bare specifier at build time. No source changes; only emitted
  declarations are affected.

## 3.0.0-alpha.7

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.9

## 3.0.0-alpha.6

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

## 3.0.0-alpha.5

### Patch Changes

- docs: README cleanup across all three packages

  - **sdk**: dropped stale "Not in this version (alpha)" block that listed Auth, trials, i18n, React adapter and tests as missing — all shipped. Replaced with an accurate "What's included" section. Added required `apiOrigin` (custom_domain) to Quick start and ApiGateway examples. Expanded provider list to the real set: Stripe / Paddle / Freemius / Chargebee / Overpay. Removed broken `../TODO.md` link. Clarified CDN policy: allowed for websites, forbidden for Chrome extensions.
  - **sdk-extension**: fixed `host_permissions` manifest snippet — was `["https://api.monetize.software/*"]` (a domain that doesn't exist), now points to the host's own `apiOrigin` (custom_domain) with a placeholder. Removed the misleading `"permissions": ["identity"]` optional line — SDK does not use `chrome.identity` (OAuth runs via a popup window against the host's `apiOrigin`). Removed the stale "Phase 0 — skeleton" status block and "Usage (target shape, when complete)" framing — package is published and in use. Architecture diagram annotation corrected to reflect the popup-window OAuth flow.
  - **sdk-react**: translated README from Russian to English to match the other two packages. Added required `apiOrigin` to Quick start and SSR/Next.js examples.

  No code changes.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.7

## 3.0.0-alpha.4

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.6

## 3.0.0-alpha.3

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.5

## 3.0.0-alpha.2

### Patch Changes

- Updated dependencies
  - @monetize.software/sdk@3.0.0-alpha.4

## 3.0.0-alpha.1

### Minor Changes

- Initial alpha release of `@monetize.software/sdk-react` — React bindings for `@monetize.software/sdk`.

  Includes:

  - `<PaywallProvider>` with two modes: `options={...}` (Provider creates the instance) or `instance={...}` (host supplies a ready PaywallUI from sdk-extension or a shared singleton)
  - 8 hooks: `usePaywall`, `usePaywallState`, `usePaywallUser`, `usePaywallAccess`, `usePaywallPrices`, `usePaywallEvent`, `usePaywallTrial`, `usePaywallVisibility`
  - 3 declarative components: `<PaywallGate>`, `<PaywallButton>`, `<PaywallSupportButton>`
  - `'use client'` directive for Next.js App Router and other RSC-aware bundlers
  - Type-level contract (`src/contract.ts`) that breaks the build at `tsc` time if the public surface of `@monetize.software/sdk` shifts

  SSR-safe out of the box (Next.js, Remix, Astro, RSC). Bundle: ~2 KB gzip.
