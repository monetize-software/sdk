---
'@monetize.software/sdk': patch
---

`AuthPanel` — нативный «Check your email» экран после запроса password reset.

Раньше после отправки reset-письма в `auth_panel` показывался серый
info-баннер с текстом и стандартный заголовок формы — выглядело как
техническое уведомление, а не подтверждение действия. Теперь
`reset_sent` это отдельный success-view: зелёный круг с галочкой
(та же визуальная палитра, что у success-state в `PaywallRoot`),
крупный title «Check your email», поясняющий сабтайтл, email юзера
жирным и подсказка про срок действия ссылки. Снизу — large primary
кнопка «Back to Login» в брендовом accent-цвете.

Новые i18n-ключи (с английским fallback'ом inline):

- `auth.reset_sent_subtitle` — «We sent a password reset link. Follow
  the instructions in the email to reset your password.»
- `auth.reset_link_valid` — «The link is valid for 1 hour.»
- `auth.back_to_login` — «Back to Login»

Старый `setInfo(...)` и серый info-баннер для `reset_sent` убраны —
текст теперь живёт в самом view.
