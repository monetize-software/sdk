---
'@monetize.software/sdk': patch
---

i18n — переводы для нового `reset_sent` view.

Добавлены три ключа в `sdk-translations.mjs` и сгенерированы во все 27
локалей через `tools/gen-locales.mjs`:

- `auth.reset_sent_subtitle` — пояснение под title'ом «Check your email».
- `auth.reset_link_valid` — подсказка «The link is valid for 1 hour.».
- `auth.back_to_login` — лейбл primary-кнопки.

До этого релиза эти строки рендерились через английский inline-fallback
из `t()`-вызова — title локализовался, остальное оставалось на английском.
