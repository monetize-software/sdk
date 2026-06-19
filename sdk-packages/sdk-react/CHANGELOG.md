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

- 5902c36: UI: бейдж последнего метода входа возле OAuth-кнопок — «Last» → «Last used» (понятнее, что это «последний использованный метод»).

  Переименовано в canonical EN, inline-фоллбэках `AuthPanel` и во всех 27 локалях
  (`auth.last_used` / `auth.last_used_no_email`): EN `Last used · {email}`, RU
  `Последний вход · …`, DE `Zuletzt genutzt`, ES `Última vez`, JA `前回使用` и т.д.
  Заодно закрыт пробел в покрытии — раньше `auth.last_used` (с email) был переведён
  лишь частично и часть локалей падала на английский inline-фоллбэк.

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

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.13

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

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.12

## 3.0.0-beta.11

### Patch Changes

- UI: бейдж последнего метода входа возле OAuth-кнопок — «Last» → «Last used» (понятнее, что это «последний использованный метод»).

  Переименовано в canonical EN, inline-фоллбэках `AuthPanel` и во всех 27 локалях
  (`auth.last_used` / `auth.last_used_no_email`): EN `Last used · {email}`, RU
  `Последний вход · …`, DE `Zuletzt genutzt`, ES `Última vez`, JA `前回使用` и т.д.
  Заодно закрыт пробел в покрытии — раньше `auth.last_used` (с email) был переведён
  лишь частично и часть локалей падала на английский inline-фоллбэк.

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.11

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

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.10

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

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.9

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

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.8

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

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.7

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

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.6

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

- Updated dependencies
  - @monetize.software/sdk@3.0.0-beta.5

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
