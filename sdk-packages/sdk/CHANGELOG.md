# @monetize.software/sdk

## 3.0.0

### Major Changes

- 3b263a1: BREAKING: `apiOrigin` теперь **обязательное** поле у `BillingClient`, `AuthClient`, `ApiGatewayClient` — передавайте `custom_domain` пейвола, заданный в платформе. Прежний fallback `https://appbox.space` удалён (он использовался только legacy v2 SDK). SDK сверяет `apiOrigin` с `bootstrap.settings.custom_domain` и кидает `invalid_config` при расхождении — защита от опечатки интегратора.

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

  - **`PaywallUI.locale` option + `PaywallUI.setLocale()`**: explicit-override языка для I18nProvider, минующий navigator.language и owner-translations check. Нужен live-preview редактору админки («Preview as user from <country>») — там browser-locale всегда EN. `setLocale(null)` возвращает автоматическую резолв-логику; live-обновление через `handle.update`. Помечено `@internal` — конечным интеграторам форсить язык не нужно.
  - **AuthPanel: structured error mapping**. Раньше `err.message` показывал сырой HTTP statusText ("Unauthorized", "Bad Request") — англоязычный и нелокализованный. Теперь `authErrorMessage()` маппит стабильные `err.code` (`invalid_credentials`, `email_not_confirmed`, `email_exists`, `weak_password`, `invalid_otp`, `rate_limited`, `network_error`, `service_unavailable`, …) на i18n-ключи `auth.*`. Для непонятных кодов — generic fallback `auth.signin_failed`/`auth.signup_failed`. 8 новых i18n-ключей, переводы на все 27 bundled locales.
  - **PriceGrid: compact view as card**. Compact-режим теперь wrap'ит строки в `rounded-xl border bg-gray-50` — зеркало legacy `PaywallPricing` wrapper'а для non-default view. Отделяет блок цен от остального layout'а.
  - **PriceGrid: smart strike-row reservation**. Горизонтальный view резервирует 22px высоту под "strike-through originalAmount + discount-pill" у ВСЕХ карточек только если хоть одна цена в гриде имеет скидку. Если оффера нет ни у одной — row не рендерится, не остаётся 22px пустоты под label'ом.
  - **PriceGrid: убран `trial_days` хинт** под main amount (компактнее layout, trial-info остаётся в CtaButton).
  - **TokenizationGate: lifetime copy**. Для `interval === 'lifetime'` (или отсутствующего) рендерится новый ключ `pricing.included_total` ("Included for lifetime:") вместо `pricing.included_per` ("Included per {interval}:").
  - **Renderer.hasTopBanner**: prop для уменьшения top-padding scrollable-зоны когда над dialog'ом рендерится OfferTopBanner.
  - **i18n cleanup**: `auth.check_email_title` теперь короткий нейтральный заголовок ("Check your email") — legacy-перевод длинной фразы про signup-link был некорректен для forgot-password flow.

### Patch Changes

- 5902c36: UI: бейдж последнего метода входа возле OAuth-кнопок — «Last» → «Last used» (понятнее, что это «последний использованный метод»).

  Переименовано в canonical EN, inline-фоллбэках `AuthPanel` и во всех 27 локалях
  (`auth.last_used` / `auth.last_used_no_email`): EN `Last used · {email}`, RU
  `Последний вход · …`, DE `Zuletzt genutzt`, ES `Última vez`, JA `前回使用` и т.д.
  Заодно закрыт пробел в покрытии — раньше `auth.last_used` (с email) был переведён
  лишь частично и часть локалей падала на английский inline-фоллбэк.

- 2851b7f: i18n — переводы для нового `reset_sent` view.

  Добавлены три ключа в `sdk-translations.mjs` и сгенерированы во все 27
  локалей через `tools/gen-locales.mjs`:

  - `auth.reset_sent_subtitle` — пояснение под title'ом «Check your email».
  - `auth.reset_link_valid` — подсказка «The link is valid for 1 hour.».
  - `auth.back_to_login` — лейбл primary-кнопки.

  До этого релиза эти строки рендерились через английский inline-fallback
  из `t()`-вызова — title локализовался, остальное оставалось на английском.

- f513233: `AuthPanel` — нативный «Check your email» экран после запроса password reset.

  Раньше после отправки reset-письма в `auth_panel` показывался серый
  info-баннер с текстом и стандартный заголовок формы — выглядело как
  техническое уведомление, а не подтверждение действия. Теперь
  `reset_sent` это отдельный success-view: зелёный круг с галочкой
  (та же визуальная палитра, что у success-state в `PaywallRoot`),
  крупный title «Check your email», поясняющий сабтайтл, email юзера
  жирным и подсказка про срок действия ссылки. Снизу — large primary
  кнопка «Back to Login» в брендовом accent-цвете.

  Новые i18n-ключи (с английским fallback'ом inline):

  - `auth.reset_sent_subtitle` — «We sent a password reset link. Follow
    the instructions in the email to reset your password.»
  - `auth.reset_link_valid` — «The link is valid for 1 hour.»
  - `auth.back_to_login` — «Back to Login»

  Старый `setInfo(...)` и серый info-баннер для `reset_sent` убраны —
  текст теперь живёт в самом view.

- 619730d: Signup email-confirm: переход на link-флоу (как recovery) вместо dead-end
  экрана ввода кода.

  Прод email-шаблон «Confirm signup» шлёт confirmation-**ссылку** (redirect_to →
  `/paywall/v3/auth/confirm`), а не 6-значный код. Модалка же после signUp →
  `confirmation_required` показывала экран `signup_verify` с инпутом кода —
  юзер упирался в тупик: код вводить просят, но в письме его нет.

  Теперь после signUp показывается экран `signup_sent` («проверьте email →
  кликните ссылку», зеркало `reset_sent`). Подтверждение завершается на
  v3-странице, сессия синкается cross-tab → auth-гейт продвигается сам, как при
  обычном signin. Симметрично recovery-флоу (forgot → reset_sent).

  Удалён режим `signup_verify` и его OTP-ветка; добавлен ключ
  `auth.signup_sent_subtitle` (canonical-en + 27 локалей).

- c13ffc5: Auth: `AuthUser` теперь несёт профиль из OAuth-провайдера — `name` и `avatar`.

  Раньше SDK отдавал только `{ id, email, country, is_anonymous }`, а аватар (Google
  кладёт его в `user_metadata.avatar_url`) нигде наружу не пробрасывался. Добавлены
  опциональные `name` / `avatar` в `AuthUser` — заполняются из OAuth-профиля при
  `/oauth/exchange` и доступны из сессии (`auth.getCachedUser()?.avatar`,
  `onAuthChange`) без доп. запроса. У email/anon-юзеров — `null` (аватара нет).

  Требует парного деплоя online (`/oauth/exchange` теперь кладёт `name`/`avatar` из
  `user_metadata`). Без него поля будут `undefined` — не ломает существующее.

- 8b859cb: Фикс зависания awaiting-экрана после оплаты в extension-странице.

  Переход awaiting→success был завязан **исключительно** на `UserWatcher.onActive`,
  а сам watcher не запускался для всего `chrome-extension://` протокола
  (`shouldRunUserWatcher` считал любой такой контекст эфемерным action-popup'ом).
  В полноценной extension-странице (side panel / отдельная вкладка), которая
  переживает checkout, поллер был выключен, и закрыть awaiting было некому — даже
  ручная кнопка «я оплатил» лишь слала `window.postMessage` для пробуждения
  несуществующего watcher'а. Покупка проходила, `/user-state` отдавал
  `has_active_subscription: true`, а экран висел.

  - Переход централизован в идемпотентный `handlePurchaseDetected`, который
    вызывается из `billing.onUserChange` — любой источник свежего active
    user-state (ручной `getUser`, cross-context broadcast, watcher) закрывает
    awaiting. Гейт на checkout-вью (`awaiting_payment`/`popup_blocked`), чтобы
    открытие пейвола уже-подписанному юзеру не давало ложного срабатывания.
  - `shouldRunUserWatcher` больше не режет `chrome-extension://` — переживающая
    страница и может, и должна поллить; эфемерный action-popup безвредно
    тёрдаунится вместе с контекстом (детект там покрывает bootstrap при
    следующем открытии).

- c6418f7: Server-SDK: ручное зачисление/списание токенов — `BillingClient.creditTokens()` / `debitTokens()`.

  apiKey-only методы правят токен-баланс юзера токенизированного пейвола от лица
  бэкенда мерчанта (identity по email/userId). `creditTokens` добавляет, `debitTokens`
  вычитает и бросает `PaywallError('insufficient')`, если ушло бы ниже нуля.
  Из браузера недоступны (нет apiKey → `apikey_required`) — клиент не должен мочь
  начислить себе токены. Возвращают `{ type, count }` с новым балансом.

  Требует парного деплоя: online-эндпоинт `POST /api/v1/paywall/[id]/balances` +
  применение SQL-миграции `adjust_paywall_balance` (атомарная дельта в JSONB, без
  lost-update от параллельных списаний api-gateway'я). Daily-триал балансы выше
  лимита не перезатирает.

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

- a6b7a3a: Убрано аналитическое событие `paywall_opened`. Теперь показ пейвола фиксирует
  единственный сигнал — `paywall_viewed` (эмитится на `'ready'`, после загрузки
  bootstrap, с `prices_count`/`offers_count`/`is_test_mode`). `'open'` больше не
  трекается отдельно ни в основном SDK, ни в extension-канале.

  Мотивация: `opened` и `viewed` дублировали друг друга в доминирующем паттерне
  (тёплый bootstrap → оба события в одном батче), а лишнее событие на каждое
  открытие умножало POST-нагрузку на `/events` и строки в `paywall_sdk_events`
  при прод-масштабе (тысячи одновременных открытий). Воронка строится от
  `viewed`. Сервер (`online`) больше не принимает `paywall_opened` в whitelist.

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

- 63dc291: Фикс расходящихся фокуса и выбора при открытии пейвола.

  При авто-открытии модалки (без предшествующего user-gesture) браузерная
  эвристика `:focus-visible` рисовала кольцо на первом фокусируемом контроле — а
  первый `button` в DOM это первая карточка тарифа (напр. месячный), тогда как
  _выбран_ популярный план (`popular_price_id`), у которого акцентная рамка.
  Кольцо фокуса оказывалось на одной карточке, выделение выбора — на другой; два
  конфликтующих «активных» состояния сбивали с толку.

  `Modal` больше не наводит фокус на первый интерактивный элемент — фокус уходит
  на сам контейнер диалога (`tabIndex=-1`, `outline-none` → кольца нет). Ловушка
  фокуса сохраняет якорь внутри диалога, `Tab` обходит контролы как раньше, для
  скринридеров фокус на `aria-modal`-диалоге корректен. Добавлен явный опт-ин
  `[data-pw-autofocus]` для вью, которым нужен автофокус инпута.

- da0c8c5: OAuth identity-already-linked: классификация по описанию ошибки — устойчивость к version skew callback↔SDK.

  В проде выяснилось, что hosted OAuth-callback может форвардить только
  человекочитаемый `error_description` («Identity is already linked to another
  user»), но НЕ машинный `error_code` (страница callback'а деплоится независимо от
  npm-SDK; старый/закешированный билд не прокидывает `error_code`). beta.9
  классифицировал switch-account только по `errorCode`, поэтому
  `identity_already_exists` прилетал как generic `oauth_failed` → «Sign-in failed»
  без кнопки.

  - `isIdentityAlreadyLinked()` теперь матчит и `errorCode === 'identity_already_exists'`,
    и текст ошибки (`already linked` / `identity_already_exists`) как fallback —
    кнопка «sign in with that account» показывается независимо от того, форвардит
    ли развёрнутый callback `error_code`.

- f128fd3: OAuth: авто-переключение на существующий аккаунт при `identity_already_exists` + понятный UX коллизии email.

  Раньше вход через Google/Apple под анонимной сессией шёл через `linkIdentity`, и если
  провайдер уже привязан к другому аккаунту, GoTrue возвращал `identity_already_exists`,
  а SDK показывал глухое «Sign-in failed».

  - `signInWithOAuth` ловит `identity_already_exists` и бесшовно переключается на обычный
    signin, **переиспользуя тот же popup** (`popup.location.replace` на signin-флоу с тем же
    state; SSO провайдера уже активна → почти мгновенно). Добавлены `switchAccount` в
    `signInWithOAuth`/`startOAuthFlow` (не шлёт Bearer → без linkIdentity) и `waitForOAuthResult`
    (структурный исход с `errorCode`, не закрывает popup сам). Если popup переиспользовать
    нельзя (COOP оборвал handle) — фоллбэк-кнопка «войти в тот аккаунт» (свежий user-gesture).
    Зеркально реализовано в `sdk-extension` split-flow (`auth.oauthStart` получил
    `switchAccount`/`reuseState`).
  - Email-коллизия: GoTrue из-за анти-энумерации маскирует занятый email (в т.ч. OAuth-only)
    под «подтвердите почту». `signUp` теперь возвращает `already_registered`, а `AuthPanel`
    уводит юзера на форму входа с понятной подсказкой вместо тупика «проверьте почту».
  - Новые i18n-ключи `auth.email_already_registered` / `auth.identity_already_linked`
    (canonical EN + 27 локалей).

  Требует парного деплоя online-части (v3 OAuth callback теперь прокидывает `error_code` и
  не закрывает popup на `identity_already_exists`; `/auth/email/signup` отдаёт
  `already_registered`). Старый SDK с новым callback и новый SDK со старым callback
  деградируют корректно — без бесконечных popup'ов.

- 4a8a00a: OAuth `identity_already_exists`: надёжный one-click «switch account» вместо бесшовного popup-reuse.

  beta.8 пытался бесшовно переключить аккаунт, переиспользуя тот же popup
  (`popup.location.replace`). В реальном окружении это нестабильно: COOP (Google)
  обрывает хэндл opener↔popup, а второй обмен в том же флоу добавлял точку отказа —
  в итоге всплывал generic «Sign-in failed» вместо switch-ветки.

  - Убрали popup-reuse. `identity_already_exists` сразу пробрасывается как
    `oauth_identity_already_linked`, и `AuthPanel` показывает понятный текст +
    кнопку «Continue with <provider>». Свежий клик → `signInWithOAuth({ switchAccount: true })`
    → чистый signin (новый popup, новый PKCE-обмен) в аккаунт, которому принадлежит
    identity. Паритет с legacy-веткой `switch_account`.
  - `AuthPanel` логирует реальный код/описание OAuth-ошибки в `console.warn` —
    раньше generic-фоллбэк прятал причину.
  - Убран неиспользуемый `reuseState` из `startOAuthFlow` и `auth.oauthStart`.

- 638fa26: `OfferBanner` — fix offer-farming через re-open пейвола.

  `useOfferCountdown` при `expired === true` удалял ключ
  `pw-offer-<id>-start` из localStorage, считая это безопасным cleanup'ом.
  Но именно этот ключ — единственный forever-marker «этот offer уже
  стартовал для юзера». Без него `resolveEndMs` при следующем открытии
  пейвола записывал свежий `start` (= `Date.now()`) и countdown начинался
  заново — несмотря на то что offer уже давно истёк.

  Сценарий, который ловит юзер:

  1. Видит offer → таймер запущен, ключ сохранён.
  2. Логинится, открывает checkout, закрывает без оплаты.
  3. Закрывает пейвол → таймер тикает в фоне → истекает → `removeItem`.
  4. Открывает пейвол снова → offer показывает полную `duration_minutes`.

  Фикс: на expiry останавливаем `setInterval`, но ключ из storage НЕ
  удаляем. При следующем resolve `start + duration < now` → банер
  скрывается через стандартный `timeLeft.expired` guard. Юзер физически
  не может «фармить» offer повторными открытиями.

  Side-effect: localStorage накапливает по одному ~50-байтовому ключу на
  каждый когда-либо стартовавший offer. Допустимая цена за корректность.

- 8250085: Fix: просроченный offer переставал давать скидку в countdown-баннере, но
  оставался в ценах внутри модалки и улетал в checkout.

  `PriceGrid` (strike-through / `-X%` в карточках модалки) и checkout-путь в
  `PaywallRoot` резолвили offer через сырой `findApplicableOffer`, который
  фильтрует только по `price_id` + `discount_percent > 0` и **срок не
  смотрит**. Хост-прайсинг (`usePaywallOffer` → `getOfferForPrice` →
  `resolveOffer`) и countdown-баннер (`useOfferCountdown`) при этом expiry
  учитывают. Итог — рассинхрон: оффер истёк, баннер скрыт и в хост-карточках
  скидки нет, а в карточках модалки скидка со strike-through ещё висит.

  Второй, более неприятный side-эффект — checkout. Для `duration_minutes`
  офферов нет server-side таймера, бэк доверяет переданному `offerId`. Сырой
  `findApplicableOffer` слал id просроченного оффера в `createCheckout` → бэк
  применял бы скидку, которой в UI уже не видно.

  Фикс: новый `findLiveOffer(offers, priceId, opts)` в `core/offer.ts` —
  expiry-aware обёртка (`findApplicableOffer` → `resolveOffer`, режет
  истёкшее). `PriceGrid` (все 4 call-site) и checkout в `PaywallRoot`
  переведены на неё с `readStart: readBrowserOfferStart`. Теперь скидка в
  карточках модалки и `offerId` на чекауте исчезают синхронно с баннером.

  Семантика «оффер ещё не стартовал» (нет marker'а) сохранена — `resolveOffer`
  трактует такой `duration_minutes`-оффер как perpetual, скидка показывается.

  Не покрыт мелкий кейс «модалка открыта в момент истечения»: `PriceGrid` не
  тикает раз в секунду, скидка доживёт до следующего ре-рендера. Открытие
  пейвола _после_ истечения (основной баг) закрыто полностью.

- 67e0954: Правки модалки пейвола и формулировок success-экрана.

  **1. Скролл для self-contained статус-вью.** Диалог модалки ограничен по высоте
  (`max-h … overflow-hidden`), а скролл-зону (`flex-1 min-h-0 overflow-y-auto`)
  настраивали только `Renderer`/`AuthGate`/`SupportGate`. Простые статус-вью
  (`PurchaseSuccessView`, `LoadingView`, `ErrorView`, `AwaitingPaymentView`,
  `PopupBlockedView`) рендерились без обёртки и при нехватке высоты (маленькие
  экраны, extension-попап ~600px) обрезались без возможности проскроллить.
  Добавлен общий `Scroll`-враппер для этих вью; `Renderer`/`AuthGate`/`SupportGate`
  не оборачиваются — у них свой scroll + закреплённый футер.

  **2. Горизонтальные отступы у `PurchaseSuccessView`.** У корня вью были только
  вертикальные отступы, а кнопка `Continue` — `w-full`, из-за чего она
  растягивалась до краёв диалога, а её glow/shimmer вылезали за край. Добавлен
  `px-6 sm:px-8` — как у соседних вью.

  **3. Нейтральные формулировки success/restored.** «Your subscription is now
  active.» / «Subscription restored» некорректны для lifetime-покупок (это не
  подписка). Success-сабтайтл → «You're all set — enjoy!», restored-заголовок →
  «Welcome back», restored-сабтайтл → тот же «You're all set — enjoy!». Обновлён
  EN-эталон, inline-fallback'и и все 27 локалей (`tools/sdk-translations.mjs` +
  регенерация `gen-locales.mjs`).

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

  - `PaywallRoot`: анон-сессия больше не блокирует кнопку «Restore Purchases» и preauth-checkout (трактуется как «нет логина» в обоих местах, консистентно с `CurrentSession`/`AuthPanel`)
  - `PaywallRoot`: X-крестик возвращается на standalone `openAuth()` — без Back-стрелки модалку было нельзя закрыть кроме ESC
  - `PaywallRoot`: `useLayoutEffect` вместо `useEffect` для синхронизации gate-state на `open/initialView` — фиксит flash layout'а тарифов при повторном `openAuth()` (заметно в extension-popup'е из-за RemoteAuth/RemoteBilling RTT)
  - `RemoteAuthClient`: реализован `getLastLogin()` (был не зеркалирован, AuthPanel падал с `r.getLastLogin is not a function` в console попапа)
  - `AuthPanel`: defensive guard на `getLastLogin` — старые билды sdk-extension'а / кастомные AuthClient'ы не валят signin-форму
  - Compile-time tests: `RemoteAuthClient.test-d.ts` и `RemoteBillingClient.test-d.ts` ловят расхождения proxy-классов с базовыми ещё на `tsc --noEmit`

- 0605621: Версия SDK инжектится из package.json при сборке, а не хардкодится.

  `SDK_VERSION` торчал захардкоженным литералом `'3.0.0-alpha.0'` через все
  релизы (alpha.x → beta.x) — его ни разу не подняли. Он уходит в `X-SDK-Version`
  на всех запросах, в `sdk_version` каждого события аналитики (ClickHouse) и в
  ApiGateway, поэтому вся аналитика по версиям была слепой: события всех релизов
  писались как одна версия.

  Теперь версия прокидывается из package.json через vite `define`
  (`__SDK_VERSION__`) — в бандле строковый литерал, в `.d.ts` остаётся
  `const SDK_VERSION: string`. `define` продублирован в vitest.config (он не
  наследует vite.config), иначе токен не замещался бы в тестах.

- 3d325f9: Два фикса в модалке пейвола.

  **1. `PurchaseSuccessView` — типографика/CTA по канону.** Success-вью
  («Payment received» / «Subscription restored») выбивался из остального
  пейвола: мелкий `text-lg` заголовок, `text-sm`/`gray-500` подзаголовок и
  компактная inline-кнопка со своим градиентом. Приведён к канону `reset_sent`
  (AuthPanel): `text-3xl font-bold` заголовок, `text-base`/`gray-600`
  подзаголовок, full-width `pw-cta-shimmer` кнопка. Тексты и i18n-ключи не
  тронуты, `id="pw-title"` (aria-labelledby модалки) сохранён.

  **2. Аналитика `paywall_opened`/`paywall_viewed`/`paywall_closed` —
  гейт на реальный пейвол.** Эти события висели на публичных `'open'`/`'ready'`/
  `'close'`, которые эмитятся для **любого** view. Поэтому открытие support
  (`openSupport`), standalone-auth и re-mount `awaiting_payment`/`popup_blocked`
  после headless-checkout слали ложный `paywall_opened` (и `paywall_viewed`/
  `paywall_closed`) на `/events`. Добавлен `lastMountedView` (ставится в
  `mountAndShow`), аналитика этих трёх событий теперь шлётся только при
  `view === 'layout'`. Публичные `'open'`/`'ready'`/`'close'` события не
  изменены — хосты получают их для всех view как раньше; гейтится только
  отправка аналитики на сервер.

## 3.0.0-beta.13

### Patch Changes

- Server-SDK: ручное зачисление/списание токенов — `BillingClient.creditTokens()` / `debitTokens()`.

  apiKey-only методы правят токен-баланс юзера токенизированного пейвола от лица
  бэкенда мерчанта (identity по email/userId). `creditTokens` добавляет, `debitTokens`
  вычитает и бросает `PaywallError('insufficient')`, если ушло бы ниже нуля.
  Из браузера недоступны (нет apiKey → `apikey_required`) — клиент не должен мочь
  начислить себе токены. Возвращают `{ type, count }` с новым балансом.

  Требует парного деплоя: online-эндпоинт `POST /api/v1/paywall/[id]/balances` +
  применение SQL-миграции `adjust_paywall_balance` (атомарная дельта в JSONB, без
  lost-update от параллельных списаний api-gateway'я). Daily-триал балансы выше
  лимита не перезатирает.

## 3.0.0-beta.12

### Patch Changes

- Auth: `AuthUser` теперь несёт профиль из OAuth-провайдера — `name` и `avatar`.

  Раньше SDK отдавал только `{ id, email, country, is_anonymous }`, а аватар (Google
  кладёт его в `user_metadata.avatar_url`) нигде наружу не пробрасывался. Добавлены
  опциональные `name` / `avatar` в `AuthUser` — заполняются из OAuth-профиля при
  `/oauth/exchange` и доступны из сессии (`auth.getCachedUser()?.avatar`,
  `onAuthChange`) без доп. запроса. У email/anon-юзеров — `null` (аватара нет).

  Требует парного деплоя online (`/oauth/exchange` теперь кладёт `name`/`avatar` из
  `user_metadata`). Без него поля будут `undefined` — не ломает существующее.

## 3.0.0-beta.11

### Patch Changes

- UI: бейдж последнего метода входа возле OAuth-кнопок — «Last» → «Last used» (понятнее, что это «последний использованный метод»).

  Переименовано в canonical EN, inline-фоллбэках `AuthPanel` и во всех 27 локалях
  (`auth.last_used` / `auth.last_used_no_email`): EN `Last used · {email}`, RU
  `Последний вход · …`, DE `Zuletzt genutzt`, ES `Última vez`, JA `前回使用` и т.д.
  Заодно закрыт пробел в покрытии — раньше `auth.last_used` (с email) был переведён
  лишь частично и часть локалей падала на английский inline-фоллбэк.

## 3.0.0-beta.10

### Patch Changes

- OAuth identity-already-linked: классификация по описанию ошибки — устойчивость к version skew callback↔SDK.

  В проде выяснилось, что hosted OAuth-callback может форвардить только
  человекочитаемый `error_description` («Identity is already linked to another
  user»), но НЕ машинный `error_code` (страница callback'а деплоится независимо от
  npm-SDK; старый/закешированный билд не прокидывает `error_code`). beta.9
  классифицировал switch-account только по `errorCode`, поэтому
  `identity_already_exists` прилетал как generic `oauth_failed` → «Sign-in failed»
  без кнопки.

  - `isIdentityAlreadyLinked()` теперь матчит и `errorCode === 'identity_already_exists'`,
    и текст ошибки (`already linked` / `identity_already_exists`) как fallback —
    кнопка «sign in with that account» показывается независимо от того, форвардит
    ли развёрнутый callback `error_code`.

## 3.0.0-beta.9

### Patch Changes

- OAuth `identity_already_exists`: надёжный one-click «switch account» вместо бесшовного popup-reuse.

  beta.8 пытался бесшовно переключить аккаунт, переиспользуя тот же popup
  (`popup.location.replace`). В реальном окружении это нестабильно: COOP (Google)
  обрывает хэндл opener↔popup, а второй обмен в том же флоу добавлял точку отказа —
  в итоге всплывал generic «Sign-in failed» вместо switch-ветки.

  - Убрали popup-reuse. `identity_already_exists` сразу пробрасывается как
    `oauth_identity_already_linked`, и `AuthPanel` показывает понятный текст +
    кнопку «Continue with <provider>». Свежий клик → `signInWithOAuth({ switchAccount: true })`
    → чистый signin (новый popup, новый PKCE-обмен) в аккаунт, которому принадлежит
    identity. Паритет с legacy-веткой `switch_account`.
  - `AuthPanel` логирует реальный код/описание OAuth-ошибки в `console.warn` —
    раньше generic-фоллбэк прятал причину.
  - Убран неиспользуемый `reuseState` из `startOAuthFlow` и `auth.oauthStart`.

## 3.0.0-beta.8

### Patch Changes

- OAuth: авто-переключение на существующий аккаунт при `identity_already_exists` + понятный UX коллизии email.

  Раньше вход через Google/Apple под анонимной сессией шёл через `linkIdentity`, и если
  провайдер уже привязан к другому аккаунту, GoTrue возвращал `identity_already_exists`,
  а SDK показывал глухое «Sign-in failed».

  - `signInWithOAuth` ловит `identity_already_exists` и бесшовно переключается на обычный
    signin, **переиспользуя тот же popup** (`popup.location.replace` на signin-флоу с тем же
    state; SSO провайдера уже активна → почти мгновенно). Добавлены `switchAccount` в
    `signInWithOAuth`/`startOAuthFlow` (не шлёт Bearer → без linkIdentity) и `waitForOAuthResult`
    (структурный исход с `errorCode`, не закрывает popup сам). Если popup переиспользовать
    нельзя (COOP оборвал handle) — фоллбэк-кнопка «войти в тот аккаунт» (свежий user-gesture).
    Зеркально реализовано в `sdk-extension` split-flow (`auth.oauthStart` получил
    `switchAccount`/`reuseState`).
  - Email-коллизия: GoTrue из-за анти-энумерации маскирует занятый email (в т.ч. OAuth-only)
    под «подтвердите почту». `signUp` теперь возвращает `already_registered`, а `AuthPanel`
    уводит юзера на форму входа с понятной подсказкой вместо тупика «проверьте почту».
  - Новые i18n-ключи `auth.email_already_registered` / `auth.identity_already_linked`
    (canonical EN + 27 локалей).

  Требует парного деплоя online-части (v3 OAuth callback теперь прокидывает `error_code` и
  не закрывает popup на `identity_already_exists`; `/auth/email/signup` отдаёт
  `already_registered`). Старый SDK с новым callback и новый SDK со старым callback
  деградируют корректно — без бесконечных popup'ов.

## 3.0.0-beta.7

### Patch Changes

- Фикс зависания awaiting-экрана после оплаты в extension-странице.

  Переход awaiting→success был завязан **исключительно** на `UserWatcher.onActive`,
  а сам watcher не запускался для всего `chrome-extension://` протокола
  (`shouldRunUserWatcher` считал любой такой контекст эфемерным action-popup'ом).
  В полноценной extension-странице (side panel / отдельная вкладка), которая
  переживает checkout, поллер был выключен, и закрыть awaiting было некому — даже
  ручная кнопка «я оплатил» лишь слала `window.postMessage` для пробуждения
  несуществующего watcher'а. Покупка проходила, `/user-state` отдавал
  `has_active_subscription: true`, а экран висел.

  - Переход централизован в идемпотентный `handlePurchaseDetected`, который
    вызывается из `billing.onUserChange` — любой источник свежего active
    user-state (ручной `getUser`, cross-context broadcast, watcher) закрывает
    awaiting. Гейт на checkout-вью (`awaiting_payment`/`popup_blocked`), чтобы
    открытие пейвола уже-подписанному юзеру не давало ложного срабатывания.
  - `shouldRunUserWatcher` больше не режет `chrome-extension://` — переживающая
    страница и может, и должна поллить; эфемерный action-popup безвредно
    тёрдаунится вместе с контекстом (детект там покрывает bootstrap при
    следующем открытии).

## 3.0.0-beta.6

### Patch Changes

- Версия SDK инжектится из package.json при сборке, а не хардкодится.

  `SDK_VERSION` торчал захардкоженным литералом `'3.0.0-alpha.0'` через все
  релизы (alpha.x → beta.x) — его ни разу не подняли. Он уходит в `X-SDK-Version`
  на всех запросах, в `sdk_version` каждого события аналитики (ClickHouse) и в
  ApiGateway, поэтому вся аналитика по версиям была слепой: события всех релизов
  писались как одна версия.

  Теперь версия прокидывается из package.json через vite `define`
  (`__SDK_VERSION__`) — в бандле строковый литерал, в `.d.ts` остаётся
  `const SDK_VERSION: string`. `define` продублирован в vitest.config (он не
  наследует vite.config), иначе токен не замещался бы в тестах.

## 3.0.0-beta.5

### Patch Changes

- Фикс расходящихся фокуса и выбора при открытии пейвола.

  При авто-открытии модалки (без предшествующего user-gesture) браузерная
  эвристика `:focus-visible` рисовала кольцо на первом фокусируемом контроле — а
  первый `button` в DOM это первая карточка тарифа (напр. месячный), тогда как
  _выбран_ популярный план (`popular_price_id`), у которого акцентная рамка.
  Кольцо фокуса оказывалось на одной карточке, выделение выбора — на другой; два
  конфликтующих «активных» состояния сбивали с толку.

  `Modal` больше не наводит фокус на первый интерактивный элемент — фокус уходит
  на сам контейнер диалога (`tabIndex=-1`, `outline-none` → кольца нет). Ловушка
  фокуса сохраняет якорь внутри диалога, `Tab` обходит контролы как раньше, для
  скринридеров фокус на `aria-modal`-диалоге корректен. Добавлен явный опт-ин
  `[data-pw-autofocus]` для вью, которым нужен автофокус инпута.

## 3.0.0-beta.4

### Patch Changes

- Правки модалки пейвола и формулировок success-экрана.

  **1. Скролл для self-contained статус-вью.** Диалог модалки ограничен по высоте
  (`max-h … overflow-hidden`), а скролл-зону (`flex-1 min-h-0 overflow-y-auto`)
  настраивали только `Renderer`/`AuthGate`/`SupportGate`. Простые статус-вью
  (`PurchaseSuccessView`, `LoadingView`, `ErrorView`, `AwaitingPaymentView`,
  `PopupBlockedView`) рендерились без обёртки и при нехватке высоты (маленькие
  экраны, extension-попап ~600px) обрезались без возможности проскроллить.
  Добавлен общий `Scroll`-враппер для этих вью; `Renderer`/`AuthGate`/`SupportGate`
  не оборачиваются — у них свой scroll + закреплённый футер.

  **2. Горизонтальные отступы у `PurchaseSuccessView`.** У корня вью были только
  вертикальные отступы, а кнопка `Continue` — `w-full`, из-за чего она
  растягивалась до краёв диалога, а её glow/shimmer вылезали за край. Добавлен
  `px-6 sm:px-8` — как у соседних вью.

  **3. Нейтральные формулировки success/restored.** «Your subscription is now
  active.» / «Subscription restored» некорректны для lifetime-покупок (это не
  подписка). Success-сабтайтл → «You're all set — enjoy!», restored-заголовок →
  «Welcome back», restored-сабтайтл → тот же «You're all set — enjoy!». Обновлён
  EN-эталон, inline-fallback'и и все 27 локалей (`tools/sdk-translations.mjs` +
  регенерация `gen-locales.mjs`).

## 3.0.0-beta.3

### Patch Changes

- a6b7a3a: Убрано аналитическое событие `paywall_opened`. Теперь показ пейвола фиксирует
  единственный сигнал — `paywall_viewed` (эмитится на `'ready'`, после загрузки
  bootstrap, с `prices_count`/`offers_count`/`is_test_mode`). `'open'` больше не
  трекается отдельно ни в основном SDK, ни в extension-канале.

  Мотивация: `opened` и `viewed` дублировали друг друга в доминирующем паттерне
  (тёплый bootstrap → оба события в одном батче), а лишнее событие на каждое
  открытие умножало POST-нагрузку на `/events` и строки в `paywall_sdk_events`
  при прод-масштабе (тысячи одновременных открытий). Воронка строится от
  `viewed`. Сервер (`online`) больше не принимает `paywall_opened` в whitelist.

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

- Signup email-confirm: переход на link-флоу (как recovery) вместо dead-end
  экрана ввода кода.

  Прод email-шаблон «Confirm signup» шлёт confirmation-**ссылку** (redirect_to →
  `/paywall/v3/auth/confirm`), а не 6-значный код. Модалка же после signUp →
  `confirmation_required` показывала экран `signup_verify` с инпутом кода —
  юзер упирался в тупик: код вводить просят, но в письме его нет.

  Теперь после signUp показывается экран `signup_sent` («проверьте email →
  кликните ссылку», зеркало `reset_sent`). Подтверждение завершается на
  v3-странице, сессия синкается cross-tab → auth-гейт продвигается сам, как при
  обычном signin. Симметрично recovery-флоу (forgot → reset_sent).

  Удалён режим `signup_verify` и его OTP-ветка; добавлен ключ
  `auth.signup_sent_subtitle` (canonical-en + 27 локалей).

## 3.0.0-alpha.22

### Patch Changes

- Два фикса в модалке пейвола.

  **1. `PurchaseSuccessView` — типографика/CTA по канону.** Success-вью
  («Payment received» / «Subscription restored») выбивался из остального
  пейвола: мелкий `text-lg` заголовок, `text-sm`/`gray-500` подзаголовок и
  компактная inline-кнопка со своим градиентом. Приведён к канону `reset_sent`
  (AuthPanel): `text-3xl font-bold` заголовок, `text-base`/`gray-600`
  подзаголовок, full-width `pw-cta-shimmer` кнопка. Тексты и i18n-ключи не
  тронуты, `id="pw-title"` (aria-labelledby модалки) сохранён.

  **2. Аналитика `paywall_opened`/`paywall_viewed`/`paywall_closed` —
  гейт на реальный пейвол.** Эти события висели на публичных `'open'`/`'ready'`/
  `'close'`, которые эмитятся для **любого** view. Поэтому открытие support
  (`openSupport`), standalone-auth и re-mount `awaiting_payment`/`popup_blocked`
  после headless-checkout слали ложный `paywall_opened` (и `paywall_viewed`/
  `paywall_closed`) на `/events`. Добавлен `lastMountedView` (ставится в
  `mountAndShow`), аналитика этих трёх событий теперь шлётся только при
  `view === 'layout'`. Публичные `'open'`/`'ready'`/`'close'` события не
  изменены — хосты получают их для всех view как раньше; гейтится только
  отправка аналитики на сервер.

## 3.0.0-alpha.21

### Patch Changes

- Fix: просроченный offer переставал давать скидку в countdown-баннере, но
  оставался в ценах внутри модалки и улетал в checkout.

  `PriceGrid` (strike-through / `-X%` в карточках модалки) и checkout-путь в
  `PaywallRoot` резолвили offer через сырой `findApplicableOffer`, который
  фильтрует только по `price_id` + `discount_percent > 0` и **срок не
  смотрит**. Хост-прайсинг (`usePaywallOffer` → `getOfferForPrice` →
  `resolveOffer`) и countdown-баннер (`useOfferCountdown`) при этом expiry
  учитывают. Итог — рассинхрон: оффер истёк, баннер скрыт и в хост-карточках
  скидки нет, а в карточках модалки скидка со strike-through ещё висит.

  Второй, более неприятный side-эффект — checkout. Для `duration_minutes`
  офферов нет server-side таймера, бэк доверяет переданному `offerId`. Сырой
  `findApplicableOffer` слал id просроченного оффера в `createCheckout` → бэк
  применял бы скидку, которой в UI уже не видно.

  Фикс: новый `findLiveOffer(offers, priceId, opts)` в `core/offer.ts` —
  expiry-aware обёртка (`findApplicableOffer` → `resolveOffer`, режет
  истёкшее). `PriceGrid` (все 4 call-site) и checkout в `PaywallRoot`
  переведены на неё с `readStart: readBrowserOfferStart`. Теперь скидка в
  карточках модалки и `offerId` на чекауте исчезают синхронно с баннером.

  Семантика «оффер ещё не стартовал» (нет marker'а) сохранена — `resolveOffer`
  трактует такой `duration_minutes`-оффер как perpetual, скидка показывается.

  Не покрыт мелкий кейс «модалка открыта в момент истечения»: `PriceGrid` не
  тикает раз в секунду, скидка доживёт до следующего ре-рендера. Открытие
  пейвола _после_ истечения (основной баг) закрыто полностью.

## 3.0.0-alpha.20

### Patch Changes

- `OfferBanner` — fix offer-farming через re-open пейвола.

  `useOfferCountdown` при `expired === true` удалял ключ
  `pw-offer-<id>-start` из localStorage, считая это безопасным cleanup'ом.
  Но именно этот ключ — единственный forever-marker «этот offer уже
  стартовал для юзера». Без него `resolveEndMs` при следующем открытии
  пейвола записывал свежий `start` (= `Date.now()`) и countdown начинался
  заново — несмотря на то что offer уже давно истёк.

  Сценарий, который ловит юзер:

  1. Видит offer → таймер запущен, ключ сохранён.
  2. Логинится, открывает checkout, закрывает без оплаты.
  3. Закрывает пейвол → таймер тикает в фоне → истекает → `removeItem`.
  4. Открывает пейвол снова → offer показывает полную `duration_minutes`.

  Фикс: на expiry останавливаем `setInterval`, но ключ из storage НЕ
  удаляем. При следующем resolve `start + duration < now` → банер
  скрывается через стандартный `timeLeft.expired` guard. Юзер физически
  не может «фармить» offer повторными открытиями.

  Side-effect: localStorage накапливает по одному ~50-байтовому ключу на
  каждый когда-либо стартовавший offer. Допустимая цена за корректность.

## 3.0.0-alpha.19

### Patch Changes

- i18n — переводы для нового `reset_sent` view.

  Добавлены три ключа в `sdk-translations.mjs` и сгенерированы во все 27
  локалей через `tools/gen-locales.mjs`:

  - `auth.reset_sent_subtitle` — пояснение под title'ом «Check your email».
  - `auth.reset_link_valid` — подсказка «The link is valid for 1 hour.».
  - `auth.back_to_login` — лейбл primary-кнопки.

  До этого релиза эти строки рендерились через английский inline-fallback
  из `t()`-вызова — title локализовался, остальное оставалось на английском.

## 3.0.0-alpha.18

### Patch Changes

- `AuthPanel` — нативный «Check your email» экран после запроса password reset.

  Раньше после отправки reset-письма в `auth_panel` показывался серый
  info-баннер с текстом и стандартный заголовок формы — выглядело как
  техническое уведомление, а не подтверждение действия. Теперь
  `reset_sent` это отдельный success-view: зелёный круг с галочкой
  (та же визуальная палитра, что у success-state в `PaywallRoot`),
  крупный title «Check your email», поясняющий сабтайтл, email юзера
  жирным и подсказка про срок действия ссылки. Снизу — large primary
  кнопка «Back to Login» в брендовом accent-цвете.

  Новые i18n-ключи (с английским fallback'ом inline):

  - `auth.reset_sent_subtitle` — «We sent a password reset link. Follow
    the instructions in the email to reset your password.»
  - `auth.reset_link_valid` — «The link is valid for 1 hour.»
  - `auth.back_to_login` — «Back to Login»

  Старый `setInfo(...)` и серый info-баннер для `reset_sent` убраны —
  текст теперь живёт в самом view.

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
