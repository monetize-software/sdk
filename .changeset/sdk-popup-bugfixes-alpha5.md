---
"@monetize.software/sdk": patch
"@monetize.software/sdk-extension": patch
---

Popup bug fixes + UI polish

- `PaywallRoot`: анон-сессия больше не блокирует кнопку «Restore Purchases» и preauth-checkout (трактуется как «нет логина» в обоих местах, консистентно с `CurrentSession`/`AuthPanel`)
- `PaywallRoot`: X-крестик возвращается на standalone `openAuth()` — без Back-стрелки модалку было нельзя закрыть кроме ESC
- `PaywallRoot`: `useLayoutEffect` вместо `useEffect` для синхронизации gate-state на `open/initialView` — фиксит flash layout'а тарифов при повторном `openAuth()` (заметно в extension-popup'е из-за RemoteAuth/RemoteBilling RTT)
- `RemoteAuthClient`: реализован `getLastLogin()` (был не зеркалирован, AuthPanel падал с `r.getLastLogin is not a function` в console попапа)
- `AuthPanel`: defensive guard на `getLastLogin` — старые билды sdk-extension'а / кастомные AuthClient'ы не валят signin-форму
- Compile-time tests: `RemoteAuthClient.test-d.ts` и `RemoteBillingClient.test-d.ts` ловят расхождения proxy-классов с базовыми ещё на `tsc --noEmit`
