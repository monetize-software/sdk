---
'@monetize.software/sdk': minor
---

i18n force-locale + structured auth errors + price grid polish

- **`PaywallUI.locale` option + `PaywallUI.setLocale()`**: explicit-override языка для I18nProvider, минующий navigator.language и owner-translations check. Нужен live-preview редактору админки («Preview as user from <country>») — там browser-locale всегда EN. `setLocale(null)` возвращает автоматическую резолв-логику; live-обновление через `handle.update`. Помечено `@internal` — конечным интеграторам форсить язык не нужно.
- **AuthPanel: structured error mapping**. Раньше `err.message` показывал сырой HTTP statusText ("Unauthorized", "Bad Request") — англоязычный и нелокализованный. Теперь `authErrorMessage()` маппит стабильные `err.code` (`invalid_credentials`, `email_not_confirmed`, `email_exists`, `weak_password`, `invalid_otp`, `rate_limited`, `network_error`, `service_unavailable`, …) на i18n-ключи `auth.*`. Для непонятных кодов — generic fallback `auth.signin_failed`/`auth.signup_failed`. 8 новых i18n-ключей, переводы на все 27 bundled locales.
- **PriceGrid: compact view as card**. Compact-режим теперь wrap'ит строки в `rounded-xl border bg-gray-50` — зеркало legacy `PaywallPricing` wrapper'а для non-default view. Отделяет блок цен от остального layout'а.
- **PriceGrid: smart strike-row reservation**. Горизонтальный view резервирует 22px высоту под "strike-through originalAmount + discount-pill" у ВСЕХ карточек только если хоть одна цена в гриде имеет скидку. Если оффера нет ни у одной — row не рендерится, не остаётся 22px пустоты под label'ом.
- **PriceGrid: убран `trial_days` хинт** под main amount (компактнее layout, trial-info остаётся в CtaButton).
- **TokenizationGate: lifetime copy**. Для `interval === 'lifetime'` (или отсутствующего) рендерится новый ключ `pricing.included_total` ("Included for lifetime:") вместо `pricing.included_per` ("Included per {interval}:").
- **Renderer.hasTopBanner**: prop для уменьшения top-padding scrollable-зоны когда над dialog'ом рендерится OfferTopBanner.
- **i18n cleanup**: `auth.check_email_title` теперь короткий нейтральный заголовок ("Check your email") — legacy-перевод длинной фразы про signup-link был некорректен для forgot-password flow.
