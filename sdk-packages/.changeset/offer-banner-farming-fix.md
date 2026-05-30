---
'@monetize.software/sdk': patch
---

`OfferBanner` — fix offer-farming через re-open пейвола.

`useOfferCountdown` при `expired === true` удалял ключ
`pw-offer-<id>-start` из localStorage, считая это безопасным cleanup'ом.
Но именно этот ключ — единственный forever-marker «этот offer уже
стартовал для юзера». Без него `resolveEndMs` при следующем открытии
пейвола записывал свежий `start` (= `Date.now()`) и countdown начинался
заново — несмотря на то что offer уже давно истёк.

Сценарий, который ловит юзер:
1. Видит offer → таймер запущен, ключ сохранён.
2. Логинится, открывает checkout, закрывает без оплаты.
3. Закрывает пейвол → таймер тикает в фоне → истекает → `removeItem`.
4. Открывает пейвол снова → offer показывает полную `duration_minutes`.

Фикс: на expiry останавливаем `setInterval`, но ключ из storage НЕ
удаляем. При следующем resolve `start + duration < now` → банер
скрывается через стандартный `timeLeft.expired` guard. Юзер физически
не может «фармить» offer повторными открытиями.

Side-effect: localStorage накапливает по одному ~50-байтовому ключу на
каждый когда-либо стартовавший offer. Допустимая цена за корректность.
