# @monetize.software/sdk

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
