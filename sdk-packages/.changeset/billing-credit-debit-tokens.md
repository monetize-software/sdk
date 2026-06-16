---
'@monetize.software/sdk': patch
'@monetize.software/sdk-extension': patch
'@monetize.software/sdk-react': patch
---

Server-SDK: ручное зачисление/списание токенов — `BillingClient.creditTokens()` / `debitTokens()`.

apiKey-only методы правят токен-баланс юзера токенизированного пейвола от лица
бэкенда мерчанта (identity по email/userId). `creditTokens` добавляет, `debitTokens`
вычитает и бросает `PaywallError('insufficient')`, если ушло бы ниже нуля.
Из браузера недоступны (нет apiKey → `apikey_required`) — клиент не должен мочь
начислить себе токены. Возвращают `{ type, count }` с новым балансом.

Требует парного деплоя: online-эндпоинт `POST /api/v1/paywall/[id]/balances` +
применение SQL-миграции `adjust_paywall_balance` (атомарная дельта в JSONB, без
lost-update от параллельных списаний api-gateway'я). Daily-триал балансы выше
лимита не перезатирает.
