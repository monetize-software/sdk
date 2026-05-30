# @monetize.software/sdk

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

  - **`PaywallUI.locale` option + `PaywallUI.setLocale()`**: explicit-override языка для I18nProvider, минующий navigator.language и owner-translations check. Нужен live-preview редактору админки («Preview as user from <country>») — там browser-locale всегда EN. `setLocale(null)` возвращает автоматическую резолв-логику; live-обновление через `handle.update`. Помечено `@internal` — конечным интеграторам форсить язык не нужно.
  - **AuthPanel: structured error mapping**. Раньше `err.message` показывал сырой HTTP statusText ("Unauthorized", "Bad Request") — англоязычный и нелокализованный. Теперь `authErrorMessage()` маппит стабильные `err.code` (`invalid_credentials`, `email_not_confirmed`, `email_exists`, `weak_password`, `invalid_otp`, `rate_limited`, `network_error`, `service_unavailable`, …) на i18n-ключи `auth.*`. Для непонятных кодов — generic fallback `auth.signin_failed`/`auth.signup_failed`. 8 новых i18n-ключей, переводы на все 27 bundled locales.
  - **PriceGrid: compact view as card**. Compact-режим теперь wrap'ит строки в `rounded-xl border bg-gray-50` — зеркало legacy `PaywallPricing` wrapper'а для non-default view. Отделяет блок цен от остального layout'а.
  - **PriceGrid: smart strike-row reservation**. Горизонтальный view резервирует 22px высоту под "strike-through originalAmount + discount-pill" у ВСЕХ карточек только если хоть одна цена в гриде имеет скидку. Если оффера нет ни у одной — row не рендерится, не остаётся 22px пустоты под label'ом.
  - **PriceGrid: убран `trial_days` хинт** под main amount (компактнее layout, trial-info остаётся в CtaButton).
  - **TokenizationGate: lifetime copy**. Для `interval === 'lifetime'` (или отсутствующего) рендерится новый ключ `pricing.included_total` ("Included for lifetime:") вместо `pricing.included_per` ("Included per {interval}:").
  - **Renderer.hasTopBanner**: prop для уменьшения top-padding scrollable-зоны когда над dialog'ом рендерится OfferTopBanner.
  - **i18n cleanup**: `auth.check_email_title` теперь короткий нейтральный заголовок ("Check your email") — legacy-перевод длинной фразы про signup-link был некорректен для forgot-password flow.

## 3.0.0-alpha.5

### Patch Changes

- Popup bug fixes + UI polish

  - `PaywallRoot`: анон-сессия больше не блокирует кнопку «Restore Purchases» и preauth-checkout (трактуется как «нет логина» в обоих местах, консистентно с `CurrentSession`/`AuthPanel`)
  - `PaywallRoot`: X-крестик возвращается на standalone `openAuth()` — без Back-стрелки модалку было нельзя закрыть кроме ESC
  - `PaywallRoot`: `useLayoutEffect` вместо `useEffect` для синхронизации gate-state на `open/initialView` — фиксит flash layout'а тарифов при повторном `openAuth()` (заметно в extension-popup'е из-за RemoteAuth/RemoteBilling RTT)
  - `RemoteAuthClient`: реализован `getLastLogin()` (был не зеркалирован, AuthPanel падал с `r.getLastLogin is not a function` в console попапа)
  - `AuthPanel`: defensive guard на `getLastLogin` — старые билды sdk-extension'а / кастомные AuthClient'ы не валят signin-форму
  - Compile-time tests: `RemoteAuthClient.test-d.ts` и `RemoteBillingClient.test-d.ts` ловят расхождения proxy-классов с базовыми ещё на `tsc --noEmit`

## 3.0.0-alpha.4

### Major Changes

- BREAKING: `apiOrigin` теперь **обязательное** поле у `BillingClient`, `AuthClient`, `ApiGatewayClient` — передавайте `custom_domain` пейвола, заданный в платформе. Прежний fallback `https://appbox.space` удалён (он использовался только legacy v2 SDK). SDK сверяет `apiOrigin` с `bootstrap.settings.custom_domain` и кидает `invalid_config` при расхождении — защита от опечатки интегратора.

  Также:

  - Новый layout block `guarantee_badge` (money-back бейдж под CTA, иконка `dollar_shield` или `none`).
  - `PaywallSettings.custom_domain` — новое поле в bootstrap, нормализуется через `URL().origin`.
  - Default layout теперь включает `guarantee_badge` + `current_session` после CTA.
  - PriceGrid: валюта отдельным элементом рядом с amount, plan label в ALL CAPS, чекмарк справа, селектор без radio.
  - Modal: Test-mode badge — absolute поверх dialog'а (rounded pill, не баннер сверху), close-button перепозиционирован.
  - CtaButton: shimmer-анимация (CSS), rounded-full, более насыщенный градиент с inset glow.
  - CurrentSession: ссылки accent-цвета (вместо серых).
  - Heading h1: 1.875rem (было 1.625), bold, text-balance.
  - TokenizationGate: насыщенный checkmark на accent-фоне.
