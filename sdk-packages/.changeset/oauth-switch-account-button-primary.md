---
'@monetize.software/sdk': patch
'@monetize.software/sdk-extension': patch
'@monetize.software/sdk-react': patch
---

OAuth `identity_already_exists`: надёжный one-click «switch account» вместо бесшовного popup-reuse.

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
