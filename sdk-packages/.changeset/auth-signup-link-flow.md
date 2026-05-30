---
'@monetize.software/sdk': patch
---

Signup email-confirm: переход на link-флоу (как recovery) вместо dead-end
экрана ввода кода.

Прод email-шаблон «Confirm signup» шлёт confirmation-**ссылку** (redirect_to →
`/paywall/v3/auth/confirm`), а не 6-значный код. Модалка же после signUp →
`confirmation_required` показывала экран `signup_verify` с инпутом кода —
юзер упирался в тупик: код вводить просят, но в письме его нет.

Теперь после signUp показывается экран `signup_sent` («проверьте email →
кликните ссылку», зеркало `reset_sent`). Подтверждение завершается на
v3-странице, сессия синкается cross-tab → auth-гейт продвигается сам, как при
обычном signin. Симметрично recovery-флоу (forgot → reset_sent).

Удалён режим `signup_verify` и его OTP-ветка; добавлен ключ
`auth.signup_sent_subtitle` (canonical-en + 27 локалей).
