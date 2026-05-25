# @monetize.software/sdk

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
