# SDK 3.0 — план ухода от iframe

Выжимка из обсуждения 2026-04-24. Цель — новый SDK на remote config + native render, чтобы убрать iframe-инъекцию (Chrome Web Store часто придирается к ней при модерации расширений).

## Зачем

- CWS модерация часто блокирует расширения из-за iframe от appbox.space (в MV3 это воспринимается как remote code execution).
- Удобная установка (npm) вместо «скачай скрипт и вставь».
- Меньше bundle-веса для hybrid-клиентов, у которых уже есть свой auth.

**Главное "узнать до старта":** какая конкретно претензия у CWS — именно iframe или remote-code в целом? От ответа зависит, хватит ли native-рендера из `appbox.space` или нужен именно npm-bundle внутри расширения клиента. Можно: (а) попросить у клиента конкретное rejection-письмо, (б) выложить минимальный PoC-extension в CWS на ревью.

## Архитектура SDK 3.0

### Отдельный репозиторий

- **Не «клон online»**, а npm-библиотека. Build через `tsup` или Vite lib mode, не Next.js.
- Стек: Preact/React + Tailwind в shadow DOM (или CSS-in-JS с scoped styles) + Vitest + Playwright.
- Ноль SSR-кода.
- Отдельный CI с bundle-size gate.
- Shared-код с `online` на старте — через codegen + копирование (Supabase types, константы). Монорепо — через 2-3 месяца, когда SDK устаканится.

### API SDK — одно измерение, не три

Вместо режимов `client/hybrid/server` — **наличие identity** определяет всё:

```ts
// client: managed auth (SDK сам логинит через Supabase)
const pw = new Paywall({ id: 'abc' });

// hybrid: external auth (хост передаёт identity)
const pw = new Paywall({
  id: 'abc',
  identity: { email: user.email, userId: user.id }
});

// server: identity + no UI (только биллинг)
import { BillingClient } from '@monetize/paywall/core';
const client = new BillingClient({ paywallId, identity: {...} });
await client.createCheckout({ priceId });
```

**Три entrypoint'а в одном репо:**

| Entrypoint | Что внутри | Вес (цель) | Покрывает |
|---|---|---|---|
| `@monetize/paywall/core` | BillingClient, API-wrapper, types, webhooks helper | 5-8KB gzip | server |
| `@monetize/paywall/ui` | PaywallUI (модалка, рендер) | +40-60KB gzip (lazy) | hybrid |
| `@monetize/paywall` | core + ui + auth (Supabase, OAuth, magic-link) | +30KB gzip | client |

Клиент платит в байтах только за то, что использует. `paywall.runtime_mode` в БД остаётся для аналитики и валидации на сервере.

### Способы установки

- **npm** — основной (`@monetize/paywall`).
- **CDN UMD** — `cdn.monetize.software/v3/paywall.min.js` для WordPress / Shopify / no-bundler.
- **Framework adapters** — сначала `@monetize/paywall-react` (Provider + `usePaywall()`), потом Vue/Svelte по спросу.
- **Extension helper** `@monetize/paywall-extension` — готовый storage-адаптер (`chrome.storage.local` для session, `chrome.storage.sync` для visitor_id), рецепт manifest.json, пример background/content-split.
- **Legacy single-file** — оставить как legacy-канал до заката v2.

## Custom domains — переосмысление

В SDK 3.0 кастомные домены **перестают быть обязательными**:

| Кейс | Extension | Site |
|---|---|---|
| Не нужен | ✓ всегда | В базовых кейсах |
| Нужен | никогда | Magic-link UX, strict CSP клиента, брендинг платежа |

Предложение: переименовать в "white-label domain" и продавать как opt-in premium, не как обязательный путь.

## Что править в `online` (бэк остаётся общий для v2 и v3)

- [partial] **CORS whitelist по origin клиента** — таблица `paywall_allowed_origins` создана и замигрирована, [fetchPaywallAllowedOrigins](online/server-cashed-queries/fetchPaywallAllowedOrigins.ts) кешируется тегом `paywall-{id}-origins-v1`, [checkV3Origin](online/utils/cors-v3.ts) подключён в [/bootstrap](online/app/api/v1/paywall/%5Bid%5D/bootstrap/route.ts). Осталось: распространить на `/start-checkout` (там нужен echo Origin + пропуск `X-Api-Key` при Origin в whitelist) и на `/auth/*`, вынести boilerplate в общий хелпер.
- [ ] **Auth через PKCE + Bearer** для cross-origin сценариев. Cookies — только для iframe-пути (legacy).
- [ ] **OAuth callback** ([online/app/paywall/auth/callback](online/app/paywall/auth/callback)) — добавить `postMessage` в `window.opener` как primary path вместо postMessage в iframe. Минимальная правка, ~20 строк.
- [x] **Agregate bootstrap endpoint** `/api/v1/paywall/[id]/bootstrap` — сделано 2026-04-24 в [online/app/api/v1/paywall/[id]/bootstrap/route.ts](online/app/api/v1/paywall/%5Bid%5D/bootstrap/route.ts). Один запрос возвращает `{ settings, prices, offers, layout }` в SDK 3.0 shape. Остаются уточнения ниже:
  - [x] **local prices** — сделано 2026-04-24. Geo-resolve на сервере: `getCountry(req)` по `do-connecting-ip`/`x-forwarded-for` → `COUNTRY_CURRENCY_MAP[country]` → matching запись из `paywall_internal_local_prices` по `local_currency`. Проверено на paywall 65: US → `local: null`, DE → `EUR {2.99, 23.88, 29.99}`, JP → `JPY`.
  - [x] **offers** — сделано 2026-04-24. Нормализация результата RPC `get_active_offers_for_paywall`: `offer_id→id`, `offer_name→label`, `discount_percentage→discount_percent`, `end_date→expires_at`. `price_id: null` — в схеме прямой связи offer→price нет (маппинг через платёжку).
  - [x] **unstable_cache** — сделано 2026-04-24. Route переключён с `*FromDb()` на кешированные обёртки `fetchPaywallSettings`, `fetchPaywallPrices`, `fetchPaywallOffers`.
  - [ ] **currency** — hardcoded `USD` в route, т.к. в `paywall_internal_prices` нет колонки. Решить: добавить колонку `currency` (default USD) или оставить подразумеваемой.
  - [ ] **interval_count** — hardcoded `1`. Если когда-то будут цены "раз в 3 месяца" — нужна колонка.
  - [ ] **label/description per price** — сейчас `null`. В v2 жили на фронте, в v3 нужно решить: колонка в БД или переводы через отдельный канал.
  - [ ] **minor units по ISO 4217** — `local_amount` делится на 100, что неверно для валют с 0 decimals (JPY, KRW, VND) и 3 decimals (BHD, JOD). Баг унаследован от v2 (`PaywallPricing.tsx` тоже делит на 100). Проверено: для paywall 65 в JP возвращается `JPY 479/2868/4990` — судя по всему, в БД JPY хранится уже с условными "центами". Фиксить вместе с решением по базовой `currency`.
- [ ] **Magic-link landing** — страница, которая выставляет Supabase-session через URL hash и отдаёт control обратно (через `window.close()` + `postMessage`, либо через redirect на клиентский origin с токеном в hash).
- [x] **Server-driven checkout URL** — сделано 2026-04-24. `/start-checkout` возвращает `{checkoutUrl, userId, acquiring}`, SDK его просто открывает ([BillingClient.createCheckout](sdk/src/core/BillingClient.ts)). Провайдер выбирается на бэке через `checkoutWithAcquiring` — SDK не знает, Stripe это, Paddle или Chargebee.
- [x] **Return-URL контракт** — сделано 2026-04-24. Утилита [paywall-return-url.ts](online/utils/paywall-return-url.ts) добавляет маркеры в hash success/error URL из `/start-checkout`. SDK ловит их в [sdk/src/ui/PaywallUI.ts](sdk/src/ui/PaywallUI.ts) (`checkReturn()`):
  - `paywall_status=paid|failed|cancelled` ✓
  - `paywall_price_id=<price_id>` ✓
  - `paywall_session_id=<session_id>` — **не включён**. Stripe-подстановка `{CHECKOUT_SESSION_ID}` работает только для Stripe, добавить per-provider при первой же потребности в серверной верификации сессии на клиенте.
  - Hash используется (SPA-роутеры не перехватят); SDK парсит и hash, и query.
- [ ] **iframe-pipeline не трогать** — v2 клиенты продолжают работать как сейчас.

## Что править в `platform`

- [ ] Поле `sdk_version: 2 | 3` в UI создания пейвола (или расширить `runtime_mode` значениями `client-native`, `hybrid-native`).
- [ ] UI для управления "Allowed origins" для site-клиентов.
- [ ] Live-preview в админке — перевести с iframe на прямой рендер `PaywallUI` из npm-зависимости (более честное превью + нет синхронизации проблем).
- [ ] **Funnel-виджет аналитики SDK 3.0** на странице пейвола. Данные пишутся в ClickHouse-таблицу `paywall_sdk_events` (см. [Аналитика SDK 3.0](#сделано-аналитика-sdk-30-2026-04-26)). Что нужно:
  - читалка в platform поверх существующего ClickHouse-клиента (или отдельный — у platform на Vercel свой instance);
  - запросы funnel'а (`app_opened → paywall_opened → paywall_viewed → price_selected → checkout_started → purchase_completed/purchase_failed`) с группировкой по дате/неделе/месяцу;
  - Tremor-funnel + bar-chart drop-off;
  - breakdown-фильтры: `country`, `sdk_version`, `channel` (extension/web), `is_test_mode` (брать из props paywall_viewed);
  - distribution time-to-purchase (P50/P95) по сессиям с visitor_id;
  - mini-widget на дашборде с топ-метриками (views, conversion %, paid count за 7/30 дней).
- [ ] **SDK-version dashboard** — вторичный consumer той же таблицы: распределение `sdk_version` × `channel` × `country`, P50/P95 «возраста» SDK в днях. Нужно для deprecation-по-метрике (см. [Управление version skew](#управление-version-skew-без-iframe-это-критично)). Можно сделать в одном виджете с funnel'ом.
- [ ] Docs (`docs-v2`) — квикстарты под каждый канал: npm для расширений (с рецептом manifest), npm для сайтов, CDN UMD, framework adapters. Отдельная глава — server (headless биллинг). **Добавить главу про аналитику** — какие события эмитятся автоматом, как кастомизировать через `paywall.track('host:custom', props)`, что нельзя слать (PII).

## Управление version skew (без iframe это критично)

Главный принцип: **SDK — рендер-движок тонкого кода, 80% изменений остаются server-driven и работают на всех версиях SDK без обновления.**

### Server-driven (меняется без апдейта SDK):

- Цены, валюты, local prices
- Тексты, переводы, CTA
- Цвета, custom CSS, брендинг
- Visibility rules, geo-targeting, A/B варианты (сервер выбирает, SDK видит финальный конфиг)
- Trial-параметры (длина, количество открытий)
- Checkout URL (см. server-driven checkout выше)
- Локализация (не bundled JSON, а remote)
- Порядок элементов в модалке — через **server-driven layout** (JSON-схема блоков):
  ```json
  { "layout": { "type": "modal", "blocks": [
    { "type": "heading", "text": "..." },
    { "type": "price_grid", "prices": [...] },
    { "type": "cta_button", "action": "checkout" }
  ]}}
  ```
  SDK рендерит каждый `type`. Новый тип блока = новая версия SDK. Но перестановки, скрытия, тексты — без апдейта.

### Version/capabilities handshake

SDK шлёт с каждым запросом:
```
X-SDK-Version: 3.4.2
X-SDK-Capabilities: modal-v2,apple-pay,shadow-dom,stream-requests
```
Сервер отдаёт конфиг под возможности клиента. Старые SDK получают fallback на фичи, которые они не умеют.

### Feature flags per-paywall

```json
{ "features": { "new_trial_flow": true, "apple_pay": false } }
```
Раскатка фичи на конкретные paywall_id без апдейта SDK у тех, кому фича не включена.

### Min-SDK-version gate (редкий, security-only)

```json
{ "min_sdk_version": "3.0.0", "recommended_sdk_version": "3.4.0" }
```
Использовать только для security-fixes. Обычно — `recommended` с warning в console.

### Мониторинг (обязательно с первого дня)

- ✅ `X-SDK-Version` логируется в ClickHouse на каждом аналитическом событии (таблица `paywall_sdk_events`). Поверх неё можно строить версионный дашборд.
- [ ] Дашборд: распределение версий, P50/P95/P99 «возраста» SDK в днях, breakdown по каналам — см. чек-лист в [Что править в platform](#что-править-в-platform).
- **Deprecation по метрике, не по календарю**: удаляем код старой версии, когда её usage <1% трафика или <N активных paywall'ов.

## Корнер-кейсы по платформам

### Extension (client + hybrid)

- MV3 CSP (`script-src 'self'`): SDK вшит в бандл — OK. Но **Stripe.js / Paddle.js нельзя грузить remote** в content-script. Решение — открывать checkout в popup/tab через `chrome.tabs.create` или `window.open`, платёжные скрипты живут на той вкладке.
- `chrome.storage.sync` — 100KB всего, 8KB на ключ. Supabase JWT ≈ 2-3KB — лезет, но без запаса. **Использовать `chrome.storage.local` (5MB) для session, sync — только для visitor_id** (как сейчас в [paywall-Iframe-script.ts:114-119](platform/components/paywall-Iframe-script.ts#L114-L119)).
- OAuth: `chrome.identity.launchWebAuthFlow` — канонический путь для MV3, возвращает на `chromiumapp.org`. Адаптер в extension-helper.
- Service worker умирает через 30с — не держать state в background, хранить в `chrome.storage`.
- Shadow DOM с `attachShadow({ mode: 'closed' })` — защита от внешнего доступа.

### Site (client + hybrid без custom domain)

- CORS с credentials не работает при `Allow-Origin: *` — обязательно echo-origin с whitelist.
- Supabase OAuth `redirectTo` — требует whitelist в Supabase admin. У вас сотни клиентов → **фиксированный redirect на `appbox.space`**, обратно postMessage opener'у.
- Magic-link: без custom-domain ссылка ведёт на `appbox.space/paywall/auth/verify?token=...` → выставляет сессию в localStorage → `window.close()` + postMessage. Fallback на случай закрытого окна.
- Stripe success/cancel URL → клиентский origin + `?paywall_status=paid`. **Ловить до SPA-роутера** (или через hash вместо query), иначе роутер клиента может перехватить и потерять параметр.
- Strict CSP клиента (`script-src 'self'`) — неразрешимо без proxy. Документировать как ограничение, продавать custom-domain как решение.
- CSS-конфликты в shadow DOM: **HeroUI и часть Framer Motion плохо работают в shadow DOM**. Вероятно, PaywallModal придётся переписать на lean-стек (Radix primitives + Tailwind без HeroUI, простые CSS-transitions). Это самая большая работа в SDK 3.0 — 3-4 недели сама по себе.
- SSR у клиента (Next.js/Remix): SDK должен быть SSR-safe, без top-level `window`.
- Popup blockers: `window.open` только из user-gesture (onClick).

### Hybrid (любая платформа)

- Email приходит через `paywall.open({ identity })` вместо postMessage-события. Упрощение [PaywallClient.tsx:302-315](online/app/paywall/[id]/PaywallClient.tsx#L302-L315).
- Guest-flow (`pendingGuestPurchase` в [PaywallGoogleButton.tsx:77-85](online/components/PaywallGoogleButton.tsx#L77-L85)) — в hybrid практически не нужен, host уже знает юзера.
- Admin live-preview — это `new Paywall({ id, editorMode: true, identity: {...} })`. Флаг, не отдельный режим.

## Legacy v2 (iframe)

- `online/app/paywall/[id]/` и `paywall-Iframe-script.ts` — **не трогать**, оставить для v2-клиентов.
- Старых клиентов не мигрировать насильно — только новые сажать на v3.
- `runtime_mode` в БД — добавить `client-native`, `hybrid-native`; код разводится по флагу.
- Поддержка 12-18 месяцев. Чистка, когда v2-трафик упадёт ниже порога по метрикам.

## План-порядок работ

1. **Неделя 1-2:** дизайн API SDK 3.0. Решить UI-стек (HeroUI остаётся? или lean).
2. **Неделя 3-6:** переписать PaywallModal на lean-стек под shadow DOM, упаковать в npm, настроить build+CI.
3. **Неделя 7-8:** правки в `online` (CORS, PKCE auth, OAuth popup, `/bootstrap`).
4. **Неделя 9-10:** hybrid-режим end-to-end, beta для CWS-клиентов с готовым external auth.
5. **Неделя 11-14:** client-extension (chrome.storage + launchWebAuthFlow), client-site.
6. **Неделя 15-16:** docs, framework adapters (React), миграционный гайд.

**Итого ~4 месяца одного инженера до GA.** Hybrid можно вынести в beta через 8 недель и получить CWS-positive фидбек, не дожидаясь полного цикла.

## Статус SDK 3.0 alpha — сводка на 2026-04-24

Один день работы: каркас пакета ([sdk/](sdk/)) → рендер на моках → реальные данные через новый `/bootstrap` → защита shadow DOM → типизированные события → MV3 e2e в реальном Chrome. Детали ниже, здесь — карта состояний.

### Артефакты и команды

| Где | Что | Команда |
|---|---|---|
| [sdk/](sdk/) | standalone npm `@monetize/paywall`, 3 entry (`/core`, `/ui`, полный) | `pnpm build` |
| [sdk/demo/](sdk/demo/) | веб-песочница (mock + real via proxy + `?hostile` CSS) | `pnpm dev` |
| [sdk/playgrounds/extension/](sdk/playgrounds/extension/) | MV3 popup для ручного/e2e теста | `pnpm ext:build` |
| [online/app/api/v1/paywall/[id]/bootstrap/](online/app/api/v1/paywall/%5Bid%5D/bootstrap/) | aggregate endpoint `{settings,prices,offers,layout}` | `cd online && pnpm dev` |
| [sdk/tests/](sdk/tests/) | vitest: api + BillingClient + PaywallUI (jsdom) | `pnpm test` |
| [sdk/tests-e2e/](sdk/tests-e2e/) | Playwright в headless Chromium с `--load-extension` | `pnpm test:e2e` |

Всего: **33 юнит-теста + 4 e2e** (ext:build → Playwright ~5s).

### Покрытие сценариев "от open() до оплаты"

Цель — каждый сценарий (юзер кликает → данные грузятся → выбирает тариф → платит → возвращается) покрыт автоматом. Текущая карта:

| # | Сценарий | Unit | E2E | Manual | Что мешает полному покрытию |
|---|---|---|---|---|---|
| 1 | `paywall.open()` создаёт shadow host | ✓ | ✓ | ✓ | — |
| 2 | bootstrap грузится → `ready` event | ✓ | ✓ | ✓ | — |
| 3 | Layout из сервера рендерится (heading/price_grid/cta) | — | ✓ (snapshot) | ✓ | нет юнит-теста рендерера (jsdom + Preact) |
| 4 | Клик по тарифу → `price_selected` + visual selection | ✓ (unit emit) | — | ✓ | shadow `mode: closed` мешает Playwright кликнуть внутрь. Добавить `shadowMode` опцию для тестов ИЛИ клик по координатам |
| 5 | CTA Continue → `createCheckout` → `checkout_started` + `window.open(url)` | — | — | — | нужен мок provider-URL в e2e; `window.open` в Playwright перехватывается через `context.on('page')` |
| 6 | Возврат с маркерами `?paywall_status=paid` → `purchase_completed` | ✓ | ✓ | ✓ | — |
| 7 | Возврат с `cancelled`/`failed` → `purchase_failed` | ✓ | — | ✓ | добавить e2e (аналог #6) |
| 8 | Реальный Stripe test-mode: клик → checkout → success redirect | — | — | — | нужен `online` в test-mode + Stripe CLI webhooks ИЛИ моки. Интеграционный, отдельный scope |

Пробелы #4, #5, #7 — следующая логичная итерация тестов. #8 — интеграция с реальным платёжным провайдером, отдельная история.

### Что работает end-to-end прямо сейчас

- Локально: `cd online && pnpm dev` (на `https://local.paywall.app:5050`) + `cd sdk && pnpm dev` → SDK proxy-ит `/api` на online. Demo открывается в браузере с реальным paywall 65 — "HEIC to JPG Pro Plan", 3 цены, 14-day trial, оранжевый brand.
- MV3 extension: `pnpm ext:build` → Load unpacked → popup с замоканным fetch.
- CI-friendly: `pnpm test && pnpm test:e2e && pnpm typecheck` — всё зелёное в headless.

### Что ещё не работает end-to-end

- **Реальная оплата через SDK 3.0** — блокеры: (а) `online` в проде не знает про `/bootstrap` (пока только локально), (б) `start-checkout` ответ не содержит `success_url` с `paywall_status=paid` маркерами (нужен "Server-driven checkout URL" из [секции online](#что-править-в-online)), (в) CORS whitelist нет — cross-origin не заработает пока клиент на другом домене.
- **Auth** — нет, вообще. Identity принимается извне (hybrid). Managed-auth (client-режим) — следующая фаза.
- **Extension-specific API** — chrome.storage работает через fallback ([storage.ts](sdk/src/core/storage.ts)), но не протестирован в MV3. chrome.identity (OAuth) — вообще не реализован.
- **Offers / local prices / label / description** — заглушки в `/bootstrap` ([TODO выше](#что-править-в-online)).

### Ключевые принципы, зафиксированные кодом

- **Server-driven layout** — `Layout` это чистый JSON-дерево блоков, никакого eval/Function.
- **Server-driven checkout** — SDK не знает провайдера, просто открывает URL от бэка.
- **Identity-driven API** — нет режимов `client/hybrid/server`, решает наличие `identity`.
- **SSR-safe** — все `window`/`document`/`chrome` под `typeof` guards.
- **Типизированные события** — `PaywallEventPayloads` map, `on<E>()` с автокомплитом payload'а.
- **Shadow DOM isolation** — `:host { all: initial !important }` reset внутри shadow ([mount.ts](sdk/src/ui/mount.ts)); filter/transform на ancestors — непокрываемое ограничение.

### Бюджеты (факт vs цель)

| Entry | Factual (brotli) | Budget |
|---|---|---|
| `/core` | 1.26 KB | 8 KB |
| `/ui` | 12.17 KB | 60 KB |
| full | 12.24 KB | 70 KB |
| extension popup (inlined) | 16.4 KB gzip | — |

---

## Сделано: skeleton SDK 3.0 alpha-0 (2026-04-24)

Первый проход по шагам 1-2 плана — каркас пакета и рендер-движок на моках. Живёт в [sdk/](sdk/), standalone npm-пакет `@monetize/paywall`, не-workspace.

### Стек (закрывает UI-стек вопрос)

- **Preact 10** (alias `react → preact/compat`), не React. Критично для bundle.
- **Tailwind v4** + `@tailwindcss/vite`, CSS компилируется в строку и инжектится в shadow root через `import css from './styles.css?inline'`.
- **Shadow DOM** `{ mode: 'closed' }`.
- **Собственная Modal** (focus trap, Esc, backdrop, ARIA) — без Radix/HeroUI, ~80 строк.
- **Vite lib mode** (три entry, dual ESM+CJS), `vite-plugin-dts` для `.d.ts`.
- **`size-limit`** gate в `package.json`.

### Что лежит в `sdk/src/`

- `core/` — `BillingClient` (`.bootstrap()` fan-out'ит текущие `/settings`+`/prices`+`/offers`, TODO на `/bootstrap`; `.createCheckout()` ждёт server-driven endpoint), `ApiClient` с headers (`X-SDK-Version`, `X-Paywall-Id`, `X-SDK-Capabilities`), `createStorage()` с автодетектом `chrome.storage.local → localStorage → memory`, `PaywallError`, типы.
- `ui/` — `PaywallUI` класс (`.open/.close/.on/.destroy`), `mount.ts` (shadow DOM + CSS inject), `Modal.tsx`, `renderer/` с реестром блоков.
- `ui/renderer/blocks/` — `heading`, `text`, `price_grid`, `cta_button`. Новый блок = новая версия SDK, но порядок/тексты/visibility — server-driven (TODO decision).
- `demo/` — `pnpm dev` открывает `http://localhost:5060/demo/` с замоканным fetch, без бэка.

### Бюджеты (фактические vs целевые из TODO)

| Entry | Factual (brotli) | Budget |
|---|---|---|
| `/core` | 1.26 KB | 8 KB |
| `/ui` | 12.17 KB | 60 KB |
| full | 12.24 KB | 70 KB |

Запас огромный — будет куда расти при добавлении auth и сложных блоков.

### Принципы, которые зафиксированы кодом

- **Server-driven layout** — `Layout` тип это чистый JSON (`{ type, blocks: [{type, ...}] }`), никакого eval/Function/шаблонов с выражениями. Соответствует CWS-ограничению «no remote code».
- **Server-driven checkout** — `createCheckout()` возвращает `{ url, sessionId }`, SDK просто открывает URL. Stripe/Paddle/Chargebee в SDK не упоминаются.
- **Identity-driven API** — нет режимов `client/hybrid/server`, только наличие `identity` определяет поведение. `setIdentity()` сбрасывает кэш bootstrap.
- **SSR-safe** — все `window`/`document`/`chrome` проверяются перед использованием.

### Что НЕ входит в alpha-0 (явный out-of-scope)

- Auth-слой (Google/Apple/Email, Supabase адаптер).
- Трейлы с таймером, A/B варианты, локализация, offer-баннер, кастомный CSS клиента.
- Реальный `/api/v1/paywall/[id]/bootstrap` на бэке.
- CORS whitelist и остальные правки в `online`.
- Автотесты (harness настроен, тестов нет), CI, npm publish.
- Framework adapters, CDN UMD.

### Следующие логические шаги

1. [x] ~~Визуальная проверка демки глазами~~ — сделано 2026-04-24 через Playwright с "hostile host CSS" в демо (`?hostile`). См. ниже.
2. [partial] Правки в `online` (неделя 7-8 плана) — `/bootstrap` endpoint ✓ (2026-04-24), CORS whitelist и OAuth через `window.opener` — ещё нет. `BillingClient.bootstrap()` переехал с fan-out на единый `/bootstrap`. Демка `sdk/demo` с `paywall_id=65` на локальном online тянет реальные данные, показывает "HEIC to JPG Pro Plan" с тремя ценами и 14-day trial. Dev-флоу: `cd online && pnpm dev` + `cd sdk && pnpm dev` (SDK proxy-ит `/api` на `https://local.paywall.app:5050`, переопределяется через `VITE_API_TARGET`).
3. Auth-слой как отдельный lazy entrypoint `@monetize/paywall/auth` (неделя 9-10).
4. Extension-helper `@monetize/paywall-extension` с `chrome.identity.launchWebAuthFlow` (неделя 11-12).

### Типизированные события + URL-sniffer (2026-04-24)

- [sdk/src/ui/PaywallUI.ts](sdk/src/ui/PaywallUI.ts) — типизированный `PaywallEventPayloads` map (автокомплит event→payload в IDE). Новые события: `price_selected`, `purchase_completed`, `purchase_failed`. Убран `checkout_starting` (дубль `checkout_started`).
- `PaywallUI.checkReturn()` — парсит маркеры `paywall_status` / `paywall_price_id` / `paywall_session_id` из hash (приоритет) и query, эмитит соответствующее событие, чистит URL через `history.replaceState`. Autorun через microtask в конструкторе (`autoDetectReturn: true`), клиент успевает подписаться синхронно.
- Контракт URL-маркеров для бэка описан в [Что править в `online`](#что-править-в-online) — секция "Return-URL контракт".
- Покрыто 11 юнит-тестов в [sdk/tests/PaywallUI.test.ts](sdk/tests/PaywallUI.test.ts) через jsdom.

### MV3 E2E в реальном Chrome (2026-04-24)

Цель — в любой момент проверить SDK в настоящем extension-окружении, автоматом и глазами.

- [sdk/playgrounds/extension/](sdk/playgrounds/extension/) — минимальный MV3:
  `manifest.json` (permissions: storage, popup, пустой service worker) + `popup.html` +
  `src/popup.entry.ts` (импортирует `PaywallUI`, замоканный fetch, экспонирует
  `window.__paywall` для e2e). Сборка: `pnpm ext:build` → `dist/` (53 KB popup.js
  gzip, все зависимости инлайнятся — CWS-safe).
- Ручной smoke-тест: `chrome://extensions` → Load unpacked → `playgrounds/extension/dist`.
- Автотесты — Playwright + `chromium.launchPersistentContext` с `--load-extension`
  в [sdk/tests-e2e/](sdk/tests-e2e/). Покрывают: загрузку popup, open() → attached
  shadow host, `ready` event с фикстурным bootstrap, визуальный snapshot
  ([tests-e2e/extension.spec.ts-snapshots/](sdk/tests-e2e/extension.spec.ts-snapshots/)),
  `checkReturn()` URL-sniffer. Запуск: `pnpm test:e2e` (4 теста ~5s).

**Ограничения текущего playground:**
- `window.__paywall` — хак для e2e, не часть публичного API. Удалить перед публикацией.
- ES-модули вместо IIFE (vite lib-mode не делает IIFE с multi-entry). Работает и в
  popup (`<script type="module">`), и в service worker (`"type": "module"` в manifest).
- chrome.storage / chrome.identity ещё не тестируются — это задачи будущего
  extension-helper ([шаг 4](#следующие-логические-шаги)).
- E2E под `channel: 'chromium'` (Playwright Chromium), не под системным Chrome.
  Для точного MV3 parity в CI можно добавить `channel: 'chrome'`, но это требует
  системного Chrome.

### Результаты проверки shadow DOM (2026-04-24)

Добавлен toggle `?hostile` в [sdk/demo/index.html](sdk/demo/index.html) — включает агрессивные `!important` стили на `*`, `button`, `h1`, `div` + `filter: hue-rotate` на `body`.

**Найдено:** наследуемые CSS-свойства (`color`, `font-family`, `letter-spacing`, `text-transform`, `cursor`) протекали через host-элемент внутрь shadow root. Внешний `* { color: !important }` применялся к host и наследовался детьми shadow'а. Inline `all: initial` на host перебивался внешним `!important`.

**Починено** в [sdk/src/ui/mount.ts](sdk/src/ui/mount.ts) — добавлен `:host { all: initial !important; ... }` блок **внутри** shadow root. По спеке CSS Scoping внутренний author `!important` побеждает внешний для host-элемента.

**Непокрываемое ограничение (документируем, не чиним):** рендер-эффекты на ancestors — `filter`, `transform`, `opacity`, `mix-blend-mode`, `backdrop-filter`, `clip-path` — применяются на уровне композитинга, поверх shadow'а. Защиты нет в принципе. Встречается редко (мы не видели ни одного клиента с `filter` на `body`). Для white-label domain клиентов это тоже не проблема — мы всё равно на своём origin.

Тестов-скриншот-регрессий нет — проверяли глазами через Playwright. Визуальные регрессии имеет смысл добавлять, когда уровень блоков стабилизируется.

## Защита от дубликатов покупок

Обсуждение 2026-04-28. Цель — закрыть оставшиеся дыры в защите от двойных покупок. Сейчас уже есть базовый слой ([online/app/api/v1/paywall/[id]/start-checkout/route.ts:135-151](online/app/api/v1/paywall/%5Bid%5D/start-checkout/route.ts#L135-L151) — `checkUserHasActivePurchase` → 409) и idempotency на webhook'ах (upsert по `subscription.id` в [platform/utils/supabase/admin.ts](platform/utils/supabase/admin.ts)). Defense-in-depth подход скопирован у Stripe / Shopify / RevenueCat.

### Stage 1 — Idempotency key + pending lock (в работе)

Закрывает race на двойные клики, параллельные вкладки, лаг между checkout-completion и приходом webhook'а. Минимальный сюрфейс изменений, не трогает upgrade-flow.

- Таблица `paywall_pending_checkouts(idempotency_key, paywall_id, user_id, price_id, checkout_url, acquiring, expires_at)` с TTL 30 мин
- `start-checkout` принимает `Idempotency-Key`, lookup → reuse cached URL вместо создания нового checkout у провайдера
- SDK `BillingClient.createCheckout()` генерит UUID v4 на вызов, in-memory inflight dedupe, шлёт в header
- Также reuse по `(paywall_id, user_id, price_id)` без ключа (защита для старых SDK)

### Stage 2 — `change_plan` через native subscription update (отложено)

Закрывает upgrade-дыру: сейчас `ignoreActivePurchase=true` в [start-checkout route](online/app/api/v1/paywall/%5Bid%5D/start-checkout/route.ts#L135-L160) полностью отключает защиту от дублей. Топы (Stripe Customer Portal, Notion, Zoom) для апгрейда вообще не используют checkout — вызывают subscription update API.

**Что важно знать:** оба провайдера умеют автоматический биллинг с сохранённой карты, юзер не проходит checkout заново.

- **Stripe**: `POST /subscriptions/{id}` с `proration_behavior: 'always_invoice'` → считает proration (credit за неиспользованное время старого + charge за новое) → создаёт invoice → списывает с дефолтной payment method. При смене интервала (monthly→yearly) или выходе из trial списывает сразу даже без `always_invoice`.
- **Paddle**: `PATCH /subscriptions/{id}` с `proration_billing_mode: 'prorated_immediately'` → считает proration → запускает транзакцию с сохранённой картой. Альтернативы: `full_immediately`, `prorated_next_billing_period`, `do_not_bill`. `POST /subscriptions/{id}/preview` показывает точную сумму до подтверждения (Stripe аналог: `POST /invoices/upcoming`).

**Подводные камни:**
- Карта может декларнуться (expired/insufficient funds/fraud rule) → Stripe вернёт invoice `status: 'open'` (нужен `hosted_invoice_url` или Customer Portal для update card), Paddle — `transaction.payment_failed` webhook → fallback на интерактивный checkout с update_payment_method.
- 3DS / SCA challenge для off-session — банк может потребовать → транзакция упадёт → fallback на интерактивный checkout. Не частая ситуация, но обработать надо.
- Webhook'и — это `customer.subscription.updated` (Stripe) и `subscription.updated` + `transaction.completed` (Paddle), не `created`. Существующие хендлеры [stripe.ts](platform/app/api/acquiring/%5Bid%5D/webhooks/handlers/stripe.ts) и [paddle.ts](platform/app/api/acquiring/%5Bid%5D/webhooks/handlers/paddle.ts) их слушают, но проверить, что апдейт не двоит записи в `paywall_internal_purchases` (upsert по id должен корректно обновить ту же запись).

**План:**
- Новый endpoint `POST /api/v1/paywall/[id]/change-plan` принимает `from_subscription_id`, `to_price_id`
- Stripe path: `subscriptions.update` с `always_invoice`
- Paddle path: `subscriptions.update` с `prorated_immediately`
- Fallback на checkout если карта декларнулась / SCA required
- SDK: `BillingClient.changePlan({ to: priceId })` — отдельный метод от `createCheckout`
- Удаляем `ignoreActivePurchase` из API → `start-checkout` всегда возвращает 409 при активной подписке

### Stage 3 — Partial unique index в БД (backstop, после Stage 2)

`UNIQUE (paywall_id, user_id) WHERE status IN ('trialing','paid','active') AND cancel_at_period_end = false` на `paywall_internal_purchases`. Hard-гарантия, что webhook не запишет вторую активную подписку. Требует чтобы Stage 2 уже работал (иначе сломает legitimate upgrade-overlap, где старая+новая active одновременно во время transition).

## Отложенные вопросы

### Supabase — не трогаем сейчас

Полная миграция с Supabase оценена отдельно (Auth — самое болезненное, 59+ RLS политик на `auth.uid()`, `is_anonymous` как Supabase-фича, 50+ файлов с auth-вызовами). **Решение: пока оставляем.** Но два независимых улучшения стоит сделать:

- [ ] **Вынести `SUPABASE_SERVICE_ROLE_KEY` из кода в env** — сейчас хардкоден в [platform/utils/supabase/admin-client.ts:7](platform/utils/supabase/admin-client.ts#L7). Security-issue независимо от миграции.
- [ ] **Абстрагировать БД-слой** через Drizzle/Kysely поверх supabase-js (или прямой pg). Даёт 80% свободы будущего ухода за 20% работы. Можно делать в фоне, параллельно с SDK 3.0.

Если когда-нибудь уходить целиком — ориентир 4-6 месяцев осторожного rollout с dual-auth периодом.

### Открытые вопросы до старта SDK 3.0

- [x] **Конкретная претензия CWS** — и iframe, и remote-code. SDK обязан быть bundled (npm), server-driven только как данные.
- [x] **UI-стек** — lean: Preact + Tailwind v4 + собственная Modal, без Radix/HeroUI. Зафиксировано в `sdk/`.
- [x] **Монорепо сразу или через 2-3 месяца?** — пока standalone, workspace позже.
- [ ] **Приоритет framework adapters:** React → Vue → Svelte, или по-другому?
- [ ] **Где хостим CDN UMD?** Cloudflare R2 + CF, Vercel, jsdelivr-from-npm (бесплатно, но зависимость).

---

## Сделано: аналитика SDK 3.0 (2026-04-26)

End-to-end пайплайн **SDK → POST → batch buffer → ClickHouse**, без админского UI (он в чек-листе [Что править в platform](#что-править-в-platform)). Решение по архитектуре зафиксировано в обсуждении: ClickHouse на пиках 1000+ событий/сек тривиально проглотит, ~200B на запись × 100k открытий/день ≈ 20 MB/день после column-store сжатия — пренебрежимо. Postgres для этого не годится (UPSERT/index overhead на каждой записи).

### SDK (`sdk/`)

- **Visitor ID** ([sdk/src/core/storage.ts](sdk/src/core/storage.ts)): UUID v4 генерится один раз и кешится в `clientStorage` под ключом `pw-visitor-id` (`STORAGE_KEYS.visitorId`). Не PII, не привязан к identity — переключение юзера не меняет visitor_id, что нужно для cross-session funnel'ов. Helper'ы `generateVisitorId()` и `ensureVisitorId(storage)` экспортированы для тестов.
- **`BillingClient`**: новые `apiOrigin` / `capabilities` readonly-поля + методы `getVisitorId()` / `getCachedVisitorId()`. Резолв запускается в конструкторе через promise, sync-доступ через cached getter — EventTracker в большинстве случаев получает visitor_id мгновенно после первого микротаска.
- **`EventTracker`** ([sdk/src/core/EventTracker.ts](sdk/src/core/EventTracker.ts)): батч-трекер с дефолтами 20 событий / 1.5с. Headers: `X-SDK-Version`, `X-Paywall-Id`, `X-Visitor-Id`, опционально `X-User-Id` и `X-SDK-Capabilities`. Транспорт — `fetch({keepalive: true})` для обычных flush'ей и `navigator.sendBeacon` на `pagehide`/`visibilitychange:hidden` (с body-level дублями `visitor_id`/`sdk_version`/`paywall_id`/`capabilities`, потому что beacon не позволяет custom headers — сервер их парсит как fallback). Hard cap буфера 200 событий — защита от бесконечного роста при недоступности сервера. Все ошибки сети глушим: аналитика не должна валить UX.
- **`PaywallUI`** ([sdk/src/ui/PaywallUI.ts](sdk/src/ui/PaywallUI.ts)): новая опция `analytics: boolean | AnalyticsOptions` (по умолчанию `true`). Внутренние SDK-события автоматически биндятся на трекер: `open → paywall_opened`, `ready → paywall_viewed` (с `is_test_mode`/`prices_count`/`offers_count` в props), `price_selected`, `checkout_started`, `purchase_completed`, `purchase_failed`, `close → paywall_closed`, `error`. Public `paywall.track(name, props?)` — для произвольных событий хоста (типичный кейс — `paywall.track('app_opened', {source: 'main_menu'})` сразу после загрузки приложения). `destroy()` флашит pending events и снимает unload-листенеры.
- **Тесты** ([sdk/tests/EventTracker.test.ts](sdk/tests/EventTracker.test.ts) + [sdk/tests/PaywallUI.tracking.test.ts](sdk/tests/PaywallUI.tracking.test.ts)): 18 новых юнит-тестов покрывают батчинг, headers, sendBeacon-flow, fallback при отсутствии cached visitor_id, тихий survive при network failure, hard cap буфера, интеграцию с PaywallUI emit'ами и public track(). Всего 61 тест зелёный, typecheck чист.
- **Bundle**: core 2.9 KB / 8 KB бюджета (рост ~1.6 KB), ui+full 15.6 KB / 60 KB. Запас по бюджету огромный.

### Online (`online/`)

- **ClickHouse-клиент** ([online/utils/clickhouse-events-client.ts](online/utils/clickhouse-events-client.ts)): singleton с батч-буфером (200 / 5 sec), `JSONEachRow` insert, retry в буфер при ошибке, hard cap 2000, graceful shutdown на SIGINT/SIGTERM. Таблица `paywall_sdk_events`:
  ```sql
  CREATE TABLE paywall_sdk_events (
    event_ts DateTime64(3),       received_ts DateTime64(3),
    paywall_id String,            visitor_id String,
    user_id Nullable(String),     event_type LowCardinality(String),
    channel LowCardinality(String),  country LowCardinality(String),
    sdk_version LowCardinality(String),  capabilities String,
    host_origin String,  user_agent String,  ip_hash String,
    props String,
    date Date MATERIALIZED toDate(received_ts)
  ) ENGINE = MergeTree() PARTITION BY toYYYYMM(date)
    ORDER BY (paywall_id, event_type, received_ts)
    TTL date + INTERVAL 365 DAY
  ```
  Order by `(paywall_id, event_type, received_ts)` оптимизирован под funnel-запросы конкретного пейвола.
- **POST endpoint** ([online/app/api/v1/paywall/[id]/events/route.ts](online/app/api/v1/paywall/%5Bid%5D/events/route.ts)): принимает `{events: [{type, ts, props?}]}`, валидирует (whitelist event_types + префикс `host:` для кастомных, лимит 100/batch и 64KB/payload и 8KB/props, skew клиентского `ts` <24ч), enrich'ит (geo через MaxMind, channel `extension|web` по Origin, ip_hash через sha256+`EVENTS_IP_SALT`), кладёт в батч-буфер. Возвращает `204 No Content` всегда (кроме явного «no_events» / «too_many_events» / preflight). CORS через `checkV3Origin` — общая защита для всех v3-эндпоинтов.
- **Headers vs body**: основной канал — headers (`X-Visitor-Id`, `X-User-Id`, `X-SDK-Version`, `X-SDK-Capabilities`). Body-level дубликаты (`visitor_id`/`user_id`/`sdk_version`/`capabilities`) читаются как fallback — нужны исключительно для sendBeacon-запросов, где custom headers запрещены спецификацией.
- **Whitelist event_type'ов** на сервере: `app_opened`, `paywall_opened`, `paywall_viewed`, `paywall_closed`, `price_selected`, `checkout_started`, `purchase_completed`, `purchase_failed`, `error` + регэксп `^host:[a-zA-Z0-9_.-]{1,57}$`. Всё остальное молча дропается, чтобы не засорять `LowCardinality`-колонку.

### Что НЕ входит (явный out-of-scope)

- **Админский UI** — funnel-виджет, version-dashboard, distribution time-to-purchase. Чек-листы добавлены в [Что править в platform](#что-править-в-platform).
- **Sampling** — пока не нужно: на текущем масштабе (порядки сотен тысяч событий/день) ClickHouse спокойно жуёт без сэмплинга. Если объём вырастет на порядок — добавить hash-based sampling в `addEvents()`.
- **Rate limit на `/events`** — нет. Защита от злоупотреблений = `checkV3Origin` (allowed_origins) + hard caps на размер payload'а. Если потребуется — можно через `paywall_id`-bucket в Redis или CF rate-limit на edge.
- **Server-side dedupe** — нет (визитор может ретраить, мы получим дубль). Решение когда-нибудь: deterministic event_id (`hash(visitor_id+ts+type+props)`) + ReplacingMergeTree или materialized view.
- **PII-санитайзер** — на сервере полагаемся на дисциплину SDK (никаких email/токенов в `props`). Документировать в docs-v2.

### Env-переменные (новые)

- `EVENTS_IP_SALT` (опционально) — соль для `sha256(ip+salt)`. Без неё ip_hash идёт от чистого ip, что даёт стабильный, но уже не «слепой» хеш. На прод желательно поставить случайную строку и не менять.
