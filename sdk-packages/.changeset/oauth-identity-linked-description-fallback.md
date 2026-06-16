---
'@monetize.software/sdk': patch
'@monetize.software/sdk-extension': patch
'@monetize.software/sdk-react': patch
---

OAuth identity-already-linked: классификация по описанию ошибки — устойчивость к version skew callback↔SDK.

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
