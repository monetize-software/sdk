---
'@monetize.software/sdk': patch
'@monetize.software/sdk-extension': patch
'@monetize.software/sdk-react': patch
---

Auth: `AuthUser` теперь несёт профиль из OAuth-провайдера — `name` и `avatar`.

Раньше SDK отдавал только `{ id, email, country, is_anonymous }`, а аватар (Google
кладёт его в `user_metadata.avatar_url`) нигде наружу не пробрасывался. Добавлены
опциональные `name` / `avatar` в `AuthUser` — заполняются из OAuth-профиля при
`/oauth/exchange` и доступны из сессии (`auth.getCachedUser()?.avatar`,
`onAuthChange`) без доп. запроса. У email/anon-юзеров — `null` (аватара нет).

Требует парного деплоя online (`/oauth/exchange` теперь кладёт `name`/`avatar` из
`user_metadata`). Без него поля будут `undefined` — не ломает существующее.
