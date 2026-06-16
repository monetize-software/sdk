---
'@monetize.software/sdk': patch
'@monetize.software/sdk-extension': patch
'@monetize.software/sdk-react': patch
---

OAuth: авто-переключение на существующий аккаунт при `identity_already_exists` + понятный UX коллизии email.

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
