---
'@monetize.software/sdk': patch
---

Два фикса в модалке пейвола.

**1. `PurchaseSuccessView` — типографика/CTA по канону.** Success-вью
(«Payment received» / «Subscription restored») выбивался из остального
пейвола: мелкий `text-lg` заголовок, `text-sm`/`gray-500` подзаголовок и
компактная inline-кнопка со своим градиентом. Приведён к канону `reset_sent`
(AuthPanel): `text-3xl font-bold` заголовок, `text-base`/`gray-600`
подзаголовок, full-width `pw-cta-shimmer` кнопка. Тексты и i18n-ключи не
тронуты, `id="pw-title"` (aria-labelledby модалки) сохранён.

**2. Аналитика `paywall_opened`/`paywall_viewed`/`paywall_closed` —
гейт на реальный пейвол.** Эти события висели на публичных `'open'`/`'ready'`/
`'close'`, которые эмитятся для **любого** view. Поэтому открытие support
(`openSupport`), standalone-auth и re-mount `awaiting_payment`/`popup_blocked`
после headless-checkout слали ложный `paywall_opened` (и `paywall_viewed`/
`paywall_closed`) на `/events`. Добавлен `lastMountedView` (ставится в
`mountAndShow`), аналитика этих трёх событий теперь шлётся только при
`view === 'layout'`. Публичные `'open'`/`'ready'`/`'close'` события не
изменены — хосты получают их для всех view как раньше; гейтится только
отправка аналитики на сервер.
