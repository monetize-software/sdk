# @monetize.software/sdk-extension

## 3.0.0-alpha.6

### Patch Changes

- Popup bug fixes + UI polish

  - `PaywallRoot`: анон-сессия больше не блокирует кнопку «Restore Purchases» и preauth-checkout (трактуется как «нет логина» в обоих местах, консистентно с `CurrentSession`/`AuthPanel`)
  - `PaywallRoot`: X-крестик возвращается на standalone `openAuth()` — без Back-стрелки модалку было нельзя закрыть кроме ESC
  - `PaywallRoot`: `useLayoutEffect` вместо `useEffect` для синхронизации gate-state на `open/initialView` — фиксит flash layout'а тарифов при повторном `openAuth()` (заметно в extension-popup'е из-за RemoteAuth/RemoteBilling RTT)
  - `RemoteAuthClient`: реализован `getLastLogin()` (был не зеркалирован, AuthPanel падал с `r.getLastLogin is not a function` в console попапа)
  - `AuthPanel`: defensive guard на `getLastLogin` — старые билды sdk-extension'а / кастомные AuthClient'ы не валят signin-форму
  - Compile-time tests: `RemoteAuthClient.test-d.ts` и `RemoteBillingClient.test-d.ts` ловят расхождения proxy-классов с базовыми ещё на `tsc --noEmit`

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
