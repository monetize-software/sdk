# @monetize.software/sdk

## 3.0.0

### Major Changes

- 3b263a1: BREAKING: `apiOrigin` is now a **required** field on `BillingClient`, `AuthClient`, `ApiGatewayClient` — pass the paywall's `custom_domain` configured in the platform. The previous `https://appbox.space` fallback is removed (it was used only by the legacy v2 SDK). The SDK checks `apiOrigin` against `bootstrap.settings.custom_domain` and throws `invalid_config` on mismatch — a guard against integrator typos.

  Also:

  - New layout block `guarantee_badge` (money-back badge under the CTA, icon `dollar_shield` or `none`).
  - `PaywallSettings.custom_domain` — new field in bootstrap, normalized via `URL().origin`.
  - Default layout now includes `guarantee_badge` + `current_session` after the CTA.
  - PriceGrid: currency as a separate element next to the amount, plan label in ALL CAPS, checkmark on the right, selector without radio.
  - Modal: Test-mode badge — absolute over the dialog (rounded pill, not a banner on top), close-button repositioned.
  - CtaButton: shimmer animation (CSS), rounded-full, richer gradient with inset glow.
  - CurrentSession: accent-color links (instead of grey).
  - Heading h1: 1.875rem (was 1.625), bold, text-balance.
  - TokenizationGate: rich checkmark on an accent background.

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

- 179e4a6: security(billing): `BillingClient` now **throws** `PaywallError('apikey_in_browser')` from the constructor when `apiKey` is passed in a browser context (`window.document` detected), instead of merely logging `console.error` and continuing.

  A server-SDK `apiKey` identifies the paywall owner and can act on any paywall the account owns; leaking it into client code exposes the whole account. The previous behavior (warn-but-proceed) let a naive integrator ship a working-looking bundle that silently leaked the key. Now the leak fails loudly on the first `new BillingClient(...)`.

  ```ts
  // ❌ browser — throws synchronously
  new BillingClient({ paywallId, apiOrigin, apiKey: "sk_live_..." });
  // PaywallError('apikey_in_browser')

  // ✅ trusted backend — unchanged
  new BillingClient({
    paywallId,
    apiOrigin,
    apiKey: process.env.MONETIZE_API_KEY,
  });
  ```

  Escape hatch for deliberate browser injection (e2e/integration tests only):

  ```ts
  new BillingClient({
    paywallId,
    apiOrigin,
    apiKey,
    allowInsecureBrowserUsage: true,
  });
  // no throw — downgrades to a console.error warning. Never use in production.
  ```

  Notes:

  - New option `allowInsecureBrowserUsage?: boolean` (default `false`).
  - This is a **client-side** guard only. The backend still honors any valid key regardless of Origin — it does not replace rotating a key that has already leaked, nor a CI grep-check for `apiKey` in client bundles.
  - Server runtimes (Node/Deno/Bun/Edge — no `window.document`) are unaffected.

- 088397f: feat(billing): `listPurchases` and `cancelSubscription` now accept `apiKey` + `identity` (server-SDK path), in addition to the existing Bearer (`AuthClient`) path.

  Before this change, both methods required a connected `AuthClient` and threw `PaywallError('auth_required')` when called without one — making them unusable for headless integrations whose customers don't run monetize.software's auth.

  Now:

  ```ts
  const billing = new BillingClient({
    paywallId,
    apiOrigin,
    apiKey: process.env.MONETIZE_API_KEY!,
    identity: { email: user.email, userId: user.id },
  });

  const purchases = await billing.listPurchases();
  await billing.cancelSubscription({ subscriptionId, reason: "..." });
  ```

  Notes:

  - Identity (email or your stable `userId`) is sent as `?email=` / `?user_id=` (listPurchases) or in the body (cancelSubscription).
  - Bearer path is unchanged — UI customer portals built on `AuthClient` keep working.
  - Without either path, both methods now throw `identity_required` (was `auth_required`).
  - The backend additionally verifies the identity is linked to your paywall (via `user_paywalls` or any prior purchase). Querying users that never interacted with your paywall returns `identity_not_on_paywall` (404) — cross-paywall lookup is blocked by design.
  - `cancelSubscription` adds a `paywall_id` filter on the apiKey path, so the owner of paywall A cannot cancel a subscription on paywall B even by guessing IDs.

- 0e757ec: `billing.getCustomerPortalUrl({ returnUrl })` — host-controlled return URL.

  Adds an optional `returnUrl` parameter to `getCustomerPortalUrl()`. When
  set, the hosted portal's "Return to ..." button sends the user back to
  that URL — typically the host app's account page
  (`https://your-app.com/account`). Threads through Stripe (`return_url`),
  Paddle (`return_url`) and Chargebee (`redirect_url`).

  Previously the SDK sent nothing and the backend chose `shop_url` (the
  paywall-level "Shop URL" setting) or fell back to the online service's
  own paywall page (`NEXT_PUBLIC_ONLINE_ORIGIN/paywall/<id>/customer-portal/return`).
  For self-hosted apps both paths were off-brand — the user round-tripped
  through the online-service domain instead of landing in the host's UI.

  Backend (`online`) is required for the round trip — without the matching
  backend deploy `returnUrl` is silently ignored and the old fallback chain
  kicks in. The backend deploy also:

  - Adds `custom_domain/paywall/<id>/customer-portal/return` to the
    fallback chain (between `shop_url` and `NEXT_PUBLIC_ONLINE_ORIGIN`) so
    even hosts that don't pass `returnUrl` get a sensible URL when their
    paywall has a custom domain.
  - Re-enables `return_url` in the Paddle portal request body (was
    commented out).
  - Forwards `redirect_url` to Chargebee `/portal_sessions`.
  - Propagates the actual Stripe error message when checkout fails instead
    of swallowing it as `{ errorRedirect }` (was returning a malformed
    shape that callers couldn't diagnose).

  Example:

  ```ts
  const { url } = await paywall.billing.getCustomerPortalUrl({
    returnUrl: `${window.location.origin}/account`,
  });
  window.open(url, "_blank", "noopener,noreferrer");
  ```

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

- 49a342e: i18n force-locale + structured auth errors + price grid polish

  - **`PaywallUI.locale` option + `PaywallUI.setLocale()`**: explicit language override for I18nProvider, bypassing navigator.language and the owner-translations check. Needed for the admin editor's live-preview ("Preview as user from <country>") — there the browser locale is always EN. `setLocale(null)` restores the automatic resolution logic; live updates via `handle.update`. Marked `@internal` — end integrators don't need to force the language.
  - **AuthPanel: structured error mapping**. Previously `err.message` showed the raw HTTP statusText ("Unauthorized", "Bad Request") — English-only and unlocalized. Now `authErrorMessage()` maps stable `err.code` values (`invalid_credentials`, `email_not_confirmed`, `email_exists`, `weak_password`, `invalid_otp`, `rate_limited`, `network_error`, `service_unavailable`, …) to `auth.*` i18n keys. For unknown codes — generic fallback `auth.signin_failed`/`auth.signup_failed`. 8 new i18n keys, translated across all 27 bundled locales.
  - **PriceGrid: compact view as card**. Compact mode now wraps the rows in `rounded-xl border bg-gray-50` — mirroring the legacy `PaywallPricing` wrapper for the non-default view. Separates the prices block from the rest of the layout.
  - **PriceGrid: smart strike-row reservation**. The horizontal view reserves 22px of height for "strike-through originalAmount + discount-pill" on ALL cards only if at least one price in the grid has a discount. If no card has an offer — the row is not rendered, leaving no 22px of empty space under the label.
  - **PriceGrid: removed the `trial_days` hint** under the main amount (more compact layout, trial-info stays in CtaButton).
  - **TokenizationGate: lifetime copy**. For `interval === 'lifetime'` (or missing) the new key `pricing.included_total` ("Included for lifetime:") is rendered instead of `pricing.included_per` ("Included per {interval}:").
  - **Renderer.hasTopBanner**: prop to reduce the top-padding of the scrollable zone when an OfferTopBanner is rendered above the dialog.
  - **i18n cleanup**: `auth.check_email_title` is now a short neutral heading ("Check your email") — the legacy translation of the long signup-link phrase was incorrect for the forgot-password flow.

### Patch Changes

- 5902c36: UI: badge of the last sign-in method next to the OAuth buttons — "Last" → "Last used" (clearer that it's "the last used method").

  Renamed in canonical EN, the inline fallbacks of `AuthPanel`, and across all 27 locales
  (`auth.last_used` / `auth.last_used_no_email`): EN `Last used · {email}`, RU
  `Последний вход · …`, DE `Zuletzt genutzt`, ES `Última vez`, JA `前回使用`, etc.
  This also closed a coverage gap — previously `auth.last_used` (with email) was only
  partially translated and some locales fell back to the English inline fallback.

- 2851b7f: i18n — translations for the new `reset_sent` view.

  Added three keys to `sdk-translations.mjs` and generated into all 27
  locales via `tools/gen-locales.mjs`:

  - `auth.reset_sent_subtitle` — explanation under the "Check your email" title.
  - `auth.reset_link_valid` — hint "The link is valid for 1 hour.".
  - `auth.back_to_login` — label of the primary button.

  Before this release these strings rendered through the English inline-fallback
  in the `t()` call — the title was localized, the rest stayed in English.

- f513233: `AuthPanel` — native "Check your email" screen after a password reset request.

  Previously, after sending the reset email, `auth_panel` showed a grey
  info-banner with text and the standard form header — it looked like a
  technical notification rather than a confirmation of the action. Now
  `reset_sent` is a separate success-view: a green circle with a checkmark
  (the same visual palette as the success-state in `PaywallRoot`),
  a large "Check your email" title, an explanatory subtitle, the user's email
  in bold, and a hint about the link's validity. At the bottom — a large primary
  "Back to Login" button in the brand accent color.

  New i18n keys (with English fallback inline):

  - `auth.reset_sent_subtitle` — "We sent a password reset link. Follow
    the instructions in the email to reset your password."
  - `auth.reset_link_valid` — "The link is valid for 1 hour."
  - `auth.back_to_login` — "Back to Login"

  The old `setInfo(...)` and the grey info-banner for `reset_sent` are removed —
  the text now lives in the view itself.

- 619730d: Signup email-confirm: moved to a link flow (like recovery) instead of a dead-end
  code-entry screen.

  The prod email template "Confirm signup" sends a confirmation **link** (redirect_to →
  `/paywall/v3/auth/confirm`), not a 6-digit code. But the modal, after signUp →
  `confirmation_required`, showed the `signup_verify` screen with a code input —
  the user hit a dead end: they were asked to enter a code, but there was none in the email.

  Now after signUp the `signup_sent` screen is shown ("check your email →
  click the link", mirroring `reset_sent`). Confirmation completes on the
  v3 page, the session syncs cross-tab → the auth gate advances on its own, as with a
  regular signin. Symmetric to the recovery flow (forgot → reset_sent).

  Removed the `signup_verify` mode and its OTP branch; added the key
  `auth.signup_sent_subtitle` (canonical-en + 27 locales).

- c13ffc5: Auth: `AuthUser` now carries the profile from the OAuth provider — `name` and `avatar`.

  Previously the SDK returned only `{ id, email, country, is_anonymous }`, and the avatar (Google
  puts it in `user_metadata.avatar_url`) was never exposed anywhere. Added
  optional `name` / `avatar` to `AuthUser` — populated from the OAuth profile at
  `/oauth/exchange` and available from the session (`auth.getCachedUser()?.avatar`,
  `onAuthChange`) without an extra request. For email/anon users — `null` (no avatar).

  Requires a paired online deploy (`/oauth/exchange` now sets `name`/`avatar` from
  `user_metadata`). Without it the fields will be `undefined` — does not break the existing behavior.

- 8b859cb: Fix for the awaiting screen hanging after payment in an extension page.

  The awaiting→success transition was tied **exclusively** to `UserWatcher.onActive`,
  and the watcher itself didn't run for the entire `chrome-extension://` protocol
  (`shouldRunUserWatcher` treated any such context as an ephemeral action-popup).
  In a full-fledged extension page (side panel / separate tab) that
  survives the checkout, the poller was off, and there was no one to close the awaiting screen — even
  the manual "I've paid" button just sent a `window.postMessage` to wake up a
  nonexistent watcher. The purchase went through, `/user-state` returned
  `has_active_subscription: true`, and the screen hung.

  - The transition is centralized in the idempotent `handlePurchaseDetected`, which
    is called from `billing.onUserChange` — any source of fresh active
    user-state (manual `getUser`, cross-context broadcast, watcher) closes
    awaiting. Gated on the checkout views (`awaiting_payment`/`popup_blocked`), so
    opening the paywall for an already-subscribed user doesn't trigger a false positive.
  - `shouldRunUserWatcher` no longer cuts off `chrome-extension://` — the surviving
    page both can and should poll; the ephemeral action-popup harmlessly
    tears down with the context (detection there covers bootstrap on the
    next open).

- c6418f7: Server-SDK: manual token credit/debit — `BillingClient.creditTokens()` / `debitTokens()`.

  apiKey-only methods that adjust the token balance of a tokenized-paywall user on behalf
  of the merchant's backend (identity by email/userId). `creditTokens` adds, `debitTokens`
  subtracts and throws `PaywallError('insufficient')` if it would go below zero.
  Not accessible from the browser (no apiKey → `apikey_required`) — a client must not be able to
  credit itself tokens. Returns `{ type, count }` with the new balance.

  Requires a paired deploy: the online endpoint `POST /api/v1/paywall/[id]/balances` +
  applying the SQL migration `adjust_paywall_balance` (atomic delta in JSONB, without
  lost-update from concurrent debits by the api-gateway). Daily-trial balances above
  the limit are not overwritten.

- e9f3308: `BillingClient.createCheckout`: auto-send `localCurrency`.

  Resolves the user's local currency from the cached bootstrap
  (`price.local.currency` on the target `priceId`) and threads it into the
  `/start-checkout` body. Without this the backend fell back to the base
  currency on the hosted checkout — the SDK showed £9.99 on the paywall
  and Stripe opened with $9.99, a literal UI/checkout mismatch.

  No host code changes required: the resolution happens automatically
  inside `createCheckout` from `cachedBootstrap.prices`. The backend
  contract field (`localCurrency`) and the body comment already mentioned
  it — the SDK simply wasn't sending it.

- a6b7a3a: Removed the `paywall_opened` analytics event. Now a paywall display is recorded by
  a single signal — `paywall_viewed` (emitted on `'ready'`, after the
  bootstrap loads, with `prices_count`/`offers_count`/`is_test_mode`). `'open'` is no longer
  tracked separately, neither in the main SDK nor in the extension channel.

  Motivation: `opened` and `viewed` duplicated each other in the dominant pattern
  (warm bootstrap → both events in one batch), and an extra event on every
  open multiplied the POST load on `/events` and the rows in `paywall_sdk_events`
  at prod scale (thousands of simultaneous opens). The funnel is built from
  `viewed`. The server (`online`) no longer accepts `paywall_opened` in the whitelist.

- 4845938: `paywall.getAccess()`: read fresh user from `cachedUser` instead of stale
  `getCachedBootstrap().user`.

  Before: when bootstrap was cached (typical after the pricing page loaded
  it), `getAccess()` resolved `user` from `getCachedBootstrap().user` — the
  snapshot taken at the time bootstrap was fetched. After a successful
  purchase the UserWatcher poll updates `billing.cachedUser` and emits
  `userChange`, host's `usePaywallAccess` re-runs `getAccess()` — but the
  cached bootstrap still has the pre-purchase user snapshot, so the hook
  returns `blocked` even though the user really has an active subscription.

  After: prefer `billing.getCachedUser()` (which reflects every userChange),
  falling back to `bootstrap.user` only when the user cache is empty (cold
  start, post-signOut). `getCachedBootstrap()` continues to return the raw
  structure — it's used elsewhere for non-user fields and we don't want to
  pay a re-merge cost on every call.

  Symptom this fixes: `<PaywallGate>` and `usePaywallAccess` staying in
  `blocked` after a successful checkout (UI didn't react to Pro). Account
  page kept working because `usePaywallUser` reads `getCachedUser()`
  directly — only the access-resolution path was hitting the stale view.

  Async path (cold bootstrap) was already correct: `BillingClient.bootstrap()`
  overlays cachedUser onto the returned bootstrap (`{ ...cachedBootstrap, user: cachedUser ?? undefined }`).

- 63dc291: Fix for diverging focus and selection when opening the paywall.

  On auto-open of the modal (without a preceding user gesture) the browser
  `:focus-visible` heuristic drew a ring on the first focusable control — but
  the first `button` in the DOM is the first plan card (e.g. monthly), whereas
  the _selected_ plan is the popular one (`popular_price_id`), which has the accent border.
  The focus ring ended up on one card and the selection highlight on another; two
  conflicting "active" states were confusing.

  `Modal` no longer focuses the first interactive element — focus goes
  to the dialog container itself (`tabIndex=-1`, `outline-none` → no ring). The focus
  trap keeps the anchor inside the dialog, `Tab` cycles the controls as before, and for
  screen readers focus on the `aria-modal` dialog is correct. Added an explicit opt-in
  `[data-pw-autofocus]` for views that need input autofocus.

- da0c8c5: OAuth identity-already-linked: classification by error description — resilience to version skew callback↔SDK.

  In prod it turned out that the hosted OAuth callback can forward only
  the human-readable `error_description` ("Identity is already linked to another
  user"), but NOT the machine-readable `error_code` (the callback page deploys independently of
  the npm SDK; an old/cached build doesn't pass `error_code`). beta.9
  classified switch-account only by `errorCode`, so
  `identity_already_exists` arrived as a generic `oauth_failed` → "Sign-in failed"
  with no button.

  - `isIdentityAlreadyLinked()` now matches both `errorCode === 'identity_already_exists'`
    and the error text (`already linked` / `identity_already_exists`) as a fallback —
    the "sign in with that account" button shows regardless of whether the deployed
    callback forwards `error_code`.

- f128fd3: OAuth: auto-switch to an existing account on `identity_already_exists` + clear UX for the email collision.

  Previously, signing in via Google/Apple under an anonymous session went through `linkIdentity`, and if
  the provider was already linked to another account, GoTrue returned `identity_already_exists`,
  and the SDK showed a blank "Sign-in failed".

  - `signInWithOAuth` catches `identity_already_exists` and seamlessly switches to a regular
    signin, **reusing the same popup** (`popup.location.replace` to the signin flow with the same
    state; the provider's SSO is already active → near-instant). Added `switchAccount` to
    `signInWithOAuth`/`startOAuthFlow` (doesn't send Bearer → no linkIdentity) and `waitForOAuthResult`
    (a structured outcome with `errorCode`, doesn't close the popup itself). If the popup can't be reused
    (COOP severed the handle) — a fallback button "sign in with that account" (a fresh user gesture).
    Mirrored in the `sdk-extension` split-flow (`auth.oauthStart` got
    `switchAccount`/`reuseState`).
  - Email collision: due to anti-enumeration, GoTrue masks an already-taken email (incl. OAuth-only)
    as "confirm your email". `signUp` now returns `already_registered`, and `AuthPanel`
    sends the user to the signin form with a clear hint instead of the dead-end "check your email".
  - New i18n keys `auth.email_already_registered` / `auth.identity_already_linked`
    (canonical EN + 27 locales).

  Requires a paired deploy of the online part (the v3 OAuth callback now passes `error_code` and
  doesn't close the popup on `identity_already_exists`; `/auth/email/signup` returns
  `already_registered`). An old SDK with the new callback and a new SDK with the old callback
  degrade gracefully — without infinite popups.

- 4a8a00a: OAuth `identity_already_exists`: reliable one-click "switch account" instead of seamless popup-reuse.

  beta.8 tried to seamlessly switch accounts by reusing the same popup
  (`popup.location.replace`). In a real environment this is unstable: COOP (Google)
  severs the opener↔popup handle, and a second exchange in the same flow added a point of failure —
  the end result being a generic "Sign-in failed" instead of the switch branch.

  - Removed popup-reuse. `identity_already_exists` is now surfaced directly as
    `oauth_identity_already_linked`, and `AuthPanel` shows a clear message +
    a "Continue with <provider>" button. A fresh click → `signInWithOAuth({ switchAccount: true })`
    → a clean signin (new popup, new PKCE exchange) into the account that owns the
    identity. Parity with the legacy `switch_account` branch.
  - `AuthPanel` logs the real OAuth error code/description to `console.warn` —
    previously the generic fallback hid the cause.
  - Removed the unused `reuseState` from `startOAuthFlow` and `auth.oauthStart`.

- 638fa26: `OfferBanner` — fix offer-farming via re-opening the paywall.

  `useOfferCountdown`, on `expired === true`, deleted the key
  `pw-offer-<id>-start` from localStorage, treating it as safe cleanup.
  But that very key is the only forever-marker that "this offer has already
  started for the user". Without it, `resolveEndMs` on the next paywall open
  wrote a fresh `start` (= `Date.now()`) and the countdown started
  over — even though the offer had long since expired.

  The scenario a user can exploit:

  1. Sees the offer → timer started, key saved.
  2. Logs in, opens checkout, closes it without paying.
  3. Closes the paywall → timer ticks in the background → expires → `removeItem`.
  4. Opens the paywall again → the offer shows the full `duration_minutes`.

  Fix: on expiry we stop the `setInterval`, but do NOT delete the key from storage.
  On the next resolve `start + duration < now` → the banner
  is hidden via the standard `timeLeft.expired` guard. A user physically
  cannot "farm" the offer by re-opening.

  Side-effect: localStorage accumulates one ~50-byte key per
  every offer that ever started. An acceptable price for correctness.

- 8250085: Fix: an expired offer stopped giving the discount in the countdown banner, but
  remained in the prices inside the modal and was passed to checkout.

  `PriceGrid` (strike-through / `-X%` in the modal cards) and the checkout path in
  `PaywallRoot` resolved the offer via the raw `findApplicableOffer`, which
  filters only by `price_id` + `discount_percent > 0` and **doesn't check
  the deadline**. Host pricing (`usePaywallOffer` → `getOfferForPrice` →
  `resolveOffer`) and the countdown banner (`useOfferCountdown`) do account for
  expiry. The result was a desync: the offer expired, the banner is hidden and there's no
  discount in the host cards, but in the modal cards the discount with strike-through still hung on.

  The second, more unpleasant side-effect was checkout. For `duration_minutes`
  offers there's no server-side timer, the backend trusts the passed `offerId`. The raw
  `findApplicableOffer` sent the id of the expired offer to `createCheckout` → the backend
  would apply a discount no longer visible in the UI.

  Fix: a new `findLiveOffer(offers, priceId, opts)` in `core/offer.ts` —
  an expiry-aware wrapper (`findApplicableOffer` → `resolveOffer`, cuts off
  the expired). `PriceGrid` (all 4 call-sites) and checkout in `PaywallRoot`
  were switched to it with `readStart: readBrowserOfferStart`. Now the discount in
  the modal cards and the `offerId` at checkout disappear in sync with the banner.

  The "offer hasn't started yet" semantics (no marker) is preserved — `resolveOffer`
  treats such a `duration_minutes` offer as perpetual, the discount is shown.

  Not covered is the minor case "modal open at the moment of expiry": `PriceGrid` doesn't
  tick once a second, so the discount survives until the next re-render. Opening
  the paywall _after_ expiry (the main bug) is fully closed.

- 67e0954: Fixes to the paywall modal and the wording of the success screen.

  **1. Scroll for self-contained status views.** The modal dialog is height-constrained
  (`max-h … overflow-hidden`), and the scroll zone (`flex-1 min-h-0 overflow-y-auto`)
  was set up only by `Renderer`/`AuthGate`/`SupportGate`. Simple status views
  (`PurchaseSuccessView`, `LoadingView`, `ErrorView`, `AwaitingPaymentView`,
  `PopupBlockedView`) rendered without a wrapper and, when height was tight (small
  screens, extension popup ~600px), got clipped with no way to scroll.
  Added a shared `Scroll` wrapper for these views; `Renderer`/`AuthGate`/`SupportGate`
  are not wrapped — they have their own scroll + a pinned footer.

  **2. Horizontal padding on `PurchaseSuccessView`.** The view root had only
  vertical padding, and the `Continue` button was `w-full`, so it
  stretched to the dialog edges and its glow/shimmer spilled over the edge. Added
  `px-6 sm:px-8` — like the neighboring views.

  **3. Neutral success/restored wording.** "Your subscription is now
  active." / "Subscription restored" are incorrect for lifetime purchases (it's not
  a subscription). Success subtitle → "You're all set — enjoy!", restored title →
  "Welcome back", restored subtitle → the same "You're all set — enjoy!". Updated the
  EN reference, the inline fallbacks and all 27 locales (`tools/sdk-translations.mjs` +
  regeneration via `gen-locales.mjs`).

- 50d3378: Modal: typography hierarchy fix for `PopupBlockedView` and
  `AwaitingPaymentView`; better popup-blocked icon.

  Both views had a flat hierarchy — title (`text-sm`) and subtitle (`text-xs`)
  read as the same weight, so users couldn't see at a glance what the
  screen was about. Aligned with `PurchaseSuccessView` (the canonical
  "outcome view" template): `text-lg` semibold title with `id="pw-title"`
  for modal `aria-labelledby`, `text-sm` leading-relaxed subtitle, a
  larger `h-14 w-14` icon container so the visual anchor reads as a
  primary status indicator rather than an inline accent.

  `PopupBlockedView` also gets a more meaningful icon — an external-link
  arrow (window with arrow up-right) instead of the previous check-in-box,
  which read as "saved/done" and didn't convey "allow popups".

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

- 7ef8553: Export `PaywallPurchaseDetailed` from the package root — the rich purchase
  shape returned by `BillingClient.listPurchases()` (used to render customer-
  portal subscription lists). Was already implemented and documented, just
  missing from the public re-export barrel.
- 3b263a1: Popup bug fixes + UI polish

  - `PaywallRoot`: an anon session no longer blocks the "Restore Purchases" button and preauth-checkout (treated as "not logged in" in both places, consistent with `CurrentSession`/`AuthPanel`)
  - `PaywallRoot`: the X close button returns on standalone `openAuth()` — without a Back arrow the modal couldn't be closed except by ESC
  - `PaywallRoot`: `useLayoutEffect` instead of `useEffect` for syncing gate-state on `open/initialView` — fixes the flash of the plan layout on a repeated `openAuth()` (noticeable in the extension popup due to RemoteAuth/RemoteBilling RTT)
  - `RemoteAuthClient`: implemented `getLastLogin()` (was not mirrored, AuthPanel crashed with `r.getLastLogin is not a function` in the popup console)
  - `AuthPanel`: defensive guard on `getLastLogin` — old sdk-extension builds / custom AuthClients don't break the signin form
  - Compile-time tests: `RemoteAuthClient.test-d.ts` and `RemoteBillingClient.test-d.ts` catch divergences of the proxy classes from the base ones at `tsc --noEmit`

- 0605621: The SDK version is injected from package.json at build time instead of being hardcoded.

  `SDK_VERSION` stuck as a hardcoded literal `'3.0.0-alpha.0'` through every
  release (alpha.x → beta.x) — it was never bumped. It goes out in `X-SDK-Version`
  on all requests, in the `sdk_version` of every analytics event (ClickHouse) and in
  ApiGateway, so all version-level analytics were blind: events of all releases
  were written as a single version.

  Now the version is threaded from package.json via vite `define`
  (`__SDK_VERSION__`) — a string literal in the bundle, and `.d.ts` keeps
  `const SDK_VERSION: string`. `define` is duplicated in vitest.config (it doesn't
  inherit vite.config), otherwise the token wouldn't be substituted in tests.

- 3d325f9: Two fixes in the paywall modal.

  **1. `PurchaseSuccessView` — typography/CTA per the canon.** The success view
  ("Payment received" / "Subscription restored") was out of step with the rest of the
  paywall: a small `text-lg` title, a `text-sm`/`gray-500` subtitle and
  a compact inline button with its own gradient. Brought to the `reset_sent` canon
  (AuthPanel): `text-3xl font-bold` title, `text-base`/`gray-600`
  subtitle, a full-width `pw-cta-shimmer` button. Texts and i18n keys were not
  touched, `id="pw-title"` (the modal's aria-labelledby) is preserved.

  **2. `paywall_opened`/`paywall_viewed`/`paywall_closed` analytics —
  gated on a real paywall.** These events hung on the public `'open'`/`'ready'`/
  `'close'`, which are emitted for **any** view. So opening support
  (`openSupport`), standalone-auth and re-mounting `awaiting_payment`/`popup_blocked`
  after a headless-checkout sent a false `paywall_opened` (and `paywall_viewed`/
  `paywall_closed`) to `/events`. Added `lastMountedView` (set in
  `mountAndShow`); the analytics for these three events is now sent only when
  `view === 'layout'`. The public `'open'`/`'ready'`/`'close'` events are not
  changed — hosts get them for all views as before; only the
  sending of analytics to the server is gated.

## 3.0.0-beta.13

### Patch Changes

- Server-SDK: manual token credit/debit — `BillingClient.creditTokens()` / `debitTokens()`.

  apiKey-only methods that adjust the token balance of a tokenized-paywall user on behalf
  of the merchant's backend (identity by email/userId). `creditTokens` adds, `debitTokens`
  subtracts and throws `PaywallError('insufficient')` if it would go below zero.
  Not accessible from the browser (no apiKey → `apikey_required`) — a client must not be able to
  credit itself tokens. Returns `{ type, count }` with the new balance.

  Requires a paired deploy: the online endpoint `POST /api/v1/paywall/[id]/balances` +
  applying the SQL migration `adjust_paywall_balance` (atomic delta in JSONB, without
  lost-update from concurrent debits by the api-gateway). Daily-trial balances above
  the limit are not overwritten.

## 3.0.0-beta.12

### Patch Changes

- Auth: `AuthUser` now carries the profile from the OAuth provider — `name` and `avatar`.

  Previously the SDK returned only `{ id, email, country, is_anonymous }`, and the avatar (Google
  puts it in `user_metadata.avatar_url`) was never exposed anywhere. Added
  optional `name` / `avatar` to `AuthUser` — populated from the OAuth profile at
  `/oauth/exchange` and available from the session (`auth.getCachedUser()?.avatar`,
  `onAuthChange`) without an extra request. For email/anon users — `null` (no avatar).

  Requires a paired online deploy (`/oauth/exchange` now sets `name`/`avatar` from
  `user_metadata`). Without it the fields will be `undefined` — does not break the existing behavior.

## 3.0.0-beta.11

### Patch Changes

- UI: badge of the last sign-in method next to the OAuth buttons — "Last" → "Last used" (clearer that it's "the last used method").

  Renamed in canonical EN, the inline fallbacks of `AuthPanel`, and across all 27 locales
  (`auth.last_used` / `auth.last_used_no_email`): EN `Last used · {email}`, RU
  `Последний вход · …`, DE `Zuletzt genutzt`, ES `Última vez`, JA `前回使用`, etc.
  This also closed a coverage gap — previously `auth.last_used` (with email) was only
  partially translated and some locales fell back to the English inline fallback.

## 3.0.0-beta.10

### Patch Changes

- OAuth identity-already-linked: classification by error description — resilience to version skew callback↔SDK.

  In prod it turned out that the hosted OAuth callback can forward only
  the human-readable `error_description` ("Identity is already linked to another
  user"), but NOT the machine-readable `error_code` (the callback page deploys independently of
  the npm SDK; an old/cached build doesn't pass `error_code`). beta.9
  classified switch-account only by `errorCode`, so
  `identity_already_exists` arrived as a generic `oauth_failed` → "Sign-in failed"
  with no button.

  - `isIdentityAlreadyLinked()` now matches both `errorCode === 'identity_already_exists'`
    and the error text (`already linked` / `identity_already_exists`) as a fallback —
    the "sign in with that account" button shows regardless of whether the deployed
    callback forwards `error_code`.

## 3.0.0-beta.9

### Patch Changes

- OAuth `identity_already_exists`: reliable one-click "switch account" instead of seamless popup-reuse.

  beta.8 tried to seamlessly switch accounts by reusing the same popup
  (`popup.location.replace`). In a real environment this is unstable: COOP (Google)
  severs the opener↔popup handle, and a second exchange in the same flow added a point of failure —
  the end result being a generic "Sign-in failed" instead of the switch branch.

  - Removed popup-reuse. `identity_already_exists` is now surfaced directly as
    `oauth_identity_already_linked`, and `AuthPanel` shows a clear message +
    a "Continue with <provider>" button. A fresh click → `signInWithOAuth({ switchAccount: true })`
    → a clean signin (new popup, new PKCE exchange) into the account that owns the
    identity. Parity with the legacy `switch_account` branch.
  - `AuthPanel` logs the real OAuth error code/description to `console.warn` —
    previously the generic fallback hid the cause.
  - Removed the unused `reuseState` from `startOAuthFlow` and `auth.oauthStart`.

## 3.0.0-beta.8

### Patch Changes

- OAuth: auto-switch to an existing account on `identity_already_exists` + clear UX for the email collision.

  Previously, signing in via Google/Apple under an anonymous session went through `linkIdentity`, and if
  the provider was already linked to another account, GoTrue returned `identity_already_exists`,
  and the SDK showed a blank "Sign-in failed".

  - `signInWithOAuth` catches `identity_already_exists` and seamlessly switches to a regular
    signin, **reusing the same popup** (`popup.location.replace` to the signin flow with the same
    state; the provider's SSO is already active → near-instant). Added `switchAccount` to
    `signInWithOAuth`/`startOAuthFlow` (doesn't send Bearer → no linkIdentity) and `waitForOAuthResult`
    (a structured outcome with `errorCode`, doesn't close the popup itself). If the popup can't be reused
    (COOP severed the handle) — a fallback button "sign in with that account" (a fresh user gesture).
    Mirrored in the `sdk-extension` split-flow (`auth.oauthStart` got
    `switchAccount`/`reuseState`).
  - Email collision: due to anti-enumeration, GoTrue masks an already-taken email (incl. OAuth-only)
    as "confirm your email". `signUp` now returns `already_registered`, and `AuthPanel`
    sends the user to the signin form with a clear hint instead of the dead-end "check your email".
  - New i18n keys `auth.email_already_registered` / `auth.identity_already_linked`
    (canonical EN + 27 locales).

  Requires a paired deploy of the online part (the v3 OAuth callback now passes `error_code` and
  doesn't close the popup on `identity_already_exists`; `/auth/email/signup` returns
  `already_registered`). An old SDK with the new callback and a new SDK with the old callback
  degrade gracefully — without infinite popups.

## 3.0.0-beta.7

### Patch Changes

- Fix for the awaiting screen hanging after payment in an extension page.

  The awaiting→success transition was tied **exclusively** to `UserWatcher.onActive`,
  and the watcher itself didn't run for the entire `chrome-extension://` protocol
  (`shouldRunUserWatcher` treated any such context as an ephemeral action-popup).
  In a full-fledged extension page (side panel / separate tab) that
  survives the checkout, the poller was off, and there was no one to close the awaiting screen — even
  the manual "I've paid" button just sent a `window.postMessage` to wake up a
  nonexistent watcher. The purchase went through, `/user-state` returned
  `has_active_subscription: true`, and the screen hung.

  - The transition is centralized in the idempotent `handlePurchaseDetected`, which
    is called from `billing.onUserChange` — any source of fresh active
    user-state (manual `getUser`, cross-context broadcast, watcher) closes
    awaiting. Gated on the checkout views (`awaiting_payment`/`popup_blocked`), so
    opening the paywall for an already-subscribed user doesn't trigger a false positive.
  - `shouldRunUserWatcher` no longer cuts off `chrome-extension://` — the surviving
    page both can and should poll; the ephemeral action-popup harmlessly
    tears down with the context (detection there covers bootstrap on the
    next open).

## 3.0.0-beta.6

### Patch Changes

- The SDK version is injected from package.json at build time instead of being hardcoded.

  `SDK_VERSION` stuck as a hardcoded literal `'3.0.0-alpha.0'` through every
  release (alpha.x → beta.x) — it was never bumped. It goes out in `X-SDK-Version`
  on all requests, in the `sdk_version` of every analytics event (ClickHouse) and in
  ApiGateway, so all version-level analytics were blind: events of all releases
  were written as a single version.

  Now the version is threaded from package.json via vite `define`
  (`__SDK_VERSION__`) — a string literal in the bundle, and `.d.ts` keeps
  `const SDK_VERSION: string`. `define` is duplicated in vitest.config (it doesn't
  inherit vite.config), otherwise the token wouldn't be substituted in tests.

## 3.0.0-beta.5

### Patch Changes

- Fix for diverging focus and selection when opening the paywall.

  On auto-open of the modal (without a preceding user gesture) the browser
  `:focus-visible` heuristic drew a ring on the first focusable control — but
  the first `button` in the DOM is the first plan card (e.g. monthly), whereas
  the _selected_ plan is the popular one (`popular_price_id`), which has the accent border.
  The focus ring ended up on one card and the selection highlight on another; two
  conflicting "active" states were confusing.

  `Modal` no longer focuses the first interactive element — focus goes
  to the dialog container itself (`tabIndex=-1`, `outline-none` → no ring). The focus
  trap keeps the anchor inside the dialog, `Tab` cycles the controls as before, and for
  screen readers focus on the `aria-modal` dialog is correct. Added an explicit opt-in
  `[data-pw-autofocus]` for views that need input autofocus.

## 3.0.0-beta.4

### Patch Changes

- Fixes to the paywall modal and the wording of the success screen.

  **1. Scroll for self-contained status views.** The modal dialog is height-constrained
  (`max-h … overflow-hidden`), and the scroll zone (`flex-1 min-h-0 overflow-y-auto`)
  was set up only by `Renderer`/`AuthGate`/`SupportGate`. Simple status views
  (`PurchaseSuccessView`, `LoadingView`, `ErrorView`, `AwaitingPaymentView`,
  `PopupBlockedView`) rendered without a wrapper and, when height was tight (small
  screens, extension popup ~600px), got clipped with no way to scroll.
  Added a shared `Scroll` wrapper for these views; `Renderer`/`AuthGate`/`SupportGate`
  are not wrapped — they have their own scroll + a pinned footer.

  **2. Horizontal padding on `PurchaseSuccessView`.** The view root had only
  vertical padding, and the `Continue` button was `w-full`, so it
  stretched to the dialog edges and its glow/shimmer spilled over the edge. Added
  `px-6 sm:px-8` — like the neighboring views.

  **3. Neutral success/restored wording.** "Your subscription is now
  active." / "Subscription restored" are incorrect for lifetime purchases (it's not
  a subscription). Success subtitle → "You're all set — enjoy!", restored title →
  "Welcome back", restored subtitle → the same "You're all set — enjoy!". Updated the
  EN reference, the inline fallbacks and all 27 locales (`tools/sdk-translations.mjs` +
  regeneration via `gen-locales.mjs`).

## 3.0.0-beta.3

### Patch Changes

- a6b7a3a: Removed the `paywall_opened` analytics event. Now a paywall display is recorded by
  a single signal — `paywall_viewed` (emitted on `'ready'`, after the
  bootstrap loads, with `prices_count`/`offers_count`/`is_test_mode`). `'open'` is no longer
  tracked separately, neither in the main SDK nor in the extension channel.

  Motivation: `opened` and `viewed` duplicated each other in the dominant pattern
  (warm bootstrap → both events in one batch), and an extra event on every
  open multiplied the POST load on `/events` and the rows in `paywall_sdk_events`
  at prod scale (thousands of simultaneous opens). The funnel is built from
  `viewed`. The server (`online`) no longer accepts `paywall_opened` in the whitelist.

## 3.0.0-beta.2

### Minor Changes

- 179e4a6: security(billing): `BillingClient` now **throws** `PaywallError('apikey_in_browser')` from the constructor when `apiKey` is passed in a browser context (`window.document` detected), instead of merely logging `console.error` and continuing.

  A server-SDK `apiKey` identifies the paywall owner and can act on any paywall the account owns; leaking it into client code exposes the whole account. The previous behavior (warn-but-proceed) let a naive integrator ship a working-looking bundle that silently leaked the key. Now the leak fails loudly on the first `new BillingClient(...)`.

  ```ts
  // ❌ browser — throws synchronously
  new BillingClient({ paywallId, apiOrigin, apiKey: "sk_live_..." });
  // PaywallError('apikey_in_browser')

  // ✅ trusted backend — unchanged
  new BillingClient({
    paywallId,
    apiOrigin,
    apiKey: process.env.MONETIZE_API_KEY,
  });
  ```

  Escape hatch for deliberate browser injection (e2e/integration tests only):

  ```ts
  new BillingClient({
    paywallId,
    apiOrigin,
    apiKey,
    allowInsecureBrowserUsage: true,
  });
  // no throw — downgrades to a console.error warning. Never use in production.
  ```

  Notes:

  - New option `allowInsecureBrowserUsage?: boolean` (default `false`).
  - This is a **client-side** guard only. The backend still honors any valid key regardless of Origin — it does not replace rotating a key that has already leaked, nor a CI grep-check for `apiKey` in client bundles.
  - Server runtimes (Node/Deno/Bun/Edge — no `window.document`) are unaffected.

## 3.0.0-beta.1

### Patch Changes

- docs/meta: README trim + npm keywords

  - **sdk**: dropped the "Status: alpha" note from the README.
  - **all three**: added `keywords` to `package.json` for npm discoverability (paywall, billing, subscriptions, monetization, checkout, …; plus per-package react / chrome-extension / manifest-v3 terms).
  - Monorepo README: removed the CDN "React via import map", "Alternative CDNs" and "Trade-offs" subsections; React-on-website now points at the bundler install path.

  No code changes.

## 3.0.0-beta.0

### Patch Changes

- Signup email-confirm: moved to a link flow (like recovery) instead of a dead-end
  code-entry screen.

  The prod email template "Confirm signup" sends a confirmation **link** (redirect_to →
  `/paywall/v3/auth/confirm`), not a 6-digit code. But the modal, after signUp →
  `confirmation_required`, showed the `signup_verify` screen with a code input —
  the user hit a dead end: they were asked to enter a code, but there was none in the email.

  Now after signUp the `signup_sent` screen is shown ("check your email →
  click the link", mirroring `reset_sent`). Confirmation completes on the
  v3 page, the session syncs cross-tab → the auth gate advances on its own, as with a
  regular signin. Symmetric to the recovery flow (forgot → reset_sent).

  Removed the `signup_verify` mode and its OTP branch; added the key
  `auth.signup_sent_subtitle` (canonical-en + 27 locales).

## 3.0.0-alpha.22

### Patch Changes

- Two fixes in the paywall modal.

  **1. `PurchaseSuccessView` — typography/CTA per the canon.** The success view
  ("Payment received" / "Subscription restored") was out of step with the rest of the
  paywall: a small `text-lg` title, a `text-sm`/`gray-500` subtitle and
  a compact inline button with its own gradient. Brought to the `reset_sent` canon
  (AuthPanel): `text-3xl font-bold` title, `text-base`/`gray-600`
  subtitle, a full-width `pw-cta-shimmer` button. Texts and i18n keys were not
  touched, `id="pw-title"` (the modal's aria-labelledby) is preserved.

  **2. `paywall_opened`/`paywall_viewed`/`paywall_closed` analytics —
  gated on a real paywall.** These events hung on the public `'open'`/`'ready'`/
  `'close'`, which are emitted for **any** view. So opening support
  (`openSupport`), standalone-auth and re-mounting `awaiting_payment`/`popup_blocked`
  after a headless-checkout sent a false `paywall_opened` (and `paywall_viewed`/
  `paywall_closed`) to `/events`. Added `lastMountedView` (set in
  `mountAndShow`); the analytics for these three events is now sent only when
  `view === 'layout'`. The public `'open'`/`'ready'`/`'close'` events are not
  changed — hosts get them for all views as before; only the
  sending of analytics to the server is gated.

## 3.0.0-alpha.21

### Patch Changes

- Fix: an expired offer stopped giving the discount in the countdown banner, but
  remained in the prices inside the modal and was passed to checkout.

  `PriceGrid` (strike-through / `-X%` in the modal cards) and the checkout path in
  `PaywallRoot` resolved the offer via the raw `findApplicableOffer`, which
  filters only by `price_id` + `discount_percent > 0` and **doesn't check
  the deadline**. Host pricing (`usePaywallOffer` → `getOfferForPrice` →
  `resolveOffer`) and the countdown banner (`useOfferCountdown`) do account for
  expiry. The result was a desync: the offer expired, the banner is hidden and there's no
  discount in the host cards, but in the modal cards the discount with strike-through still hung on.

  The second, more unpleasant side-effect was checkout. For `duration_minutes`
  offers there's no server-side timer, the backend trusts the passed `offerId`. The raw
  `findApplicableOffer` sent the id of the expired offer to `createCheckout` → the backend
  would apply a discount no longer visible in the UI.

  Fix: a new `findLiveOffer(offers, priceId, opts)` in `core/offer.ts` —
  an expiry-aware wrapper (`findApplicableOffer` → `resolveOffer`, cuts off
  the expired). `PriceGrid` (all 4 call-sites) and checkout in `PaywallRoot`
  were switched to it with `readStart: readBrowserOfferStart`. Now the discount in
  the modal cards and the `offerId` at checkout disappear in sync with the banner.

  The "offer hasn't started yet" semantics (no marker) is preserved — `resolveOffer`
  treats such a `duration_minutes` offer as perpetual, the discount is shown.

  Not covered is the minor case "modal open at the moment of expiry": `PriceGrid` doesn't
  tick once a second, so the discount survives until the next re-render. Opening
  the paywall _after_ expiry (the main bug) is fully closed.

## 3.0.0-alpha.20

### Patch Changes

- `OfferBanner` — fix offer-farming via re-opening the paywall.

  `useOfferCountdown`, on `expired === true`, deleted the key
  `pw-offer-<id>-start` from localStorage, treating it as safe cleanup.
  But that very key is the only forever-marker that "this offer has already
  started for the user". Without it, `resolveEndMs` on the next paywall open
  wrote a fresh `start` (= `Date.now()`) and the countdown started
  over — even though the offer had long since expired.

  The scenario a user can exploit:

  1. Sees the offer → timer started, key saved.
  2. Logs in, opens checkout, closes it without paying.
  3. Closes the paywall → timer ticks in the background → expires → `removeItem`.
  4. Opens the paywall again → the offer shows the full `duration_minutes`.

  Fix: on expiry we stop the `setInterval`, but do NOT delete the key from storage.
  On the next resolve `start + duration < now` → the banner
  is hidden via the standard `timeLeft.expired` guard. A user physically
  cannot "farm" the offer by re-opening.

  Side-effect: localStorage accumulates one ~50-byte key per
  every offer that ever started. An acceptable price for correctness.

## 3.0.0-alpha.19

### Patch Changes

- i18n — translations for the new `reset_sent` view.

  Added three keys to `sdk-translations.mjs` and generated into all 27
  locales via `tools/gen-locales.mjs`:

  - `auth.reset_sent_subtitle` — explanation under the "Check your email" title.
  - `auth.reset_link_valid` — hint "The link is valid for 1 hour.".
  - `auth.back_to_login` — label of the primary button.

  Before this release these strings rendered through the English inline-fallback
  in the `t()` call — the title was localized, the rest stayed in English.

## 3.0.0-alpha.18

### Patch Changes

- `AuthPanel` — native "Check your email" screen after a password reset request.

  Previously, after sending the reset email, `auth_panel` showed a grey
  info-banner with text and the standard form header — it looked like a
  technical notification rather than a confirmation of the action. Now
  `reset_sent` is a separate success-view: a green circle with a checkmark
  (the same visual palette as the success-state in `PaywallRoot`),
  a large "Check your email" title, an explanatory subtitle, the user's email
  in bold, and a hint about the link's validity. At the bottom — a large primary
  "Back to Login" button in the brand accent color.

  New i18n keys (with English fallback inline):

  - `auth.reset_sent_subtitle` — "We sent a password reset link. Follow
    the instructions in the email to reset your password."
  - `auth.reset_link_valid` — "The link is valid for 1 hour."
  - `auth.back_to_login` — "Back to Login"

  The old `setInfo(...)` and the grey info-banner for `reset_sent` are removed —
  the text now lives in the view itself.

## 3.0.0-alpha.17

### Minor Changes

- `billing.getCustomerPortalUrl({ returnUrl })` — host-controlled return URL.

  Adds an optional `returnUrl` parameter to `getCustomerPortalUrl()`. When
  set, the hosted portal's "Return to ..." button sends the user back to
  that URL — typically the host app's account page
  (`https://your-app.com/account`). Threads through Stripe (`return_url`),
  Paddle (`return_url`) and Chargebee (`redirect_url`).

  Previously the SDK sent nothing and the backend chose `shop_url` (the
  paywall-level "Shop URL" setting) or fell back to the online service's
  own paywall page (`NEXT_PUBLIC_ONLINE_ORIGIN/paywall/<id>/customer-portal/return`).
  For self-hosted apps both paths were off-brand — the user round-tripped
  through the online-service domain instead of landing in the host's UI.

  Backend (`online`) is required for the round trip — without the matching
  backend deploy `returnUrl` is silently ignored and the old fallback chain
  kicks in. The backend deploy also:

  - Adds `custom_domain/paywall/<id>/customer-portal/return` to the
    fallback chain (between `shop_url` and `NEXT_PUBLIC_ONLINE_ORIGIN`) so
    even hosts that don't pass `returnUrl` get a sensible URL when their
    paywall has a custom domain.
  - Re-enables `return_url` in the Paddle portal request body (was
    commented out).
  - Forwards `redirect_url` to Chargebee `/portal_sessions`.
  - Propagates the actual Stripe error message when checkout fails instead
    of swallowing it as `{ errorRedirect }` (was returning a malformed
    shape that callers couldn't diagnose).

  Example:

  ```ts
  const { url } = await paywall.billing.getCustomerPortalUrl({
    returnUrl: `${window.location.origin}/account`,
  });
  window.open(url, "_blank", "noopener,noreferrer");
  ```

## 3.0.0-alpha.16

### Patch Changes

- `paywall.getAccess()`: read fresh user from `cachedUser` instead of stale
  `getCachedBootstrap().user`.

  Before: when bootstrap was cached (typical after the pricing page loaded
  it), `getAccess()` resolved `user` from `getCachedBootstrap().user` — the
  snapshot taken at the time bootstrap was fetched. After a successful
  purchase the UserWatcher poll updates `billing.cachedUser` and emits
  `userChange`, host's `usePaywallAccess` re-runs `getAccess()` — but the
  cached bootstrap still has the pre-purchase user snapshot, so the hook
  returns `blocked` even though the user really has an active subscription.

  After: prefer `billing.getCachedUser()` (which reflects every userChange),
  falling back to `bootstrap.user` only when the user cache is empty (cold
  start, post-signOut). `getCachedBootstrap()` continues to return the raw
  structure — it's used elsewhere for non-user fields and we don't want to
  pay a re-merge cost on every call.

  Symptom this fixes: `<PaywallGate>` and `usePaywallAccess` staying in
  `blocked` after a successful checkout (UI didn't react to Pro). Account
  page kept working because `usePaywallUser` reads `getCachedUser()`
  directly — only the access-resolution path was hitting the stale view.

  Async path (cold bootstrap) was already correct: `BillingClient.bootstrap()`
  overlays cachedUser onto the returned bootstrap (`{ ...cachedBootstrap, user: cachedUser ?? undefined }`).

## 3.0.0-alpha.15

### Patch Changes

- Modal: typography hierarchy fix for `PopupBlockedView` and
  `AwaitingPaymentView`; better popup-blocked icon.

  Both views had a flat hierarchy — title (`text-sm`) and subtitle (`text-xs`)
  read as the same weight, so users couldn't see at a glance what the
  screen was about. Aligned with `PurchaseSuccessView` (the canonical
  "outcome view" template): `text-lg` semibold title with `id="pw-title"`
  for modal `aria-labelledby`, `text-sm` leading-relaxed subtitle, a
  larger `h-14 w-14` icon container so the visual anchor reads as a
  primary status indicator rather than an inline accent.

  `PopupBlockedView` also gets a more meaningful icon — an external-link
  arrow (window with arrow up-right) instead of the previous check-in-box,
  which read as "saved/done" and didn't convey "allow popups".

## 3.0.0-alpha.14

### Patch Changes

- `BillingClient.createCheckout`: auto-send `localCurrency`.

  Resolves the user's local currency from the cached bootstrap
  (`price.local.currency` on the target `priceId`) and threads it into the
  `/start-checkout` body. Without this the backend fell back to the base
  currency on the hosted checkout — the SDK showed £9.99 on the paywall
  and Stripe opened with $9.99, a literal UI/checkout mismatch.

  No host code changes required: the resolution happens automatically
  inside `createCheckout` from `cachedBootstrap.prices`. The backend
  contract field (`localCurrency`) and the body comment already mentioned
  it — the SDK simply wasn't sending it.

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

## 3.0.0-alpha.11

### Patch Changes

- Export `PaywallPurchaseDetailed` from the package root — the rich purchase
  shape returned by `BillingClient.listPurchases()` (used to render customer-
  portal subscription lists). Was already implemented and documented, just
  missing from the public re-export barrel.

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

## 3.0.0-alpha.9

### Minor Changes

- Auth/extension/i18n fixes:

  - **Anonymous sign-in option renamed.** `AuthClient.signInAnonymously({ forceCaptcha })` → `signInAnonymously({ forceNewAnon })`. Same semantics (skip idempotent + resume, force a fresh anon `/signin`), clearer name now that captcha is no longer in the flow. The extension transport (`auth.signInAnonymously`) field is renamed too. **Breaking** for callers that passed `forceCaptcha: true` — search/replace to `forceNewAnon: true`.
  - **MV3 onConnect duplicate-handler fix (sdk-extension).** `chrome.runtime.connect` is delivered to _every_ extension context with an `onConnect` listener — including offscreen, alongside the SW. With a single shared port name, one `popup.connect()` opened two ports in offscreen (SW relay + direct popup), so each popup → SW send was handled twice. Split into `PORT_NAME` (content/popup → SW) and `RELAY_PORT_NAME` (SW → offscreen); offscreen now accepts only the relay name.
  - **AuthPanel double-submit guard.** `useRef` synchronous guard around `onSubmit`/`onOAuth`. `setBusy` is async setState; back-to-back submits in one tick (Enter + click, demo-ext double-mount, transport race) both passed the `if (busy) return` check and fired the network request twice (e.g. double `requestPasswordReset`).
  - **i18n: `auth.rate_limited` copy.** "Too many requests. Please try again **later**." (was "in a moment"). More accurate for Supabase rate-limit windows (minutes, not seconds). Translated across all 27 locales.

- feat(billing): `listPurchases` and `cancelSubscription` now accept `apiKey` + `identity` (server-SDK path), in addition to the existing Bearer (`AuthClient`) path.

  Before this change, both methods required a connected `AuthClient` and threw `PaywallError('auth_required')` when called without one — making them unusable for headless integrations whose customers don't run monetize.software's auth.

  Now:

  ```ts
  const billing = new BillingClient({
    paywallId,
    apiOrigin,
    apiKey: process.env.MONETIZE_API_KEY!,
    identity: { email: user.email, userId: user.id },
  });

  const purchases = await billing.listPurchases();
  await billing.cancelSubscription({ subscriptionId, reason: "..." });
  ```

  Notes:

  - Identity (email or your stable `userId`) is sent as `?email=` / `?user_id=` (listPurchases) or in the body (cancelSubscription).
  - Bearer path is unchanged — UI customer portals built on `AuthClient` keep working.
  - Without either path, both methods now throw `identity_required` (was `auth_required`).
  - The backend additionally verifies the identity is linked to your paywall (via `user_paywalls` or any prior purchase). Querying users that never interacted with your paywall returns `identity_not_on_paywall` (404) — cross-paywall lookup is blocked by design.
  - `cancelSubscription` adds a `paywall_id` filter on the apiKey path, so the owner of paywall A cannot cancel a subscription on paywall B even by guessing IDs.

## 3.0.0-alpha.8

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

## 3.0.0-alpha.7

### Patch Changes

- docs: README cleanup across all three packages

  - **sdk**: dropped stale "Not in this version (alpha)" block that listed Auth, trials, i18n, React adapter and tests as missing — all shipped. Replaced with an accurate "What's included" section. Added required `apiOrigin` (custom_domain) to Quick start and ApiGateway examples. Expanded provider list to the real set: Stripe / Paddle / Freemius / Chargebee / Overpay. Removed broken `../TODO.md` link. Clarified CDN policy: allowed for websites, forbidden for Chrome extensions.
  - **sdk-extension**: fixed `host_permissions` manifest snippet — was `["https://api.monetize.software/*"]` (a domain that doesn't exist), now points to the host's own `apiOrigin` (custom_domain) with a placeholder. Removed the misleading `"permissions": ["identity"]` optional line — SDK does not use `chrome.identity` (OAuth runs via a popup window against the host's `apiOrigin`). Removed the stale "Phase 0 — skeleton" status block and "Usage (target shape, when complete)" framing — package is published and in use. Architecture diagram annotation corrected to reflect the popup-window OAuth flow.
  - **sdk-react**: translated README from Russian to English to match the other two packages. Added required `apiOrigin` to Quick start and SSR/Next.js examples.

  No code changes.

## 3.0.0-alpha.6

### Minor Changes

- i18n force-locale + structured auth errors + price grid polish

  - **`PaywallUI.locale` option + `PaywallUI.setLocale()`**: explicit language override for I18nProvider, bypassing navigator.language and the owner-translations check. Needed for the admin editor's live-preview ("Preview as user from <country>") — there the browser locale is always EN. `setLocale(null)` restores the automatic resolution logic; live updates via `handle.update`. Marked `@internal` — end integrators don't need to force the language.
  - **AuthPanel: structured error mapping**. Previously `err.message` showed the raw HTTP statusText ("Unauthorized", "Bad Request") — English-only and unlocalized. Now `authErrorMessage()` maps stable `err.code` values (`invalid_credentials`, `email_not_confirmed`, `email_exists`, `weak_password`, `invalid_otp`, `rate_limited`, `network_error`, `service_unavailable`, …) to `auth.*` i18n keys. For unknown codes — generic fallback `auth.signin_failed`/`auth.signup_failed`. 8 new i18n keys, translated across all 27 bundled locales.
  - **PriceGrid: compact view as card**. Compact mode now wraps the rows in `rounded-xl border bg-gray-50` — mirroring the legacy `PaywallPricing` wrapper for the non-default view. Separates the prices block from the rest of the layout.
  - **PriceGrid: smart strike-row reservation**. The horizontal view reserves 22px of height for "strike-through originalAmount + discount-pill" on ALL cards only if at least one price in the grid has a discount. If no card has an offer — the row is not rendered, leaving no 22px of empty space under the label.
  - **PriceGrid: removed the `trial_days` hint** under the main amount (more compact layout, trial-info stays in CtaButton).
  - **TokenizationGate: lifetime copy**. For `interval === 'lifetime'` (or missing) the new key `pricing.included_total` ("Included for lifetime:") is rendered instead of `pricing.included_per` ("Included per {interval}:").
  - **Renderer.hasTopBanner**: prop to reduce the top-padding of the scrollable zone when an OfferTopBanner is rendered above the dialog.
  - **i18n cleanup**: `auth.check_email_title` is now a short neutral heading ("Check your email") — the legacy translation of the long signup-link phrase was incorrect for the forgot-password flow.

## 3.0.0-alpha.5

### Patch Changes

- Popup bug fixes + UI polish

  - `PaywallRoot`: an anon session no longer blocks the "Restore Purchases" button and preauth-checkout (treated as "not logged in" in both places, consistent with `CurrentSession`/`AuthPanel`)
  - `PaywallRoot`: the X close button returns on standalone `openAuth()` — without a Back arrow the modal couldn't be closed except by ESC
  - `PaywallRoot`: `useLayoutEffect` instead of `useEffect` for syncing gate-state on `open/initialView` — fixes the flash of the plan layout on a repeated `openAuth()` (noticeable in the extension popup due to RemoteAuth/RemoteBilling RTT)
  - `RemoteAuthClient`: implemented `getLastLogin()` (was not mirrored, AuthPanel crashed with `r.getLastLogin is not a function` in the popup console)
  - `AuthPanel`: defensive guard on `getLastLogin` — old sdk-extension builds / custom AuthClients don't break the signin form
  - Compile-time tests: `RemoteAuthClient.test-d.ts` and `RemoteBillingClient.test-d.ts` catch divergences of the proxy classes from the base ones at `tsc --noEmit`

## 3.0.0-alpha.4

### Major Changes

- BREAKING: `apiOrigin` is now a **required** field on `BillingClient`, `AuthClient`, `ApiGatewayClient` — pass the paywall's `custom_domain` configured in the platform. The previous `https://appbox.space` fallback is removed (it was used only by the legacy v2 SDK). The SDK checks `apiOrigin` against `bootstrap.settings.custom_domain` and throws `invalid_config` on mismatch — a guard against integrator typos.

  Also:

  - New layout block `guarantee_badge` (money-back badge under the CTA, icon `dollar_shield` or `none`).
  - `PaywallSettings.custom_domain` — new field in bootstrap, normalized via `URL().origin`.
  - Default layout now includes `guarantee_badge` + `current_session` after the CTA.
  - PriceGrid: currency as a separate element next to the amount, plan label in ALL CAPS, checkmark on the right, selector without radio.
  - Modal: Test-mode badge — absolute over the dialog (rounded pill, not a banner on top), close-button repositioned.
  - CtaButton: shimmer animation (CSS), rounded-full, richer gradient with inset glow.
  - CurrentSession: accent-color links (instead of grey).
  - Heading h1: 1.875rem (was 1.625), bold, text-balance.
  - TokenizationGate: rich checkmark on an accent background.
