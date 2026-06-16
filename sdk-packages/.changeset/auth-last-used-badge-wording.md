---
'@monetize.software/sdk': patch
'@monetize.software/sdk-extension': patch
'@monetize.software/sdk-react': patch
---

UI: бейдж последнего метода входа возле OAuth-кнопок — «Last» → «Last used» (понятнее, что это «последний использованный метод»).

Переименовано в canonical EN, inline-фоллбэках `AuthPanel` и во всех 27 локалях
(`auth.last_used` / `auth.last_used_no_email`): EN `Last used · {email}`, RU
`Последний вход · …`, DE `Zuletzt genutzt`, ES `Última vez`, JA `前回使用` и т.д.
Заодно закрыт пробел в покрытии — раньше `auth.last_used` (с email) был переведён
лишь частично и часть локалей падала на английский inline-фоллбэк.
