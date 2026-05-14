export interface Identity {
  email?: string;
  userId?: string;
  anonymousId?: string;
}

export interface PaywallPrice {
  id: string;
  currency: string;
  amount: number;
  interval: 'month' | 'year' | 'week' | 'day' | 'lifetime' | null;
  interval_count: number | null;
  trial_days: number | null;
  label?: string | null;
  description?: string | null;
  local?: { currency: string; amount: number } | null;
}

export interface PaywallOffer {
  id: string;
  discount_percent: number | null;
  expires_at: string | null;
  price_id: string | null;
  label?: string | null;
}

export interface PaywallSettings {
  id: string;
  name: string;
  brand_color?: string | null;
  custom_css?: string | null;
  locale_default?: string | null;
  runtime_mode?: 'client' | 'hybrid' | 'server' | 'client-native' | 'hybrid-native';
  /** true, если эквайринг пейвола в test-mode — SDK рисует TEST MODE бейдж. */
  is_test_mode?: boolean;
  /** Auth-flow относительно checkout. `guest` (default) — без auth перед оплатой;
   *  `preauth` — клик по cta_button=checkout сначала открывает AuthPanel-gate,
   *  после signIn auto-resume исходного createCheckout. Поле общее с legacy v2. */
  checkout_mode?: 'guest' | 'preauth';
  /** OAuth-провайдеры для preauth-gate в порядке отображения. Бэк сейчас отдаёт
   *  фиксированный список (google + apple); если поле не задано — gate рисует
   *  только email-форму. Не путать с `block.providers` у inline-блока auth_panel. */
  auth_providers?: Array<'google' | 'apple' | 'github' | 'facebook'>;
  /** Разрешён ли вход без email — анонимный юзер. `paywall.signInAnonymously()`
   *  падает с code='anonymous_disabled', если флаг = false. Поле дублирует
   *  `paywall_settings.allow_anonymous` из БД, то же что используется в legacy
   *  v2 (PayWallIframeOpener.tsx). Защита от abuse — на стороне сервера (Supabase
   *  rate-limit per real-IP + CF Bot Fight Mode), capтча в SDK не используется. */
  allow_anonymous?: boolean;
  /** Можно ли закрыть модалку (крестик, клик по overlay, ESC). По умолчанию true.
   *  false — модалка показывается до успешной покупки или явного host-close().
   *  v2-аналог `allow_close`. */
  allow_close?: boolean;
  /** Авто-подгонка размера шрифта heading-блока, чтобы заголовок влезал в 2
   *  строки. v2-аналог `title_auto_fit`. По умолчанию false. */
  title_auto_fit?: boolean;
  /** URL, куда редиректить вкладку после успешной покупки (server-confirmed
   *  через UserWatcher). null/undefined — остаёмся на месте, показываем
   *  PurchaseSuccessView. v2-аналог `success_redirect_url`. */
  success_redirect_url?: string | null;
  /** URL "Вернуться в магазин" — пробрасывается в createCheckout как `shopUrl`
   *  для Stripe/Paddle страницы оплаты. v2-аналог `checkout_shop_url`. */
  checkout_shop_url?: string | null;
  /** Имя продукта на странице оплаты Stripe/Paddle (line_item.name). Бэк
   *  использует при создании checkout-сессии. v2-аналог `checkout_product_name`. */
  checkout_product_name?: string | null;
  /** Конфиг pre-paywall триала (паывол не показывается, пока триал активен).
   *  null/undefined — триал отключён, `paywall.open()` сразу открывает модалку.
   *  v2-аналог пары `trial` + `trial_payload` в paywall_settings. Не путать с
   *  card-trial (PaywallPrice.trial_days) — это автосписание после оплаты. */
  trial?: TrialConfig | null;
  /** Server-computed targeting-gate: матчится ли текущий юзер (страна/девайс)
   *  под настройки таргетинга пейвола, плюс общий on/off-флаг. SDK перед open()
   *  читает `visible`: false → эмитит `visibility_blocked` и не монтирует
   *  модалку. country/tier выдаются всегда — host'ы используют для аналитики.
   *  v2-аналог `visibilityEnabledAndTargetingMatch` + `detectInvisible` в
   *  PaywallClient.tsx + StateService. */
  visibility?: VisibilityStatus;
}

export interface VisibilityStatus {
  /** true — паывол можно открывать. false — какой-то таргетинг не сошёлся,
   *  смотри `reason`. */
  visible: boolean;
  /** Почему `visible=false`. null когда `visible=true`.
   *  - `disabled` — владелец выключил visibility-флаг.
   *  - `country_not_match` — страна юзера не в whitelist (countries_tier +
   *    extra_countries).
   *  - `device_not_match` — extension-канал (device_target=true), юзер не на
   *    macOS. Имеет приоритет над country, потому что в этом канале device —
   *    главное условие.
   */
  reason: 'country_not_match' | 'device_not_match' | 'disabled' | null;
  /** ISO-код страны юзера (по IP). null — не удалось определить. */
  country: string | null;
  /** Тир страны 1/2/3 (см. legacy `new_country_code_to_tier`). null — страна
   *  не определилась. Все unmapped страны → 3. */
  tier: 1 | 2 | 3 | null;
}

export interface TrialConfig {
  /** `time` — паывол скрыт N часов после первого open(); `opens` — N первых
   *  open() закрываются молча, N+1-й уже показывает паывол. */
  mode: 'time' | 'opens';
  /** Часы для `time`, количество открытий для `opens`. */
  payload: number;
  /** Где живёт состояние триала. `client` — localStorage (default, мгновенно,
   *  юзер может сбросить очисткой storage). `server` — серверный endpoint
   *  (сейчас стаб; включится, когда будет серверный handler). */
  storage: 'client' | 'server';
}

/** Статус триала на момент `paywall.open()`. SDK эмитит в payload событий
 *  `trial_blocked`, и возвращает синхронно из `paywall.getTrialStatus()`. */
export type TrialStatus =
  | { mode: 'none'; blocked: false }
  | TimeTrialStatus
  | OpensTrialStatus;

export interface TimeTrialStatus {
  mode: 'time';
  /** true — триал ещё активен, паывол не показывается. */
  blocked: boolean;
  /** Unix ms первого `open()`. null — триал ещё не стартовал. */
  startedAt: number | null;
  /** Unix ms окончания триала. null — триал ещё не стартовал. */
  expiresAt: number | null;
  /** Сколько ещё ms триал активен. 0 — истёк или не активен. */
  remainingMs: number;
  /** Полная длина триала в ms (payload часов × 3_600_000). */
  totalMs: number;
}

export interface OpensTrialStatus {
  mode: 'opens';
  /** true — триал ещё активен, паывол не показывается. */
  blocked: boolean;
  /** Сколько ещё «бесплатных» открытий осталось. 0 — триал истёк. */
  remainingActions: number;
  /** Полное число «бесплатных» открытий (payload). */
  totalActions: number;
}

export type LayoutBlock =
  | { type: 'heading'; text: string; level?: 1 | 2 | 3 }
  | { type: 'text'; text: string }
  | {
      type: 'price_grid';
      priceIds?: string[];
      /** Раскладка карточек цен. `vertical` (default) — стек сверху вниз;
       *  `horizontal` — ряд side-by-side. v2-аналог `view: 'default' | 'telegram'`. */
      view?: 'vertical' | 'horizontal';
      /** ID цены, которая помечается лейблом «популярный план». v2-аналог
       *  пары `price_label_id` + `price_label`. */
      popular_price_id?: string;
      /** Текст лейбла «популярный план». По умолчанию "Most popular".
       *  v2-аналог `price_label_text`. Локализация — через bootstrap.locales. */
      popular_label?: string;
    }
  | { type: 'cta_button'; label: string; action: 'checkout' | 'close'; priceId?: string }
  | {
      /** Footer-блок под cta_button: залогинен — рисует "Signed in as <email> | Sign out",
       *  иначе — кнопку "Restore purchases", которая открывает auth-gate без pendingCheckout
       *  (после signIn gate просто схлопывается, юзер видит свой signed-in state). */
      type: 'current_session';
    }
  | {
      type: 'auth_panel';
      /** OAuth-провайдеры в порядке отображения. Пусто/опущено — только email-форма. */
      providers?: Array<'google' | 'apple' | 'github' | 'facebook'>;
      /** Показывать toggle "Sign up". По умолчанию true. */
      allow_signup?: boolean;
      /** Показывать ссылку "Forgot password?". По умолчанию true. */
      allow_password_reset?: boolean;
      /** Скрывать панель, если юзер уже залогинен. По умолчанию true.
       *  false — показываем "Signed in as ... [Sign out]" даже после логина. */
      hide_when_authenticated?: boolean;
      /** Заголовок над формой (h2). Если опущен — заголовок не рендерится. */
      heading?: string;
    }
  | {
      /** Список фич/преимуществ продукта. v2-аналог `features_list` + `features_view`.
       *  До 5 элементов — рендерим как чек-лист с заголовком и описанием. */
      type: 'features_list';
      items: Array<{ id: string; name: string; desc?: string }>;
    }
  | {
      /** Информационный список «что включено в выбранный план» — рендерится
       *  под price_grid, без интерактивности. v2-аналог `tokenization` +
       *  `tokenization_queries`. Для каждого query показываем count,
       *  умноженный на множитель интервала выбранной цены (`week=0.25`,
       *  `month=1`, `year=12`) — т.е. count в БД хранится как месячная
       *  норма. Заголовок реактивно отражает текущий interval. */
      type: 'tokenization_gate';
      queries: Array<{ id: string; name: string; desc: string; count: number }>;
    };

export interface Layout {
  type: 'modal';
  blocks: LayoutBlock[];
}

/** Локализационные оверрайды для одного языка. Накатываются поверх дефолтного
 *  layout/prices при матче `navigator.language` ↔ ключа в `bootstrap.locales`.
 *  v2-аналог поля `translations` JSON в paywall_settings. */
export interface LocaleOverrides {
  /** Полная замена layout для языка. Если опущен — берётся дефолтный
   *  bootstrap.layout. */
  layout?: Layout;
  /** Точечные оверрайды текстовых полей цен. Ключ — price.id, значения
   *  накатываются на label/description. */
  prices?: Record<string, { label?: string; description?: string }>;
}

/** Снимок language-resolution для синхронизации i18n host-приложения с тем, что
 *  показывает пейвол. Возвращается из `BillingClient.getUserLanguage()` /
 *  `PaywallUI.getUserLanguage()`. */
export interface UserLanguageInfo {
  /** Best-guess BCP-47 тэг для host'а. Приоритет: `applied` → `browserLanguage`
   *  → `countryLanguage`. null — bootstrap ещё не загружен и navigator
   *  недоступен (например, ранний вызов в service worker). */
  tag: string | null;
  /** Ключ из `bootstrap.locales`, который SDK фактически применил к
   *  layout/prices. null = match'а не было, рендерится база из layout/prices
   *  без оверрайдов. */
  applied: string | null;
  /** `navigator.language` — что репортит браузер. null в окружениях без
   *  navigator (service worker до пропатчивания, Node). */
  browserLanguage: string | null;
  /** Server-resolved язык по стране юзера (IP). Берётся из
   *  `bootstrap.settings.locale_default` — AT→de, RU→ru, LV→en, и т.д.
   *  null — bootstrap ещё не загружен или сервер не отдал поле. */
  countryLanguage: string | null;
}

export interface PaywallUserPurchase {
  id: string;
  status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
}

/** Rich-shape от `/api/v1/paywall/[id]/user` для customer-portal UX (cancel,
 *  renew, история платежей). В отличие от `PaywallUserPurchase` (которая
 *  идёт из `/user-state` и имеет минимум для access-gate'а), этот shape
 *  включает цену/валюту/discount — чтобы host мог нарисовать список подписок
 *  как в legacy customer portal'е. */
export interface PaywallPurchaseDetailed {
  id: string;
  status: string | null;
  cancel_at: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  created: string;
  ended_at: string | null;
  current_period_end: string | null;
  current_period_start: string | null;
  /** Цена в minor units (центах). Для legacy совместимости — sometimes из
   *  `paywall_internal_prices.unit_amount * 100`, иногда из local_amount. */
  unit_amount: number;
  currency: string;
  interval: string | null;
  /** Скидка в процентах от offer (если был применён). undefined — без offer'а. */
  discount?: number;
}

export interface PaywallUser {
  /** Главный флаг для большинства интеграций. true, если есть активная подписка
   *  ИЛИ оплаченный lifetime ИЛИ активный trial. */
  has_active_subscription: boolean;
  purchases: PaywallUserPurchase[];
  trial: { started_at: string | null; expires_at: string | null } | null;
}

export interface PaywallBootstrap {
  settings: PaywallSettings;
  prices: PaywallPrice[];
  offers: PaywallOffer[];
  layout?: Layout;
  /** Snapshot user-state на момент bootstrap'а. Без identity (гость) — всё пусто.
   *  Дальше обновляется через BillingClient.getUser() / PaywallUI.onUserChange. */
  user?: PaywallUser;
  /** Локализационные оверрайды по BCP-47 кодам (`en`, `en-US`, `ru`, ...).
   *  BillingClient.bootstrap() матчит `navigator.language` с fallback на
   *  `settings.locale_default` и применяет оверрайды поверх layout/prices. */
  locales?: Record<string, LocaleOverrides>;
  /** Stable content-hash структурной части bootstrap'а (без user). SDK
   *  персистит payload в StorageAdapter и шлёт `?if_version=<v>` на
   *  ревалидации — бэк отвечает `{unchanged:true, version, user}` без
   *  полного payload, если version совпала. Optional для совместимости
   *  с старыми бэками. */
  version?: string;
}

export type Acquiring = 'stripe' | 'paddle' | 'chargebee' | 'overpay' | 'freemius';

export interface CheckoutResult {
  url: string;
  sessionId?: string;
  /** Платёжный процессор, к которому ушёл checkout. Полезно для аналитики
   *  конверсии по эквайрингам (host может ветвить UX по acquiring). */
  acquiring?: Acquiring;
}

export class PaywallError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(code: string, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message);
    this.name = 'PaywallError';
    this.code = code;
    this.status = opts.status;
    this.cause = opts.cause;
  }
}

/** Балансы AI-провайдеров пейвола: один элемент на `query_type` из
 *  `paywall_settings.tokenization_queries`. count = доступно вызовов. */
export interface Balance {
  type: string;
  count: number;
}

/** 402 от api-gateway: квота закончилась. UI ловит и открывает paywall;
 *  headless caller — обрабатывает сам. balances/queryType/currentBalance —
 *  то же, что отдаёт бэк в `details`. */
export class QuotaExceededError extends PaywallError {
  readonly balances: Balance[];
  readonly queryType: string;
  readonly currentBalance: Balance | null;

  constructor(input: {
    balances: Balance[];
    queryType: string;
    currentBalance: Balance | null;
    message?: string;
  }) {
    super('not_enough_queries', input.message ?? 'Not enough queries', {
      status: 402
    });
    this.name = 'QuotaExceededError';
    this.balances = input.balances;
    this.queryType = input.queryType;
    this.currentBalance = input.currentBalance;
  }
}
