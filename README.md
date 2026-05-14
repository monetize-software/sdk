# Проект

B2B проект - встраивание монетизации для веб-приложений на основе подписок и лайфтайм платежей. Предоставляет SDK (server, client, hybrid) для быстрого встраивания пейвола в проект. Проект разделен на отдельные гит-репозитории и имеют независимый деплой. Пока основная масса клиентов владельцы chrome расширений.

Основные фичи:
- Быстрый деплой пейвола без модерации. Так как пейвол встраивается через iframe в конечное приложение пользователя не нужно к примеру проходить модерацию chrome web store.
- Гибкое управление платежными провайдерами (Stripe, Paddle, Chargebee, Overpay). В целях минимизации риска блокировок со стороны эквайринга. Позволяет настраивать распраделение трафика и использовать несколько провайдеров (payment processors) одновременно в рамках одного пейвола.
- Гибкое настраивание пейвола: цены, локальные цены, триалы разного формата, токенизация, стили.
- Расширенная статистика в динамике. Просмотры пейвола, оплаты, mrr, ltv и прочие метрики. 

- `platform` — админка для клиентов для управления пейволами, просмотра статистики. Деплоится на Vercel. Нагрузка слабая. Также тут расположены вебхуки от платежных систем.
PROD URL: https://monetize.software
LOCAL: https://local.paywall.app:5555/

- `online` — сам пейвол, который виден конечным клиентам. Максимально тонкий, чтобы много не грузить. Деплой на несколько инстансов в Digital Ocean. Нагрузка около 30-50 rps.
PROD URL: https://appbox.space - основной, есть еще onlineapp.live, onlineapp.stream на всякий.
LOCAL: https://local.paywall.app:5050/

- `docs` - документация для разработчиков, кто хочет подключить проект, деплоится во время деплоя platform.
URL: https://monetize.software/docs-v2

# Стек

- **Next.js 15** (App Router), **React 19**, **TypeScript 5.8**
- **Supabase** (PostgreSQL) — основная БД, авторизация, storage
- **ClickHouse** — аналитика, логирование запросов, трейсинг
- **Tailwind CSS** (v4 на platform, v3 на online), **HeroUI** (NextUI) — UI-компоненты
- **Tremor**, **Recharts**, **ApexCharts** — графики/дашборды (platform)
- **SWR** — data fetching на platform, серверные компоненты — основной подход к данным
- **Framer Motion** — анимации
- Платежные провайдеры: **Stripe**, **Paddle**, **Chargebee**, **Overpay**
- **Sentry** — мониторинг ошибок (online)
- **Resend** — email-рассылки (platform)
- Пакетный менеджер: **pnpm**

# Команды

```bash
# platform (порт 5555)
cd platform && pnpm dev    # dev с https и turbo
cd platform && pnpm build  # билд + pagefind индексация
cd platform && pnpm lint

# online (порт 5050, hostname local.paywall.app)
cd online && pnpm dev      # dev с https и turbo
cd online && pnpm build    # standalone билд
cd online && pnpm lint

# Генерация типов БД (одинаково в обоих проектах)
pnpm supabase:generate-types
```

# Структура проектов

## platform (platform)
- `app/[lang]/` — интернационализированные роуты (13 языков)
- `app/api/` — API-роуты (вебхуки, админ, трейсы)
- `app/blog-v2/`, `app/docs-v2/` — блог и документация (Nextra)
- `components/` — переиспользуемые UI компоненты
- `utils/supabase/` — клиенты БД (server, client, middleware)
- `utils/clickhouse/` — клиент аналитики
- `swr/` — хуки SWR для data fetching
- `server-cashed-queries/` — серверное кеширование запросов
- `lang/` — переводы
- `sql/` — SQL-схемы

## online (online)
- `app/api/v1/paywall/[id]/` — API пейвола (settings, offers, prices, start-checkout, user)
- `app/api/v1/api-gateway/[provider_id]/` — проксирование платежных провайдеров
- `app/paywall/` — UI пейвола
- `app/email-wall/` — email wall
- `utils/stripe/`, `utils/chargebee/` — интеграции с платежками
- `server-cashed-queries/` — серверное кеширование
- `geoip/` — геолокация по IP

### Кастомные домены и assetPrefix в online

Клиенты могут повесить свой поддомен (напр. `paywall.client.com`) на `online` через DNS — тогда `online` работает как reverse-proxy к сайту клиента (`client.com`), с «изъятой» зоной для наших роутов. Логика в `online/middleware.ts`:
- `/` → `/proxy-landing` (SSR-прокси главной клиента с `noindex`)
- `/[наш путь]` → штатно online (как на `appbox.space`)
- `/[всё остальное]` → `/proxy-asset?url=https://client.com/[тот же путь]` (клиентские ассеты, навигация, их `/_next/*` и т.д.)

`KNOWN_HOSTS` — массив наших хостов (`appbox.space`, `onlineapp.live` и пр.); всё не из этого списка считается кастомным доменом.

**Важно**: все наши статические ассеты Next.js живут под префиксом `/pw-assets/` (через `assetPrefix` в `online/next.config.ts`), чтобы не пересекаться с клиентским `/_next/*` на кастомном домене. Если клиент тоже на Next.js, его чанки и наши никогда не конфликтуют. Префикс применяется только в production — в dev `assetPrefix = undefined`, чтобы не ломать HMR.

**При добавлении нового public-роута в online** (новая страница или API-группа на top-level) — обязательно добавить его префикс в `isOurs` в `online/middleware.ts`, иначе на кастомных доменах он будет проксироваться к клиенту. Текущий список: `/paywall`, `/api/`, `/email-wall`, `/checkout`, `/captcha-frame`, `/proxy-asset`, `/proxy-landing`, `/pw-assets/`, `/legal/`. Страницы самого проекта `monetize.software` (footer, legal-документы) живут под `/legal/*` — это «наш» namespace, доступный на всех хостах, включая кастомные домены клиентов. А «общие» имена `/privacy`, `/agreement` и т.п. на кастомных доменах проксируются к клиенту — его документы в приоритете.

Iframe скрипт клиента (генерируется в `platform/components/paywall-Iframe-script.ts`) вшивает iframe src как `{ORIGIN}/paywall/{PAYWALL_ID}`, где `{ORIGIN}` — либо наш хост, либо кастомный домен клиента. Клиент использует тот же встроенный код, просто с другим origin.

# База данных

Основные таблицы Supabase:
- `paywall` — конфигурации пейволов
- `paywall_users` — конечные пользователи
- `paywall_internal_purchases` — подписки/платежи
- `paywall_acquiring_customers` — маппинг клиент-эквайринг
- `paywall_balances` — токенные балансы
- `acquiring` — настройки платежных провайдеров
- `internal_users` — пользователи платформы
- `api_keys` — API-ключи
- `offer_settings`, `offers` — промо-акции

Типы БД генерируются в `utils/types_db.ts` командой `pnpm supabase:generate-types`.

# Деплой

- **platform** → Vercel (cron-задачи, edge functions)
- **online** → Digital Ocean (PM2, несколько инстансов, standalone build). Перед DO стоит Cloudflare — при релизах, которые меняют HTML или пути ассетов, может потребоваться purge кеша в CF.
- **docs** → деплоится вместе с platform (prebuild клонирует репо)

# Правила разработки

- Path alias: `@/*` → корень проекта (в обоих проектах)
- `strict: false` в tsconfig — не включать strict
- Форматирование: single quotes, 2 пробела, без trailing commas (Prettier)
- online должен оставаться максимально легким — минимум зависимостей, быстрая загрузка
- В online для клиентского хранилища использовать `clientStorage` из `@/utils/clientStorage` вместо прямого `localStorage`. `clientStorage` — обёртка, которая пишет и в chrome.storage (для расширений) и в localStorage (как fallback). Ключи хранить в `STORAGE_KEYS` в том же файле.
- Язык коммуникации: русский