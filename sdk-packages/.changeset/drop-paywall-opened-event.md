---
'@monetize.software/sdk': patch
'@monetize.software/sdk-extension': patch
---

Убрано аналитическое событие `paywall_opened`. Теперь показ пейвола фиксирует
единственный сигнал — `paywall_viewed` (эмитится на `'ready'`, после загрузки
bootstrap, с `prices_count`/`offers_count`/`is_test_mode`). `'open'` больше не
трекается отдельно ни в основном SDK, ни в extension-канале.

Мотивация: `opened` и `viewed` дублировали друг друга в доминирующем паттерне
(тёплый bootstrap → оба события в одном батче), а лишнее событие на каждое
открытие умножало POST-нагрузку на `/events` и строки в `paywall_sdk_events`
при прод-масштабе (тысячи одновременных открытий). Воронка строится от
`viewed`. Сервер (`online`) больше не принимает `paywall_opened` в whitelist.
