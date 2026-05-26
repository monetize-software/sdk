import {
  AuthClient,
  type AuthChangeEvent,
  type AuthClientOptions,
  type AuthSession
} from '../core/auth';
import { BillingClient, type BillingClientOptions } from '../core/BillingClient';
import { EventTracker } from '../core/EventTracker';
import { createTrialStore, type TrialStore } from '../core/trial';
import {
  PaywallError,
  type Acquiring,
  type Identity,
  type PaywallBootstrap,
  type PaywallPrice,
  type PaywallUser,
  type TrialConfig,
  type TrialStatus,
  type UserLanguageInfo,
  type VisibilityStatus
} from '../core/types';
import { mountShadow, type MountHandle } from './mount';
import {
  PaywallRoot,
  type PaywallRootProps,
  type PaywallStateSnapshot,
  type PaywallView
} from './PaywallRoot';
import { UserWatcher, shouldRunUserWatcher } from './UserWatcher';

type PaywallStateListener = (state: PaywallStateSnapshot) => void;

const CLOSED_STATE: PaywallStateSnapshot = { open: false, view: null, error: null };

// Контракт событий SDK. Клиент подписывается через paywall.on(event, handler).
// Каждый event строго типизирован — IDE даёт автокомплит на payload.
export interface PaywallEventPayloads {
  /** Модалка открыта (запрос на открытие — данные могут ещё грузиться). */
  open: void;
  /** Модалка закрыта. */
  close: void;
  /** Bootstrap загружен, модалка показывает контент. Подходит для impression-метрик. */
  ready: PaywallBootstrap;
  /** Любая ошибка SDK (bootstrap, checkout). */
  error: PaywallError;
  /** Юзер выбрал тариф (клик по плану), ещё не инициировал checkout. */
  price_selected: { priceId: string; price: PaywallPrice };
  /** Checkout URL получен с бэка и открыт в новой вкладке. `acquiring` —
   *  имя платёжного процессора, на который ушёл checkout (для конверсии
   *  по эквайрингам в host-аналитике). */
  checkout_started: { priceId: string; url: string; acquiring?: Acquiring };
  /** Юзер вернулся с успешной оплатой (через URL-маркеры или postMessage),
   *  либо после signIn / попытки checkout-а выяснилось, что подписка уже
   *  активна (`restored: true`). priceId = null когда payment-интент не
   *  был привязан к конкретной цене (UserWatcher-tick, restore-flow). */
  purchase_completed: {
    priceId: string | null;
    sessionId: string | null;
    /** true — это не свежая оплата, а активная подписка, которую SDK обнаружил
     *  и показал juзеру success/restored view. Hostу полезно различать (для
     *  metrics — «restore» vs «new purchase»). */
    restored?: boolean;
  };
  /** Юзер вернулся с ошибкой/cancel от провайдера. */
  purchase_failed: { reason: string | null };
  /** User-state изменился (bootstrap snapshot, getUser refresh, watcher tick).
   *  Дёргается также сразу с last-known user после первой подписки. */
  userChange: PaywallUser;
  /** Auth-session изменилась. Payload содержит `event` (см. AuthChangeEvent —
   *  INITIAL_SESSION / SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED / USER_UPDATED /
   *  PASSWORD_RECOVERY) и `session` (null = разлогинен).
   *
   *  Гарантированный контракт: первый callback каждому subscriber'у — всегда
   *  INITIAL_SESSION с восстановленной из storage сессией (или null если нет).
   *  Дальше — реальные переходы. Listener'у с побочными эффектами вроде
   *  force-refetch balances ловить SIGNED_IN, а не любой truthy session,
   *  иначе reload страницы будет триггерить лишний запрос. */
  authChange: { event: AuthChangeEvent; session: AuthSession | null };
  /** Триал заблокировал показ модалки. payload содержит свежий статус (после
   *  recordBlock). Для `mode: 'time'` — startedAt/expiresAt/remainingMs;
   *  для `mode: 'opens'` — remainingActions/totalActions. Хост может
   *  использовать payload для показа собственного UI («осталось 3 показа»). */
  trial_blocked: TrialStatus;
  /** Триал истёк, паывол показывается впервые после истечения. Эмитится
   *  раз за жизнь PaywallUI-инстанса (не персистится между перезагрузками
   *  страницы — на каждом page-load событие может стрельнуть один раз). */
  trial_expired: void;
  /** Targeting не сошёлся — паывол не открывается. payload содержит
   *  server-computed snapshot из bootstrap (visible=false + reason + country +
   *  tier). Хост может показать собственный fallback («сервис недоступен в
   *  вашей стране») или просто залогировать impression для аналитики. */
  visibility_blocked: VisibilityStatus;
}

export type PaywallEvent = keyof PaywallEventPayloads;

export type PaywallEventHandler<E extends PaywallEvent = PaywallEvent> = (
  payload: PaywallEventPayloads[E]
) => void;

// Вспомогательный тип: `void` payload эмитится без аргумента (`emit('open')`),
// непустой — с аргументом (`emit('ready', bootstrap)`).
type EmitArgs<E extends PaywallEvent> = PaywallEventPayloads[E] extends void
  ? []
  : [PaywallEventPayloads[E]];

export interface AnalyticsOptions {
  enabled?: boolean;
  /** Полный URL до /events. По умолчанию — `${apiOrigin}/api/v1/paywall/${id}/events`. */
  endpoint?: string;
  flushIntervalMs?: number;
  maxBufferSize?: number;
  /** Тестовый override fetch'а (jsdom/Vitest). */
  fetch?: typeof fetch;
  /** Тестовый override sendBeacon'а. */
  sendBeacon?: (url: string, data: BodyInit) => boolean;
}

/**
 * Managed-auth конфиг. Передай `auth: true` — PaywallUI создаёт `AuthClient`
 * сам (с тем же `paywallId/apiOrigin/storage`, как BillingClient). Передай
 * объект — те же дефолты + override опций. Передай готовый `AuthClient` —
 * PaywallUI просто прокинет его в BillingClient (полезно, если хост хочет
 * иметь общий AuthClient на несколько пейволов / делать manual signIn/signOut
 * из своего UI до открытия модалки).
 *
 * Без `auth` опции SDK работает в hybrid-режиме: identity передаётся снаружи
 * через `opts.identity` или `paywall.open({identity})`.
 */
export type AuthOption = true | AuthClient | Partial<Omit<AuthClientOptions, 'paywallId'>>;

export interface PaywallUIOptions extends Omit<BillingClientOptions, 'auth'> {
  client?: BillingClient;
  host?: HTMLElement;
  /** Подключить managed-auth слой. См. {@link AuthOption}. */
  auth?: AuthOption;
  /**
   * Автоматически парсить URL при создании PaywallUI, чтобы поймать возврат
   * с checkout-провайдера (?paywall_status=paid|failed|cancelled). Дефолт: true.
   * Эмитит purchase_completed / purchase_failed через microtask — подпишись синхронно.
   */
  autoDetectReturn?: boolean;
  /**
   * Режим shadow DOM. По умолчанию `closed` — полная изоляция от хоста.
   * Для e2e тестов (Playwright) и live-preview в админке передавать `open`.
   */
  shadowMode?: 'open' | 'closed';
  /**
   * Аналитика SDK 3.0. По умолчанию включена. Передай `false` для полного
   * отключения (ничего не шлётся на бэк). Принимает объект с настройками
   * batch'а или endpoint-override.
   */
  analytics?: boolean | AnalyticsOptions;
  /**
   * Когда bootstrap не в кеше — модалку рендерить **сразу** со спиннером и
   * прогонять gates (visibility/trial) после получения данных, или **ждать**
   * bootstrap и монтировать только если gates прошли. Дефолт `true` —
   * snappy open, кнопка «открыть» отзывается мгновенно.
   *
   * Trade-off: при `true` и блокирующем gate'е модалка моргнёт (открылась
   * → закрылась через ~200-500мс). На extension'ах и сайтах с включённым
   * targeting-fallback'ом это редкий путь, поэтому дефолт оптимизирован
   * под основной 99%-кейс. Передай `false`, если для вашего use-case'а
   * флеш на blocked-странах/устройствах хуже воспринимаемой латентности.
   */
  mountThenLoad?: boolean;
  /**
   * Inline-режим для live-preview редактора админки. Host позиционируется
   * `absolute inset:0` внутри родителя (вместо fixed-viewport'а), overlay
   * Modal'а тоже становится absolute, body-scroll не лочится. ОБЯЗАТЕЛЬНО
   * передавать `host` (HTMLElement) с positioned parent'ом — иначе absolute
   * уйдёт к ближайшему positioned ancestor'у или к html. По умолчанию false.
   *
   * @internal Admin-only: используется в редакторе пейволов monetize.software
   * для live-preview. Конечным интеграторам SDK включать не нужно — модалка
   * сольётся с host'овым layout'ом вместо fullscreen-overlay'я.
   */
  inline?: boolean;
  /**
   * Explicit-override языка для I18nProvider. Используется live-preview
   * редактором админки («Preview as user from <country>») — там browser-locale
   * всегда EN, а нужно показать как для юзера из выбранной страны. Принимает
   * BCP-47 base-tag из `BUNDLED_LOCALES` (ru/de/fr/…); EN, null, undefined —
   * fallback на обычную резолв-логику (navigator.language → locale_default).
   *
   * Live-обновление — через {@link PaywallUI.setLocale}.
   *
   * @internal Admin-only: для конечных интеграторов нет смысла форсить язык —
   * SDK сам подстраивается под browser-locale.
   */
  locale?: string | null;
}

/**
 * Результат `paywall.getAccess()` — отвечает на главный вопрос хоста: «нужно
 * ли блокировать фичу для этого юзера?». Без побочных эффектов: на trial-storage
 * `recordBlock` не вызывается (счётчики не двигаются), модалка не монтируется.
 *
 * Семантика `access`:
 *  - `granted` — фичу НЕ блокировать. Один из сценариев:
 *    - `has_subscription` — у юзера активная подписка/покупка;
 *    - `visibility_blocked` — таргетинг (страна/девайс/visibility-флаг) не
 *       сошёлся, юзер вне monetization-scope'а пейвола → монетизация неприменима;
 *    - `trial_blocked` — пре-пейвольный триал ещё активен.
 *  - `blocked` — фичу заблокировать и вызвать `paywall.open()`. Reason всегда
 *     `no_subscription`.
 *
 * Discriminated union по `access`: type-narrowing на `result.access === 'blocked'`
 * сужает `reason` до `'no_subscription'`, на `'granted'` — до трёх granted-вариантов.
 */
export type PaywallAccessResult =
  | {
      access: 'granted';
      reason: 'has_subscription' | 'visibility_blocked' | 'trial_blocked';
      visibility: VisibilityStatus | null;
      trial: TrialStatus | null;
      user: PaywallUser | null;
    }
  | {
      access: 'blocked';
      reason: 'no_subscription';
      visibility: VisibilityStatus | null;
      trial: TrialStatus | null;
      user: PaywallUser | null;
    };

export interface GetAccessOptions {
  skipTrial?: boolean;
  skipVisibility?: boolean;
  signal?: AbortSignal;
}

/** Internal-only расширение `OpenOptions` — `authMode` мы не светим в публичный
 *  API (есть dedicated `openSignin`/`openSignup`), но через private-методы
 *  плюс mountAndShow прокидываем именно тут. */
type InternalOpenOptions = OpenOptions & { authMode?: 'signin' | 'signup' };

export interface OpenOptions {
  identity?: Identity;
  /** Принудительно открыть, минуя pre-paywall trial check. По умолчанию SDK
   *  читает `bootstrap.settings.trial` и блокирует open(), пока триал активен.
   *  Эскейп-хатч для случаев типа «host решил показать всё-таки» или дев-режим. */
  skipTrial?: boolean;
  /** Принудительно открыть, минуя targeting-gate. По умолчанию SDK читает
   *  `bootstrap.settings.visibility` и эмитит `visibility_blocked` без
   *  открытия модалки, если visible=false (страна/девайс/visibility-флаг
   *  не сошлись). Эскейп-хатч для дев-отладки. */
  skipVisibility?: boolean;
  /** Renewal/upgrade flow. По умолчанию (false) SDK после bootstrap'а или
   *  signIn проверяет `user.has_active_subscription` и переключается в
   *  restored success-view, не показывая тарифы — open() для уже подписанного
   *  юзера превращается в подтверждение «у вас уже есть подписка». С
   *  `renew: true` все эти проверки пропускаются: тарифы показываются всегда,
   *  и при checkout SDK передаёт `ignoreActivePurchase: true` на бэк, чтобы
   *  /start-checkout не вернул 409. Использовать когда host-UI явно
   *  показывает кнопку «Renew»/«Upgrade plan». */
  renew?: boolean;
}

// Маркеры в URL, по которым SDK определяет результат checkout.
// Контракт общий с бэком — online добавляет их в success/cancel URLs.
const URL_MARKERS = {
  status: 'paywall_status',
  priceId: 'paywall_price_id',
  sessionId: 'paywall_session_id'
} as const;

export class PaywallUI {
  readonly billing: BillingClient;
  /** AuthClient (managed-auth) или undefined в hybrid-режиме. Доступен публично:
   *  host может вызывать `paywall.auth?.signOut()`, читать `getCachedSession()`,
   *  подписываться на `onAuthChange` напрямую. */
  readonly auth: AuthClient | undefined;
  private ownsAuth: boolean;
  private host?: HTMLElement;
  private shadowMode: 'open' | 'closed';
  private handle: MountHandle | null = null;
  private isOpen = false;
  private listeners = new Map<PaywallEvent, Set<PaywallEventHandler>>();
  private userUnsub: (() => void) | null = null;
  private authUnsub: (() => void) | null = null;
  private watcher: UserWatcher | null = null;
  private tracker: EventTracker | null = null;
  private purchased = false;
  /** Lazy-инстанс TrialStore. Резолвится при первом open(), когда уже знаем
   *  `bootstrap.settings.trial`. null — триал отключён в конфиге пейвола. */
  private trialStore: TrialStore | null = null;
  /** Конфиг, под который создан текущий trialStore — пересобираем, если он
   *  поменялся между bootstrap-фетчами (например, владелец переключил режим
   *  в админке между сессиями SDK). */
  private trialStoreConfig: TrialConfig | null = null;
  /** In-memory snapshot последнего check() — для синхронного getTrialStatus(). */
  private lastTrialStatus: TrialStatus | null = null;
  /** Флаг dedupe для `trial_expired` события в рамках жизни инстанса. */
  private trialExpiredFired = false;
  /** In-memory snapshot последнего bootstrap'а — для синхронного getVisibility(). */
  private lastVisibility: VisibilityStatus | null = null;
  /** Поведение open() при холодном bootstrap'е. См. PaywallUIOptions.mountThenLoad. */
  private mountThenLoad: boolean;
  /** Inline-режим (live-preview редактора). См. PaywallUIOptions.inline. */
  private inline: boolean;
  /** Force-locale для I18nProvider. См. PaywallUIOptions.locale. */
  private forceLocale: string | null;
  /** Текущий snapshot UI state-machine. Обновляется PaywallRoot'ом через
   *  `onState` prop; при close сбрасывается обратно в CLOSED_STATE. */
  private currentState: PaywallStateSnapshot = CLOSED_STATE;
  private stateListeners = new Set<PaywallStateListener>();

  constructor(opts: PaywallUIOptions) {
    // Резолвим AuthClient: готовый инстанс / managed-конфиг (true|object) /
    // undefined. ownsAuth=true → сами создавали и должны прибрать в destroy().
    const { auth, ownsAuth } = resolveAuth(opts);
    this.auth = auth;
    this.ownsAuth = ownsAuth;

    // Если auth есть — прокидываем в BillingClient (он сам подключит Bearer
    // и auto-sync identity через onAuthChange). client из opts побеждает —
    // считаем, что хост уже сконфигурировал его сам, не лезем перетирать auth.
    this.billing =
      opts.client ?? new BillingClient({ ...opts, auth: this.auth });
    this.host = opts.host;
    this.shadowMode = opts.shadowMode ?? 'closed';
    this.mountThenLoad = opts.mountThenLoad ?? true;
    this.inline = opts.inline === true;
    this.forceLocale = opts.locale ?? null;

    // Форвардим user-change события из BillingClient на public-API PaywallUI.
    // Один источник правды (BillingClient cache) — два consumer'а (host через
    // paywall.onUserChange и сам watcher через billing.onUserChange).
    this.userUnsub = this.billing.onUserChange((user) => {
      this.emit('userChange', user);
    });

    if (this.auth) {
      this.authUnsub = this.auth.onAuthChange((event, session) => {
        this.emit('authChange', { event, session });
      });
    }

    this.initTracker(opts.analytics);

    if (opts.autoDetectReturn !== false && typeof window !== 'undefined') {
      // Microtask — клиент успевает подписаться синхронно после конструктора,
      // до того как событие действительно стрельнёт.
      queueMicrotask(() => this.checkReturn());
    }
  }

  private initTracker(analytics: PaywallUIOptions['analytics']): void {
    if (analytics === false) return;
    const cfg: AnalyticsOptions =
      typeof analytics === 'object' && analytics !== null ? analytics : {};
    if (cfg.enabled === false) return;

    const endpoint =
      cfg.endpoint ?? `${this.billing.apiOrigin}/api/v1/paywall/${this.billing.paywallId}/events`;

    this.tracker = new EventTracker({
      endpoint,
      paywallId: this.billing.paywallId,
      capabilities: this.billing.capabilities,
      getVisitorId: () => this.billing.getVisitorId(),
      getCachedVisitorId: () => this.billing.getCachedVisitorId(),
      getUserId: () => this.billing.getIdentity()?.userId ?? null,
      flushIntervalMs: cfg.flushIntervalMs,
      maxBufferSize: cfg.maxBufferSize,
      fetch: cfg.fetch,
      sendBeacon: cfg.sendBeacon
    });

    // Биндим внутренние SDK-события на аналитический транспорт. Один эмиттер,
    // один потребитель (трекер) — никто кроме трекера не должен трогать
    // эти имена событий за пределами PaywallUI.
    this.on('open', () => this.tracker?.track('paywall_opened'));
    this.on('ready', (b) =>
      this.tracker?.track('paywall_viewed', {
        is_test_mode: b.settings.is_test_mode,
        prices_count: b.prices.length,
        offers_count: b.offers.length
      })
    );
    this.on('price_selected', (p) =>
      this.tracker?.track('price_selected', { price_id: p.priceId })
    );
    this.on('checkout_started', (p) =>
      this.tracker?.track('checkout_started', {
        price_id: p.priceId,
        acquiring: p.acquiring
      })
    );
    this.on('purchase_completed', (p) =>
      this.tracker?.track('purchase_completed', {
        price_id: p.priceId,
        session_id: p.sessionId
      })
    );
    this.on('purchase_failed', (p) =>
      this.tracker?.track('purchase_failed', { reason: p.reason })
    );
    this.on('close', () => this.tracker?.track('paywall_closed'));
    this.on('trial_blocked', (s) =>
      this.tracker?.track('trial_blocked', {
        mode: s.mode,
        ...(s.mode === 'time'
          ? { remaining_ms: s.remainingMs, total_ms: s.totalMs }
          : s.mode === 'opens'
            ? { remaining_actions: s.remainingActions, total_actions: s.totalActions }
            : {})
      })
    );
    this.on('trial_expired', () => this.tracker?.track('trial_expired'));
    this.on('visibility_blocked', (v) =>
      this.tracker?.track('visibility_blocked', {
        reason: v.reason,
        country: v.country,
        tier: v.tier
      })
    );
    this.on('error', (e) =>
      this.tracker?.track('error', { code: e.code, message: e.message })
    );
    // auth_signin_success / auth_signout пока не фаерим: authChange эмитится
    // и на гидрации сессии (UI поднимает кеш из storage), и на token refresh,
    // и при параллельных consumer'ах одного auth-state — даёт ложные signin'ы.
    // Реальные login-события нужно ловить через прямые вызовы
    // signInWithEmail/signUp/signInWithOAuth/signOut, а не через authChange.
  }

  /**
   * Отправить произвольное аналитическое событие. Имена из системного whitelist'а
   * (`app_opened`, `paywall_viewed`, ...) разрешены как есть. Кастомные —
   * с префиксом `host:` (например `host:user_clicked_upgrade`). Сервер
   * дропает события с неразрешёнными именами.
   *
   * Самый частый кейс — `track('app_opened')` от хоста сразу после загрузки
   * приложения, чтобы зафиксировать воронку до открытия пейвола.
   */
  track(name: string, props?: Record<string, unknown>): void {
    this.tracker?.track(name, props);
  }

  /**
   * Удобный шорткат вместо `paywall.on('userChange', cb)` — самый частый
   * паттерн в host-коде, поэтому отдельный named метод. Колбек получает
   * last-known user из кеша синхронно через microtask, если он есть.
   */
  onUserChange(handler: PaywallEventHandler<'userChange'>): () => void {
    return this.on('userChange', handler);
  }

  /**
   * Заменить cachedBootstrap живыми данными — для preview-режима в редакторе
   * админки. Если модалка открыта, PaywallRoot подписан на onBootstrapChange
   * и перерендерится мгновенно. До open() — затравка для bootstrap()-effect'а.
   *
   * См. {@link BillingClientOptions.preview} — обычно эту опцию ставят на
   * клиент, чтобы заодно отключить сетевой revalidate. setBootstrap технически
   * работает и в production-режиме, но конкуренция с revalidate'ом из сети
   * почти всегда нежелательна.
   */
  setBootstrap(partial: Partial<PaywallBootstrap>): void {
    this.billing.setBootstrap(partial);
  }

  /**
   * Сменить force-locale на лету — для live-preview редактора админки, когда
   * юзер переключает «Preview as user from <country>». Грузит соответствующий
   * static-чанк и форсит re-render через handle.update. См. PaywallUIOptions.locale.
   *
   * Передай `null`/`undefined`, чтобы вернуть автоматическую резолв-логику
   * (navigator.language → locale_default).
   */
  setLocale(locale: string | null | undefined): void {
    const next = locale ?? null;
    if (next === this.forceLocale) return;
    this.forceLocale = next;
    // handle есть, только если модалка открыта; иначе locale подхватится на
    // следующем mountAndShow() из сохранённого this.forceLocale.
    if (this.handle) {
      this.handle.update({ locale: next });
    }
  }

  on<E extends PaywallEvent>(event: E, handler: PaywallEventHandler<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as PaywallEventHandler);
    return () => set!.delete(handler as PaywallEventHandler);
  }

  off<E extends PaywallEvent>(event: E, handler: PaywallEventHandler<E>): void {
    this.listeners.get(event)?.delete(handler as PaywallEventHandler);
  }

  private emit<E extends PaywallEvent>(event: E, ...args: EmitArgs<E>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    const payload = args[0] as PaywallEventPayloads[E];
    for (const handler of set) {
      try {
        (handler as PaywallEventHandler<E>)(payload);
      } catch (error) {
        if (typeof console !== 'undefined') console.error('[paywall] listener error', error);
      }
    }
  }

  open(opts: OpenOptions = {}): void {
    this.openInternal('layout', opts);
  }

  /**
   * Прогревает bootstrap-кеш и balance-кеш заранее, без открытия модалки.
   * Полезно когда host знает, что юзер скоро откроет paywall (hover на CTA,
   * mount компонента) — первый `open()` рендерится мгновенно, без loading-flash.
   *
   * Не throw'ает: если сеть упала, тихо игнорирует (повторный open() сделает
   * fresh-bootstrap с error-state как обычно). `signal` для отмены — например,
   * если хост размонтирует компонент быстрее, чем bootstrap вернётся.
   *
   * Вызывать можно сколько угодно раз — последующие вызовы возвращают cached
   * Promise (BillingClient уже дедуплицирует).
   */
  async preload(opts: { signal?: AbortSignal } = {}): Promise<void> {
    try {
      await this.billing.bootstrap({ signal: opts.signal });
      // Балансы — best-effort: пейволы без `tokenization` отдают пустой
      // массив, и getBalances не делает сетевого запроса для unauth-юзера.
      if (this.billing.auth) {
        await this.billing.getBalances({ signal: opts.signal });
      }
    } catch {
      /* preload best-effort — open() сам покажет error-state */
    }
  }

  /**
   * Открывает модалку сразу с саппорт-формой (минуя layout с тарифами).
   * Полезно, когда host-приложение хочет дать юзеру кнопку «Help / Support»,
   * не связанную с пейволом-апгрейдом. Back/Done в саппорт-форме закрывают
   * модалку (не возвращают к тарифам), потому что юзер пришёл сюда напрямую.
   *
   * Из обычного `paywall.open()`-flow саппорт всё равно доступен через
   * Contact Support-ссылку в `current_session`-блоке (там Back возвращает
   * к layout).
   */
  openSupport(opts: OpenOptions = {}): void {
    this.openInternal('support', opts);
  }

  /**
   * Открывает модалку сразу с auth-gate (логин/регистрация), без layout с
   * тарифами. Сценарий: returning customer уже купил, ему просто нужно
   * залогиниться, чтобы SDK подцепил его purchases. После signIn модалка
   * закрывается; Back тоже закрывает (юзер пришёл только за логином).
   *
   * Без `auth` (managed-auth не подключён) метод — no-op: некому делать
   * signIn. Если юзер уже залогинен — модалка всё равно откроется и
   * закроется через auto-resume в auth_gate effect'е (мгновение).
   *
   * Триал не блокирует этот флоу — auth не connect'ится с trial-механикой.
   */
  openAuth(opts: OpenOptions = {}): void {
    if (!this.auth) return;
    this.openInternal('auth', { ...opts, skipTrial: true });
  }

  /**
   * Шорткат над `openAuth()` — открывает модалку сразу на signin-форме.
   * Эквивалент `openAuth()` (signin — дефолт). Существует для симметрии с
   * `openSignup()` и читаемости host-кода:
   *   - `paywall.openSignin()` — «вход в существующий аккаунт»
   *   - `paywall.openSignup()` — «новая регистрация»
   * Без managed-auth — no-op.
   */
  openSignin(opts: OpenOptions = {}): void {
    if (!this.auth) return;
    this.openInternal('auth', { ...opts, skipTrial: true, authMode: 'signin' });
  }

  /**
   * Открывает модалку с auth-gate сразу в режиме регистрации (signup-mode
   * AuthPanel'а — email/password/repeat). Если в paywall layout админ
   * отключил allow_signup, AuthPanel игнорит mode и стартует с signin —
   * соблюдается admin-конфиг.
   * Без managed-auth — no-op.
   */
  openSignup(opts: OpenOptions = {}): void {
    if (!this.auth) return;
    this.openInternal('auth', { ...opts, skipTrial: true, authMode: 'signup' });
  }

  /**
   * Headless anonymous signin без открытия модалки. Внутри:
   * idempotent (если уже анон — instant return) → resume через сохранённый
   * refresh_token → fresh /auth/anonymous/signin. Дедуплицирует
   * параллельные вызовы внутри AuthClient'а.
   *
   * Удобно для host-кнопок типа «Continue as guest» — host сам управляет
   * loading-стейтом на своей кнопке, без полупустой модалки со спиннером.
   * Без managed-auth — резолвится rejected promise'ом (нет AuthClient'а
   * чтобы делать signin).
   */
  signInAnonymously(): Promise<AuthSession> {
    if (!this.auth) {
      return Promise.reject(
        new PaywallError(
          'invalid_config',
          'signInAnonymously requires managed-auth. Pass `auth: true` to PaywallUI.'
        )
      );
    }
    return this.auth.signInAnonymously();
  }

  private openInternal(view: PaywallView, opts: InternalOpenOptions): void {
    if (opts.identity) this.billing.setIdentity(opts.identity);
    // Сбрасываем флаг success-вью — повторное открытие должно стартовать
    // с обычного layout, а не с прошлого "Payment received".
    this.purchased = false;

    // support и auth-standalone флоу обходят оба гейта (триал и таргетинг):
    // юзер пришёл за саппортом или за логином к уже купленной подписке —
    // блокировать его по trial-stage'у или таргетингу неуместно. openAuth
    // дополнительно передаёт skipTrial:true для совместимости с прежней
    // семантикой; здесь skip-флаги нормализуем единообразно.
    const skipTrial = opts.skipTrial === true || view === 'support';
    const skipVisibility =
      opts.skipVisibility === true ||
      view === 'support' ||
      view === 'auth';
    const renew = opts.renew === true;

    if (skipTrial && skipVisibility) {
      this.mountAndShow(view, { renew, authMode: opts.authMode });
      return;
    }

    // Cache hit — sync путь, gates до mount как раньше. Никаких компромиссов:
    // когда bootstrap уже в памяти, мы знаем за один tick можно открывать
    // или нет, без флеша.
    const cached = this.billing.getCachedBootstrap();
    if (cached) {
      this.runOpenGates(view, cached, { skipTrial, skipVisibility, renew });
      return;
    }

    // Cold bootstrap. Два режима:
    //
    // mountThenLoad=true (default): монтируем модалку немедленно — юзер видит
    //   спиннер, кнопка отзывается мгновенно. Bootstrap идёт параллельно.
    //   Когда придёт — гоняем gates, и если блокирует, закрываем модалку с
    //   эмиссией *_blocked. Цена — флеш «открылась → закрылась» в редком
    //   случае visibility/trial-блока. Для extension'ов и сайтов с включённым
    //   targeting'ом большинство open()'ов проходят, флеш — edge case.
    //
    // mountThenLoad=false (legacy): ждём bootstrap до mount'а. Гарантия
    //   отсутствия флеша на блоке, но кнопка кажется «мёртвой» 200-500мс
    //   на холодном кеше.
    if (this.mountThenLoad) {
      this.mountAndShow(view, { renew });
      this.billing
        .bootstrap()
        .then((b) => this.runDelayedGates(b, { skipTrial, skipVisibility }))
        .catch(() => {
          // Bootstrap упал — модалка уже открыта, PaywallRoot сам в error-state.
        });
      return;
    }

    this.billing
      .bootstrap()
      .then((b) => this.runOpenGates(view, b, { skipTrial, skipVisibility, renew }))
      .catch(() => {
        // Bootstrap упал — открываем без gates; PaywallRoot покажет error.
        this.mountAndShow(view, { renew });
      });
  }

  /** Применить gates ПОСЛЕ того, как модалка уже смонтирована (mount-then-load
   *  путь). Если gate блокирует — close() + emit. Если юзер уже сам закрыл
   *  модалку до резолва bootstrap'а — no-op (isOpen=false). */
  private runDelayedGates(
    bootstrap: PaywallBootstrap,
    flags: { skipTrial: boolean; skipVisibility: boolean }
  ): void {
    if (!this.isOpen) return;

    if (!flags.skipVisibility) {
      const v = bootstrap.settings.visibility;
      if (v) {
        this.lastVisibility = v;
        if (!v.visible) {
          this.close();
          this.emit('visibility_blocked', v);
          return;
        }
      }
    }

    if (flags.skipTrial) return;

    const trialCfg = bootstrap.settings.trial;
    if (!trialCfg) return;
    const store = this.ensureTrialStore(trialCfg);
    void store
      .check()
      .then(async (status) => {
        if (!this.isOpen) return;
        this.lastTrialStatus = status;
        if (status.mode === 'none') return;
        if (status.blocked) {
          const updated = await store.recordBlock();
          this.lastTrialStatus = updated;
          if (!this.isOpen) return;
          this.close();
          this.emit('trial_blocked', updated);
          return;
        }
        if (!this.trialExpiredFired) {
          this.trialExpiredFired = true;
          this.emit('trial_expired');
        }
      })
      .catch((e) => {
        if (typeof console !== 'undefined') console.warn('[paywall] trial check failed', e);
      });
  }

  // Порядок гейтов: visibility → trial. Country-mismatch ≠ trial-block, и
  // вести trial-стейт «осталось N показов» под юзером, который вообще не
  // должен увидеть пейвол по таргетингу — бессмысленно: при возврате в
  // правильную страну он окажется со «слипшимся» триал-счётчиком.
  private runOpenGates(
    view: PaywallView,
    bootstrap: PaywallBootstrap,
    flags: { skipTrial: boolean; skipVisibility: boolean; renew: boolean }
  ): void {
    if (!flags.skipVisibility) {
      const v = bootstrap.settings.visibility;
      if (v) {
        this.lastVisibility = v;
        if (!v.visible) {
          this.emit('visibility_blocked', v);
          return;
        }
      }
    }

    if (flags.skipTrial) {
      this.mountAndShow(view, { renew: flags.renew });
      return;
    }
    this.gateThroughTrial(view, bootstrap, flags.renew);
  }

  private gateThroughTrial(view: PaywallView, bootstrap: PaywallBootstrap, renew: boolean): void {
    const trialCfg = bootstrap.settings.trial;
    if (!trialCfg) {
      this.mountAndShow(view, { renew });
      return;
    }
    const store = this.ensureTrialStore(trialCfg);
    void store
      .check()
      .then(async (status) => {
        this.lastTrialStatus = status;
        if (status.mode === 'none') {
          this.mountAndShow(view, { renew });
          return;
        }
        if (status.blocked) {
          // recordBlock делает запись (init firstOpen / inc skipTimes) и
          // возвращает обновлённый snapshot — его и эмитим, чтобы хост
          // получил актуальный счётчик.
          const updated = await store.recordBlock();
          this.lastTrialStatus = updated;
          this.emit('trial_blocked', updated);
          return;
        }
        // Триал в конфиге, но не блокирует → истёк. Эмитим один раз за
        // сессию, дальше открываем как обычно.
        if (!this.trialExpiredFired) {
          this.trialExpiredFired = true;
          this.emit('trial_expired');
        }
        this.mountAndShow(view, { renew });
      })
      .catch((e) => {
        // Storage недоступен (privacy mode, quota) — не блокируем юзера,
        // открываем модалку и не теряем продажу.
        if (typeof console !== 'undefined') console.warn('[paywall] trial check failed', e);
        this.mountAndShow(view, { renew });
      });
  }

  private ensureTrialStore(config: TrialConfig): TrialStore {
    if (this.trialStore && this.trialStoreConfig && sameTrialConfig(this.trialStoreConfig, config)) {
      return this.trialStore;
    }
    this.trialStoreConfig = config;
    // Duck-type: если billing-клиент предоставляет свой factory (extension'овский
    // RemoteBillingClient — атомарный TrialStore через offscreen + navigator.locks),
    // используем его. Иначе — обычный path через storage-adapter.
    const factoryFn = (this.billing as { createTrialStore?: (cfg: TrialConfig) => TrialStore })
      .createTrialStore;
    this.trialStore =
      typeof factoryFn === 'function'
        ? factoryFn.call(this.billing, config)
        : createTrialStore(this.billing.getStorage(), this.billing.paywallId, config);
    return this.trialStore;
  }

  private mountAndShow(
    view: PaywallView,
    mountOpts: { renew?: boolean; authMode?: 'signin' | 'signup' } = {}
  ): void {
    const renew = mountOpts.renew === true;
    const initialAuthMode = mountOpts.authMode;
    if (this.handle) {
      this.isOpen = true;
      this.handle.update({
        open: true,
        initialView: view,
        initialAuthMode,
        purchased: false,
        renew
      });
      this.emit('open');
      return;
    }

    this.isOpen = true;
    this.handle = mountShadow<PaywallRootProps>(
      PaywallRoot,
      {
        client: this.billing,
        open: true,
        initialView: view,
        initialAuthMode,
        purchased: false,
        renew,
        onClose: () => this.close(),
        onEvent: (event, payload) => {
          this.emit(event as PaywallEvent, payload as never);
          // Поднимаем watcher как только начался checkout — отсюда уже
          // полагаемся на server-confirmed flow, а не URL-маркеры.
          if (event === 'checkout_started') this.startUserWatcher();
        },
        onState: (snapshot) => this.applyState(snapshot),
        inline: this.inline,
        locale: this.forceLocale
      },
      { host: this.host, shadowMode: this.shadowMode, inline: this.inline }
    );
    this.emit('open');
  }

  private applyState(snapshot: PaywallStateSnapshot): void {
    if (sameStateSnapshot(this.currentState, snapshot)) return;
    this.currentState = snapshot;
    for (const cb of this.stateListeners) {
      try {
        cb(snapshot);
      } catch (e) {
        console.warn('[paywall] onStateChange listener threw', e);
      }
    }
  }

  /**
   * Sync-snapshot текущего состояния модалки. Подходит для `useSyncExternalStore`
   * в React (`useSyncExternalStore(paywall.onStateChange, paywall.getState)`)
   * и для одноразовых проверок («открыт ли пейвол сейчас?»).
   *
   * Snapshot стабилен — пока state не изменился, повторный getState() вернёт
   * `===`-равный объект (важно для useSyncExternalStore чтобы не ре-рендерить).
   */
  getState(): PaywallStateSnapshot {
    return this.currentState;
  }

  /**
   * Подписка на изменения state. Колбек вызывается при каждом реальном
   * изменении (closed → loading → ready → ...). По умолчанию initial snapshot
   * отдаётся через microtask после подписки; через `{immediate: 'sync'|'none'}`
   * можно сделать sync-доставку (для useSyncExternalStore — там она не нужна,
   * snapshot читается через getSnapshot отдельно) или вовсе пропустить
   * initial.
   *
   * Возвращает unsubscribe.
   */
  onStateChange(
    cb: PaywallStateListener,
    opts: { immediate?: 'microtask' | 'sync' | 'none' } = {}
  ): () => void {
    this.stateListeners.add(cb);
    const mode = opts.immediate ?? 'microtask';
    if (mode !== 'none') {
      const snapshot = this.currentState;
      if (mode === 'sync') {
        try {
          cb(snapshot);
        } catch (e) {
          console.warn('[paywall] onStateChange initial sync threw', e);
        }
      } else {
        queueMicrotask(() => {
          if (this.stateListeners.has(cb)) cb(snapshot);
        });
      }
    }
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  /** Sync-доступ к последнему известному статусу триала. null — `paywall.open()`
   *  ещё не вызывался либо триал отключён в конфиге пейвола. Удобно для
   *  собственного UI хоста («осталось 3 показа», «триал истечёт через 2ч»). */
  getTrialStatus(): TrialStatus | null {
    return this.lastTrialStatus;
  }

  /** Sync-доступ к последнему server-computed visibility-статусу. null —
   *  bootstrap ещё не загружен или сервер не отдаёт `settings.visibility`
   *  (например, старая версия online без targeting-патча). Хост может
   *  использовать для собственного fallback'а: «сервис недоступен в вашей
   *  стране». Обновляется на каждом open(), который проходит через gate. */
  getVisibility(): VisibilityStatus | null {
    return this.lastVisibility;
  }

  /**
   * Цены пейвола — шорткат над `bootstrap()`. Локали уже применены, кэш и
   * stale-while-revalidate идентичны `billing.bootstrap()`. Подходит для
   * pricing-страниц/карточек на сайте, где host хочет показать те же цены,
   * что и в модалке, не вытаскивая bootstrap руками.
   */
  getPrices(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<PaywallPrice[]> {
    return this.billing.getPrices(opts);
  }

  /** Sync-снимок цен. null — bootstrap ещё не загружали. */
  getCachedPrices(): PaywallPrice[] | null {
    return this.billing.getCachedPrices();
  }

  /** Снимок текущего «языка юзера» — proxy над `billing.getUserLanguage()`.
   *  Используй, чтобы синхронизировать i18n host'а с тем, что фактически
   *  показывает пейвол. См. подробности в `BillingClient.getUserLanguage`. */
  getUserLanguage(): UserLanguageInfo {
    return this.billing.getUserLanguage();
  }

  /**
   * Решает, нужно ли блокировать фичу для текущего юзера. Без побочных эффектов
   * (на trial-storage `recordBlock` не вызывается, модалка не монтируется).
   *
   * Порядок проверок (первый сработавший — финальный):
   *  1. `has_active_subscription` — самый сильный сигнал, перебивает остальные.
   *     Юзер с подпиской получает доступ независимо от visibility/trial.
   *  2. `visibility` (страна/девайс/disabled-флаг) — юзер вне monetization-scope'а
   *     пейвола, гейтить нельзя.
   *  3. `trial` — пре-пейвольный бесплатный период активен.
   *  4. Иначе — `blocked`, host лочит фичу и зовёт `paywall.open()`.
   *
   * Bootstrap кешируется в BillingClient — `getAccess()` можно дёргать на
   * каждый рендер host-компонента, /bootstrap не дублируется. При упавшей сети
   * fallback на persistent-cached user из storage: юзер с прошлой подпиской
   * получает `granted` офлайн, иначе `blocked` (host покажет пейвол с
   * error-state, юзер сможет ретрайнуть). Side-эффект: обновляются
   * `lastVisibility` / `lastTrialStatus`, чтобы синхронные геттеры
   * `getVisibility()` / `getTrialStatus()` видели свежие данные после первого
   * `getAccess()`, а не только после первого `open()`.
   */
  async getAccess(opts: GetAccessOptions = {}): Promise<PaywallAccessResult> {
    let bootstrap = this.billing.getCachedBootstrap();
    if (!bootstrap) {
      try {
        bootstrap = await this.billing.bootstrap({ signal: opts.signal });
      } catch {
        // Сеть упала. Fallback на persistent-cached user (TTL 30 мин в storage).
        // Юзер с прошлой подпиской → granted (офлайн-friendly), иначе → blocked
        // (open() покажет пейвол с error-state, юзер ретрайнет).
        const cached = this.billing.getCachedUser();
        if (cached?.has_active_subscription) {
          return {
            access: 'granted',
            reason: 'has_subscription',
            visibility: null,
            trial: null,
            user: cached
          };
        }
        return {
          access: 'blocked',
          reason: 'no_subscription',
          visibility: null,
          trial: null,
          user: cached
        };
      }
    }

    const user = bootstrap.user ?? null;

    if (user?.has_active_subscription) {
      return {
        access: 'granted',
        reason: 'has_subscription',
        visibility: bootstrap.settings.visibility ?? null,
        trial: null,
        user
      };
    }

    let visibility: VisibilityStatus | null = null;
    if (!opts.skipVisibility) {
      const v = bootstrap.settings.visibility;
      if (v) {
        visibility = v;
        this.lastVisibility = v;
        if (!v.visible) {
          return { access: 'granted', reason: 'visibility_blocked', visibility, trial: null, user };
        }
      }
    }

    let trial: TrialStatus | null = null;
    if (!opts.skipTrial) {
      const trialCfg = bootstrap.settings.trial;
      if (trialCfg) {
        try {
          const store = this.ensureTrialStore(trialCfg);
          trial = await store.check();
          this.lastTrialStatus = trial;
          if (trial.blocked) {
            return { access: 'granted', reason: 'trial_blocked', visibility, trial, user };
          }
        } catch (e) {
          if (typeof console !== 'undefined') console.warn('[paywall] getAccess: trial check failed', e);
        }
      }
    }

    return { access: 'blocked', reason: 'no_subscription', visibility, trial, user };
  }

  /** Сбросить состояние триала в storage. Полезно для дев-режима / админ-кнопки
   *  «прогнать сценарий заново». В проде хост обычно не дёргает. */
  async resetTrial(): Promise<void> {
    if (!this.trialStore) return;
    await this.trialStore.reset();
    this.lastTrialStatus = null;
    this.trialExpiredFired = false;
  }

  // Запускает polling user-state до has_active_subscription=true либо до
  // таймаута. Идемпотентен: повторный вызов на уже работающем watcher'е —
  // no-op (юзер мог нажать Continue повторно после возврата).
  //
  // В extension popup runtime — no-op (popup не доживёт). Там полагаемся на
  // bootstrap при следующем открытии.
  private startUserWatcher(): void {
    if (this.watcher) return;
    if (!shouldRunUserWatcher()) return;

    this.watcher = new UserWatcher({
      client: this.billing,
      onActive: (user) => {
        this.watcher = null;
        // Серверная правда — эмитим финальный purchase_completed
        // (server-confirmed), чтобы host получил согласованный сигнал
        // независимо от того, был ли URL-маркер. userChange эмитит сам
        // billing-listener.
        this.emit('purchase_completed', { priceId: null, sessionId: null });
        // success_redirect_url из settings — host явно попросил отправить
        // юзера в свой apps-flow после оплаты. Редирект имеет приоритет
        // над PurchaseSuccessView: рисовать success ради 200мс перед
        // переходом — мерцание. Берём snapshot из cached bootstrap
        // (он гарантированно загружен — иначе watcher не запустился бы).
        const redirect = this.billing
          .getCachedBootstrap()
          ?.settings.success_redirect_url;
        if (redirect && typeof window !== 'undefined') {
          try {
            window.location.assign(redirect);
            return;
          } catch {
            /* navigation заблокирована — fallback на success-view */
          }
        }
        // Если пейвол открыт — переключаем во вью «Payment received» с
        // кнопкой Continue. Молчаливое закрытие сбивало юзера с толку:
        // окно просто исчезало, без подтверждения, что оплата прошла.
        // Если пейвол закрыт — событие уже эмитнуто, host решит сам.
        if (this.isOpen && this.handle) {
          this.purchased = true;
          this.handle.update({ purchased: true });
        }
        void user; // shape доступен через paywall.billing.getCachedUser()
      },
      onTimeout: () => {
        this.watcher = null;
      }
    });
    this.watcher.start();
  }

  close(): void {
    if (!this.isOpen || !this.handle) return;
    this.isOpen = false;
    this.purchased = false;
    this.handle.update({ open: false, purchased: false });
    // PaywallRoot эмитит onState с open=false при handle.update, но из-за
    // microtask'ов хост может прочитать getState() до того, как PaywallRoot
    // useEffect отстреляет. Применяем закрытое состояние сразу.
    this.applyState(CLOSED_STATE);
    this.emit('close');
  }

  /**
   * Сканирует текущий URL на маркеры возврата с checkout и эмитит
   * purchase_completed / purchase_failed. Маркеры удаляются из URL
   * через history.replaceState. Ищет и в hash, и в search (hash приоритетнее —
   * защита от клиентских SPA-роутеров, перехватывающих query).
   */
  checkReturn(): void {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);

    const hashMarkers = parseMarkers(url.hash.replace(/^#/, ''));
    const searchMarkers = parseMarkers(url.search.replace(/^\?/, ''));
    const markers = hashMarkers ?? searchMarkers;
    if (!markers) return;

    if (markers.status === 'paid') {
      this.emit('purchase_completed', {
        priceId: markers.priceId,
        sessionId: markers.sessionId
      });
      // Acceleration: если страница загружена в новой вкладке от исходного
      // приложения (typical Stripe success_url flow), шлём opener'у postMessage.
      // Watcher в исходной вкладке среагирует мгновенно, не дожидаясь focus
      // event. Если opener'а нет (юзер закрыл/не было) — fallback на polling.
      notifyOpenerOfPurchase(markers);
    } else if (markers.status === 'failed' || markers.status === 'cancelled') {
      this.emit('purchase_failed', { reason: markers.status });
    }

    stripMarkersFromUrl(url);
  }

  destroy(): void {
    this.tracker?.destroy();
    this.tracker = null;
    this.listeners.clear();
    this.stateListeners.clear();
    this.watcher?.stop();
    this.watcher = null;
    this.userUnsub?.();
    this.userUnsub = null;
    this.authUnsub?.();
    this.authUnsub = null;
    // Если AuthClient был передан хостом — его жизненный цикл не наш,
    // ничего не дёргаем. Если создавали мы — отписываемся через BillingClient
    // (он сам держит listener на onAuthChange) и оставляем session в storage,
    // чтобы следующее открытие подхватило её через hydrate.
    if (this.ownsAuth && this.auth) {
      // Если AuthClient создавали мы — destroy сами, чтобы snapshot listener
      // отписался и не висел дальше. Externally-supplied auth не трогаем.
      this.auth.destroy?.();
    }
    this.ownsAuth = false;
    this.billing.destroy?.();
    this.handle?.unmount();
    this.handle = null;
    this.isOpen = false;
    this.currentState = CLOSED_STATE;
  }
}

function resolveAuth(opts: PaywallUIOptions): {
  auth: AuthClient | undefined;
  ownsAuth: boolean;
} {
  if (!opts.auth) return { auth: undefined, ownsAuth: false };
  // Duck-typing: AuthClient ИЛИ структурный совместимец (RemoteAuthClient из
  // @monetize/sdk-extension). Проверяем по public-методам, которые
  // PaywallUI использует — если все на месте, доверяем. Это позволяет host'у
  // подставить proxy-реализацию (offscreen-architecture) без изменений в
  // PaywallUI. instanceof не подходит — runtime в content-script'е и в
  // sdk-extension'е разные, классы не nominally равны.
  if (opts.auth instanceof AuthClient || isAuthClientLike(opts.auth)) {
    return { auth: opts.auth as AuthClient, ownsAuth: false };
  }
  // true | partial-options → создаём свой AuthClient. apiOrigin/storage/fetch
  // подхватываем из общих опций PaywallUI, чтобы конфиг был "одно поле — вся
  // система". Юзер может перебить точечно через opts.auth = { apiOrigin: ... }.
  const cfg = opts.auth === true ? {} : opts.auth;
  return {
    auth: new AuthClient({
      paywallId: opts.paywallId,
      apiOrigin: cfg.apiOrigin ?? opts.apiOrigin,
      storage: cfg.storage ?? opts.storage,
      fetch: cfg.fetch ?? opts.fetch,
      openPopup: cfg.openPopup
    }),
    ownsAuth: true
  };
}

// Проверяет «AuthClient-подобность» переданного объекта по public-методам,
// которые PaywallUI трогает (`onAuthChange`, `getCachedSession`, `signOut`).
// Partial<AuthClientOptions> этих методов не имеет — пересечения с этим
// объединением нет, ложноположительных не будет.
function isAuthClientLike(value: unknown): value is AuthClient {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.onAuthChange === 'function' &&
    typeof v.getCachedSession === 'function' &&
    typeof v.signOut === 'function'
  );
}

function sameStateSnapshot(
  a: PaywallStateSnapshot,
  b: PaywallStateSnapshot
): boolean {
  return a.open === b.open && a.view === b.view && a.error === b.error;
}

function sameTrialConfig(a: TrialConfig, b: TrialConfig): boolean {
  return a.mode === b.mode && a.payload === b.payload && a.storage === b.storage;
}

function parseMarkers(
  segment: string
): { status: string; priceId: string | null; sessionId: string | null } | null {
  if (!segment) return null;
  const params = new URLSearchParams(segment);
  const status = params.get(URL_MARKERS.status);
  if (!status) return null;
  return {
    status,
    priceId: params.get(URL_MARKERS.priceId),
    sessionId: params.get(URL_MARKERS.sessionId)
  };
}

// Контракт сообщения должен совпадать с UserWatcher.handleMessage:
// `{ type: 'paywall_purchase' }`. opener — исходная вкладка хоста, на ней живёт
// PaywallUI с активным watcher'ом, ждущим этого сигнала.
function notifyOpenerOfPurchase(markers: {
  status: string;
  priceId: string | null;
  sessionId: string | null;
}): void {
  if (typeof window === 'undefined' || !window.opener) return;
  try {
    window.opener.postMessage(
      {
        type: 'paywall_purchase',
        status: markers.status,
        priceId: markers.priceId,
        sessionId: markers.sessionId
      },
      '*'
    );
  } catch {
    /* opener из другого origin или закрыт — watcher через focus подхватит */
  }
}

function stripMarkersFromUrl(url: URL): void {
  const clean = (raw: string, prefix: '?' | '#'): string => {
    if (!raw) return '';
    const p = new URLSearchParams(raw.replace(/^[?#]/, ''));
    p.delete(URL_MARKERS.status);
    p.delete(URL_MARKERS.priceId);
    p.delete(URL_MARKERS.sessionId);
    const out = p.toString();
    return out ? prefix + out : '';
  };
  const next = url.pathname + clean(url.search, '?') + clean(url.hash, '#');
  window.history.replaceState(null, '', next);
}
