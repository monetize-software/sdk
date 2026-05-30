---
'@monetize.software/sdk': patch
---

Fix: просроченный offer переставал давать скидку в countdown-баннере, но
оставался в ценах внутри модалки и улетал в checkout.

`PriceGrid` (strike-through / `-X%` в карточках модалки) и checkout-путь в
`PaywallRoot` резолвили offer через сырой `findApplicableOffer`, который
фильтрует только по `price_id` + `discount_percent > 0` и **срок не
смотрит**. Хост-прайсинг (`usePaywallOffer` → `getOfferForPrice` →
`resolveOffer`) и countdown-баннер (`useOfferCountdown`) при этом expiry
учитывают. Итог — рассинхрон: оффер истёк, баннер скрыт и в хост-карточках
скидки нет, а в карточках модалки скидка со strike-through ещё висит.

Второй, более неприятный side-эффект — checkout. Для `duration_minutes`
офферов нет server-side таймера, бэк доверяет переданному `offerId`. Сырой
`findApplicableOffer` слал id просроченного оффера в `createCheckout` → бэк
применял бы скидку, которой в UI уже не видно.

Фикс: новый `findLiveOffer(offers, priceId, opts)` в `core/offer.ts` —
expiry-aware обёртка (`findApplicableOffer` → `resolveOffer`, режет
истёкшее). `PriceGrid` (все 4 call-site) и checkout в `PaywallRoot`
переведены на неё с `readStart: readBrowserOfferStart`. Теперь скидка в
карточках модалки и `offerId` на чекауте исчезают синхронно с баннером.

Семантика «оффер ещё не стартовал» (нет marker'а) сохранена — `resolveOffer`
трактует такой `duration_minutes`-оффер как perpetual, скидка показывается.

Не покрыт мелкий кейс «модалка открыта в момент истечения»: `PriceGrid` не
тикает раз в секунду, скидка доживёт до следующего ре-рендера. Открытие
пейвола *после* истечения (основной баг) закрыто полностью.
