import { ApiClient } from './api';
import {
  ApiGatewayClient,
  type ApiGatewayClientOptions
} from './ApiGatewayClient';
import type { AuthClient, AuthUser } from './auth';
import {
  createStorage,
  ensureVisitorId,
  generateVisitorId as generateUuid,
  type StorageAdapter,
  STORAGE_KEYS
} from './storage';
import {
  type Acquiring,
  type Balance,
  type CheckoutResult,
  type Identity,
  type Layout,
  type LocaleOverrides,
  type PaywallBootstrap,
  type PaywallPrice,
  type PaywallPurchaseDetailed,
  type PaywallSettings,
  type PaywallUser,
  type UserLanguageInfo,
  PaywallError
} from './types';

// Свежесть in-memory кеша user. 5с — компромисс: достаточно, чтобы naïve-юзер,
// дёрнувший getUser в setInterval(1000), не нагружал сервер; недостаточно,
// чтобы пропустить успешную оплату дольше пары секунд после revalidateTag.
const USER_CACHE_TTL_MS = 5_000;
// Persistent cache (storage) живёт 30 минут. Дольше — рискованно отдавать
// устаревший snapshot без сети.
const USER_PERSIST_TTL_MS = 30 * 60_000;
// Persistent bootstrap живёт 1 час. На каждом mount BillingClient hydrate'ит
// его из storage и параллельно шлёт revalidate с `?if_version=<v>`. Если
// сервер ответил `unchanged: true` — мы лишь обновляем user, structure
// остаётся та же (cheap path). При истечении TTL — блокирующий полный
// запрос; не отдаём stale, который потенциально не отражает изменения
// настроек админом (revalidateTag на бэке инвалидирует unstable_cache, но
// не знает про клиентский storage). 1 час — компромисс: попаdaния в кэш
// доминируют над холодными запусками, при этом изменения в админке
// доходят до клиента в пределах часа без явного refresh.
const BOOTSTRAP_PERSIST_TTL_MS = 60 * 60_000;
// Порог свежести cached bootstrap'а: если последняя запись была раньше этого —
// при следующем `bootstrap()` уйдёт фоновый revalidate с `?if_version`.
// Раньше — return cached без сети (миллисекунды между двумя `bootstrap()`
// не имеют смысла дёргать). 5 минут — большинство переоткрытий popup'а
// попадают в холодный период, при этом мы не штурмуем сервер при бурстах.
const BOOTSTRAP_STALE_THRESHOLD_MS = 5 * 60_000;
const EMPTY_USER: PaywallUser = {
  has_active_subscription: false,
  purchases: [],
  trial: null
};

function identityKey(identity: Identity | undefined): string {
  if (!identity) return 'guest';
  return identity.email || identity.userId || identity.anonymousId || 'guest';
}

function sameUser(a: PaywallUser | null, b: PaywallUser | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

type UserListener = (user: PaywallUser) => void;
type BalancesListener = (balances: Balance[]) => void;

// Балансы AI-провайдеров. 5с TTL — как у user-cache: balance меняется только
// после успешного gateway-вызова (мы декрементим оптимистично) или вне SDK
// (платёж пополнил квоту); в обоих случаях короткий TTL достаточно.
const BALANCES_CACHE_TTL_MS = 5_000;
// Persistent balances живут 5 минут. Достаточно, чтобы переоткрытие popup'а
// в пределах рабочей сессии (типичный паттерн extension'а) шло из кэша; не
// настолько долго, чтобы баланс сильно разъехался с серверной правдой при
// нескольких покупках подряд. Свежий decrement через `decrementBalanceLocal`
// сразу пишется в storage и доходит до других вкладок через `storage.watch`.
const BALANCES_PERSIST_TTL_MS = 5 * 60_000;
// Порог свежести cached balances: при возрасте младше — `getBalances()`
// возвращает кэш без сетевого запроса. Старше — фоновый refetch
// (stale-while-revalidate). force=true обходит порог. 30 секунд — компромисс:
// частые UI-renders (счётчик баланса в widget'е) не штурмуют сервер, при
// этом изменения, сделанные на бэке без участия SDK, доходят достаточно
// быстро.
const BALANCES_STALE_THRESHOLD_MS = 30_000;

function sameBalances(a: Balance[] | null, b: Balance[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].type !== b[i].type || a[i].count !== b[i].count) return false;
  }
  return true;
}

export interface BillingClientOptions {
  paywallId: string;
  apiOrigin?: string;
  identity?: Identity;
  storage?: StorageAdapter;
  capabilities?: string[];
  fetch?: typeof fetch;
  /**
   * Server SDK API key. Используется для `/start-checkout` в headless/hybrid-сценариях,
   * где вызов идёт из trusted-окружения (backend клиента). В client-native пути
   * ключ НЕ передавать — приватный токен утечёт в браузер.
   */
  apiKey?: string;
  /**
   * AuthClient для подключения Bearer-авторизации и автосинка identity. Если
   * передан — все запросы получают `Authorization: Bearer <access_token>`,
   * а identity пересчитывается из auth.user на каждом login/logout/refresh
   * (перетирает явно заданный `opts.identity` после первого auth-event'а).
   *
   * Без auth BillingClient работает как раньше: identity приходит снаружи
   * через `setIdentity`, Bearer не отправляется.
   */
  auth?: AuthClient;
  /**
   * Preview/editor-mode. Когда true:
   *  - `bootstrap()` НЕ ходит в сеть — отдаёт только `cachedBootstrap`, заданный
   *    через `setBootstrap()`. Без seed'а throw'ает (caller обязан засидить до open).
   *  - Storage.watch / persist отключены (preview редактора локален для текущей вкладки).
   *  - `setBootstrap(partial)` доступен как публичный setter — host'у разрешено
   *    мутировать кеш для live-обновления модалки в редакторе админки.
   * Дефолт false — обычный production-режим.
   */
  preview?: boolean;
}

const DEFAULT_API_ORIGIN = 'https://appbox.space';

export class BillingClient {
  readonly paywallId: string;
  readonly apiOrigin: string;
  readonly capabilities: string[] | undefined;
  /** AuthClient, если был передан в options. Иначе undefined. */
  readonly auth: AuthClient | undefined;
  private api: ApiClient;
  private storage: StorageAdapter;
  private identity: Identity | undefined;
  private apiKey: string | undefined;
  private fetchImpl: typeof fetch | undefined;
  private cachedBootstrap: PaywallBootstrap | null = null;
  // Время последней успешной записи cachedBootstrap (mono Date.now). Используем
  // для TTL: после BOOTSTRAP_PERSIST_TTL_MS считаем stale и идём в сеть
  // блокирующе (нельзя отдавать устаревший layout — админ мог его поменять).
  private cachedBootstrapAt = 0;
  // In-flight dedupe для bootstrap. Параллельные `bootstrap()` (например, mount
  // двух виджетов одновременно) получают один и тот же promise — один сетевой
  // запрос. Stale-while-revalidate ветка тоже пишет сюда фоновый promise,
  // чтобы commit'ы не пересекались.
  private inflightBootstrap: Promise<PaywallBootstrap> | null = null;
  private bootstrapListeners = new Set<(b: PaywallBootstrap) => void>();
  // Отписка от storage.watch — другая вкладка / popup / service-worker
  // могла обновить bootstrap; через watch мы получаем onChanged без
  // сетевого запроса. null = адаптер не поддерживает watch (memory).
  private bootstrapStorageUnwatch: (() => void) | null = null;
  private authUnsubscribe: (() => void) | null = null;

  // user-cache: in-memory с TTL + in-flight dedupe + persistent fallback.
  private cachedUser: PaywallUser | null = null;
  private cachedUserAt = 0;
  private inflightUser: Promise<PaywallUser> | null = null;
  private userListeners = new Set<UserListener>();

  // Stable visitor_id для аналитики. Резолвится один раз при инициализации,
  // переиспользуется на все track-вызовы. Не привязан к identity.
  private visitorIdPromise: Promise<string> | null = null;
  private visitorId: string | null = null;

  // In-flight createCheckout dedupe — Stage 1 защиты от дубликатов покупок.
  // Параллельные клики по CTA (двойной клик, две вкладки на одной странице)
  // получают тот же promise и тот же server-side checkout-URL вместо двух
  // запросов к /start-checkout. Ключ — либо переданный idempotencyKey, либо
  // `auto:${priceId}` (один inflight на цену для авто-сгенеренных ключей).
  private inflightCheckouts = new Map<string, Promise<CheckoutResult>>();

  // balances-cache: симметрично user-cache. ApiGatewayClient оптимистично
  // декрементит через decrementBalanceLocal(); явный getBalances({force:true})
  // ходит к /balances и обновляет state. Listener'ы получают snapshot после
  // каждого реального изменения (Object.is не сравниваем — массивы разные).
  private cachedBalances: Balance[] | null = null;
  private cachedBalancesAt = 0;
  // Отписка от storage.watch для balances. Ключ identity-bound, при
  // setIdentity отписываемся и переподписываемся под новым identityKey.
  private balancesStorageUnwatch: (() => void) | null = null;
  private inflightBalances: Promise<Balance[]> | null = null;
  private balanceListeners = new Set<BalancesListener>();

  // Preview/editor-mode: см. BillingClientOptions.preview. Фиксируется в
  // конструкторе; runtime-переключения не предусмотрено — preview/production
  // это разные жизненные циклы клиента.
  private readonly previewMode: boolean;
  // Монотонный счётчик для генерации синтетического version в setBootstrap.
  // Реальный server-version имеет вид "<paywall_id>:<hash>"; здесь мы кладём
  // "preview:<n>" чтобы applyBootstrap гарантированно увидел смену version
  // и дёрнул listener'ы (PaywallRoot rerender'ит на каждый setBootstrap).
  private previewVersionCounter = 0;

  constructor(opts: BillingClientOptions) {
    if (!opts.paywallId) {
      throw new PaywallError('invalid_config', 'paywallId is required');
    }

    this.paywallId = opts.paywallId;
    this.apiOrigin = opts.apiOrigin ?? DEFAULT_API_ORIGIN;
    this.capabilities = opts.capabilities;
    this.auth = opts.auth;
    this.previewMode = opts.preview === true;
    // Если auth передан — initial identity берём из cached user (если он
    // успел гидрироваться в конструкторе AuthClient — обычно нет, поэтому
    // ниже подписываемся на onAuthChange и обновим, как только session
    // зарезолвится). Явно заданный opts.identity побеждает только до
    // первого auth-event'а — после login/logout это поле перетрётся.
    const authUser = opts.auth?.getCachedUser();
    this.identity = opts.identity ?? (authUser ? authUserToIdentity(authUser) : undefined);
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch;
    // Безопасность: приватный server-SDK ключ НИКОГДА не должен попасть в
    // браузер. Detect-эвристика — наличие `window.document` (не идеальная,
    // но отсекает обычные web/extension случаи; в Node/Deno/Bun fallback
    // на `typeof window === 'undefined'`). Не throw'аем — host может иметь
    // нестандартный сценарий (e2e-тесты с инжекцией ключа), но громко
    // предупреждаем в console.error чтобы это попало в Sentry / логи.
    if (
      opts.apiKey &&
      typeof window !== 'undefined' &&
      typeof (window as { document?: unknown }).document !== 'undefined'
    ) {
      console.error(
        '[paywall] SECURITY: BillingClient.apiKey detected in browser context. ' +
          'This is a server-SDK key and exposes your account. Remove apiKey ' +
          'or move BillingClient to a trusted backend.'
      );
    }
    this.storage = createStorage(opts.storage);
    this.api = new ApiClient({
      apiOrigin: this.apiOrigin,
      paywallId: opts.paywallId,
      capabilities: opts.capabilities,
      fetch: opts.fetch,
      // Bearer прокидывается каждый запрос. AuthClient.getAccessToken
      // делает lazy refresh, дедупит, на 401 возвращает null — тогда
      // Authorization-хедер просто не выставится.
      getAuthToken: opts.auth ? () => opts.auth!.getAccessToken() : undefined
    });

    if (opts.auth) {
      // BillingClient синхронизирует identity на любой смене session (включая
      // INITIAL_SESSION — иначе после reload до первого реального event'а
      // identity не выставится). sameIdentity-guard ниже подавит no-op'ы для
      // event'ов вроде TOKEN_REFRESHED, где user.id не поменялся.
      this.authUnsubscribe = opts.auth.onAuthChange((_event, session) => {
        const next = session ? authUserToIdentity(session.user) : undefined;
        if (sameIdentity(this.identity, next)) return;
        this.setIdentity(next);
      });
    }

    // Seed из persistent storage — чтобы первый getUser() мог отдать last-known
    // мгновенно (offline fallback). Не блокируем конструктор.
    void this.hydrateUserFromStorage();

    // То же для bootstrap'а: hydrate + подписка на cross-context изменения.
    // Если popup уже сходил за свежим bootstrap'ом, content-script подхватит
    // через storage.watch без своего сетевого запроса.
    void this.hydrateBootstrapFromStorage();
    this.subscribeBootstrapStorage();

    // Balances: identity-bound persist. На init ключ = identity на момент
    // конструктора; setIdentity отписывается и переподписывается под новым.
    void this.hydrateBalancesFromStorage();
    this.subscribeBalancesStorage();

    // Резолвим visitor_id заранее, чтобы EventTracker мог брать sync-ссылку
    // (this.visitorId) почти сразу после первого микротаска.
    this.visitorIdPromise = ensureVisitorId(this.storage).then((id) => {
      this.visitorId = id;
      return id;
    });
  }

  /**
   * Stable visitor_id (UUID v4). Первый вызов awaitит первичный резолв из
   * storage; последующие — мгновенно из in-memory кеша. Используется
   * EventTracker'ом для атрибуции аналитики.
   */
  async getVisitorId(): Promise<string> {
    if (this.visitorId) return this.visitorId;
    if (!this.visitorIdPromise) {
      this.visitorIdPromise = ensureVisitorId(this.storage).then((id) => {
        this.visitorId = id;
        return id;
      });
    }
    return this.visitorIdPromise;
  }

  /** Sync-доступ к visitor_id. null если ещё не зарезолвили (первые ms жизни). */
  getCachedVisitorId(): string | null {
    return this.visitorId;
  }

  setIdentity(identity: Identity | undefined): void {
    this.identity = identity;
    // bootstrap НЕ сбрасываем: structure (layout/prices/offers/locales) от
    // identity не зависит, persisted shape переиспользуем. user обновится
    // отдельно через getUser({force:true}) ниже + следующий revalidate
    // bootstrap'а подтянет свежий user одним round-trip'ом, если нужно.
    // user привязан к identity — переключение чистит, иначе один юзер увидит
    // подписку другого после re-login.
    this.cachedUser = null;
    this.cachedUserAt = 0;
    this.inflightUser = null;
    // Балансы привязаны к Bearer-юзеру (см. /balances route — он использует
    // Auth-юзера, не identity.email). При re-login обнуляем, listener'ы
    // получат пустой массив до следующего getBalances.
    this.cachedBalances = null;
    this.cachedBalancesAt = 0;
    this.inflightBalances = null;
    // Storage-ключ балансов identity-bound — отписываемся от старого ключа
    // и переподписываемся под новым identityKey'ем. Hydrate подхватит
    // persisted balances нового юзера (если открывал расширение раньше).
    if (this.balancesStorageUnwatch) {
      this.balancesStorageUnwatch();
      this.balancesStorageUnwatch = null;
    }
    void this.hydrateBalancesFromStorage();
    this.subscribeBalancesStorage();
    void this.hydrateUserFromStorage();
    // Auto-refetch user'а в фоне для нового identity. Без этого UI'ам с
    // подпиской на onUserChange (account-widget'ы, pop'ы статуса) пришлось
    // бы вручную дёргать getUser после каждого signin'а — а они обычно
    // не знают что signin произошёл. С refetch'ем onUserChange broadcast'ит
    // свежий has_active_subscription автоматически. Promise проглатывает
    // ошибки — getUser сам обновит cachedUser в EMPTY_USER при сетевом
    // фейле, listener'ы получат rollback-snapshot.
    if (identity) {
      void this.getUser({ force: true }).catch(() => {
        /* network failure — listener'ы получат EMPTY_USER через applyUser */
      });
    }
  }

  /**
   * Отписаться от auth-event'ов и сбросить listener'ы. Вызывать когда
   * BillingClient больше не нужен (тесты, hot-reload, переинициализация).
   * Без destroy() listener на AuthClient переживёт BillingClient и будет
   * дёргать setIdentity на освобождённом инстансе. Слушатели user/balance
   * чистятся, чтобы упавший host (например, размонтированный React-tree)
   * не держал замыкания на эти колбеки.
   */
  destroy(): void {
    if (this.authUnsubscribe) {
      this.authUnsubscribe();
      this.authUnsubscribe = null;
    }
    if (this.bootstrapStorageUnwatch) {
      this.bootstrapStorageUnwatch();
      this.bootstrapStorageUnwatch = null;
    }
    if (this.balancesStorageUnwatch) {
      this.balancesStorageUnwatch();
      this.balancesStorageUnwatch = null;
    }
    this.userListeners.clear();
    this.balanceListeners.clear();
    this.bootstrapListeners.clear();
  }

  getIdentity(): Identity | undefined {
    return this.identity;
  }

  getStorage(): StorageAdapter {
    return this.storage;
  }

  async bootstrap(
    forceOrOpts: boolean | { force?: boolean; signal?: AbortSignal } = false
  ): Promise<PaywallBootstrap> {
    // Старая сигнатура `bootstrap(force: boolean)` сохраняется для совместимости
    // с уже написанным host-кодом; новая — `bootstrap({force?, signal?})`.
    const opts =
      typeof forceOrOpts === 'boolean' ? { force: forceOrOpts } : forceOrOpts;

    // Preview-mode: сеть отключена. Caller обязан был засидить cachedBootstrap
    // через setBootstrap() до первого open(). Без seed'а кидаем явную ошибку,
    // чтобы редактор админки сразу увидел причину пустой модалки.
    if (this.previewMode) {
      if (this.cachedBootstrap) return this.cachedBootstrap;
      throw new PaywallError(
        'invalid_config',
        'BillingClient in preview mode but cachedBootstrap is not seeded. Call setBootstrap(bootstrap) before open().'
      );
    }

    // Stale-while-revalidate: если кэш свежий по TTL — отдаём мгновенно и
    // в фоне идём за свежим (с `?if_version=<v>`, чтобы 99% случаев бэк
    // ответил коротким `unchanged: true`). Force обходит весь кэш и блокирует.
    const now = Date.now();
    const cacheFresh =
      this.cachedBootstrap &&
      this.cachedBootstrapAt > 0 &&
      now - this.cachedBootstrapAt < BOOTSTRAP_PERSIST_TTL_MS;

    if (!opts.force && cacheFresh) {
      const shouldRevalidate =
        now - this.cachedBootstrapAt > BOOTSTRAP_STALE_THRESHOLD_MS;
      if (shouldRevalidate) {
        // Фоновый revalidate — не блокируем caller, ошибки swallow'им (cache
        // всё ещё считается достоверным до истечения TTL).
        void this.revalidateBootstrap(opts.signal).catch(() => {
          /* network/abort — listener'ы получат свежее на следующий запрос */
        });
      }
      // Bootstrap.user может быть stale: setIdentity сбросил cachedUser,
      // но НЕ trogает cachedBootstrap.user (structure-cache переживает
      // re-identity). Свежий user приходит отдельно через applyUser после
      // force-getUser. Чтобы caller (RemoteBillingClient → applyUser в
      // mirror) не перетёр свежий user stale-данными из cached bootstrap'а —
      // возвращаем bootstrap с user из текущего cachedUser. null cachedUser
      // = «ещё не загружен» — отдаём undefined, RemoteBillingClient тогда
      // не дёрнет applyUser и подождёт broadcast.
      return { ...this.cachedBootstrap!, user: this.cachedUser ?? undefined };
    }

    // Параллельные mount'ы (виджет + popup) получают один и тот же promise.
    // Без dedupe — два сетевых запроса с одинаковым результатом.
    if (this.inflightBootstrap) return this.inflightBootstrap;

    this.inflightBootstrap = this.fetchBootstrap({
      ifVersion: opts.force ? undefined : this.cachedBootstrap?.version,
      signal: opts.signal
    }).finally(() => {
      this.inflightBootstrap = null;
    });

    return this.inflightBootstrap;
  }

  /**
   * Подписка на изменения bootstrap'а: applyBootstrap (сетевой revalidate,
   * cross-context storage.watch). Срабатывает ТОЛЬКО при реальном изменении
   * `version` (unchanged-ответ от сервера не дёргает listener'ов). Возвращает
   * unsubscribe.
   */
  onBootstrapChange(cb: (b: PaywallBootstrap) => void): () => void {
    this.bootstrapListeners.add(cb);
    return () => {
      this.bootstrapListeners.delete(cb);
    };
  }

  /**
   * Заменить cachedBootstrap частичными или полными данными и эмитнуть всем
   * подписчикам. Используется host'ом в preview-mode (редактор админки) для
   * live-обновления открытой модалки без сетевого revalidate'а.
   *
   * Поведение:
   *  - Без `cachedBootstrap` ожидаются как минимум `settings` + `prices` —
   *    иначе PaywallRoot не сможет отрендерить тарифы и упадёт.
   *  - С существующим кешем партиал мёрджится поверх: `settings` глубокий мёрдж
   *    на 1 уровень (поля настроек), массивы `prices`/`offers` перезаписываются.
   *  - Каждый вызов бампит `version` ("preview:<n>"), чтобы applyBootstrap'овая
   *    проверка `versionChanged` всегда срабатывала и listener'ы дёргались.
   *  - Persist в storage НЕ делаем — preview не должен утекать в другие вкладки.
   *
   * В non-preview режиме метод доступен, но это редкий путь (например, для
   * тестов host'а) — production-код должен полагаться на bootstrap() + revalidate.
   */
  setBootstrap(partial: Partial<PaywallBootstrap>): void {
    const base: PaywallBootstrap = this.cachedBootstrap ?? {
      settings: { id: this.paywallId, name: '' } as PaywallSettings,
      prices: [],
      offers: []
    };

    const merged: PaywallBootstrap = {
      ...base,
      ...partial,
      settings:
        partial.settings !== undefined
          ? { ...base.settings, ...partial.settings }
          : base.settings,
      prices: partial.prices !== undefined ? partial.prices : base.prices,
      offers: partial.offers !== undefined ? partial.offers : base.offers,
      version: `preview:${++this.previewVersionCounter}`
    };

    if (!merged.layout) {
      merged.layout = buildDefaultLayout(merged.settings, merged.prices);
    }
    applyLocaleOverrides(merged);

    this.cachedBootstrap = merged;
    this.cachedBootstrapAt = Date.now();

    for (const cb of this.bootstrapListeners) {
      try {
        cb(merged);
      } catch (e) {
        console.warn('[paywall] onBootstrapChange listener threw', e);
      }
    }
  }

  // Network primitive — единая точка для force-запроса, revalidate'а и
  // первого холодного bootstrap'а. `ifVersion` шлёт server-side short-circuit:
  // если совпала — бэк отвечает `{unchanged: true, version, user}` и мы лишь
  // обновляем cached user, structure (layout/prices/offers/locales) не трогаем.
  private async fetchBootstrap(opts: {
    ifVersion?: string;
    signal?: AbortSignal;
  }): Promise<PaywallBootstrap> {
    const headers: Record<string, string> = {};
    if (this.identity?.email) headers['X-User-Email'] = this.identity.email;

    const path = opts.ifVersion
      ? `/api/v1/paywall/${this.paywallId}/bootstrap?if_version=${encodeURIComponent(opts.ifVersion)}`
      : `/api/v1/paywall/${this.paywallId}/bootstrap`;

    const resp = await this.api.request<
      PaywallBootstrap | { unchanged: true; version: string; user?: PaywallUser }
    >(path, {
      ...(Object.keys(headers).length ? { headers } : {}),
      signal: opts.signal
    });

    if ('unchanged' in resp && resp.unchanged) {
      // Server-side подтвердил, что structure не изменилась. Cached остаётся,
      // обновляем только user. Если cached почему-то null (race на старте) —
      // fallback: повторяем запрос без if_version, чтобы получить full.
      if (!this.cachedBootstrap) {
        return this.fetchBootstrap({ signal: opts.signal });
      }
      // Освежим TTL — за unchanged-ответом тоже идёт сеть, кэш всё ещё валиден.
      this.cachedBootstrapAt = Date.now();
      if (resp.user) this.applyUser(resp.user);
      return this.cachedBootstrap;
    }

    const bootstrap = resp as PaywallBootstrap;
    if (!bootstrap.layout) {
      bootstrap.layout = buildDefaultLayout(bootstrap.settings, bootstrap.prices);
    }
    applyLocaleOverrides(bootstrap);

    this.applyBootstrap(bootstrap, { persist: true });
    if (bootstrap.user) this.applyUser(bootstrap.user);

    return bootstrap;
  }

  // Фоновый revalidate из stale-while-revalidate ветки. Дедуплицируется через
  // `inflightBootstrap`, чтобы параллельные revalidate'ы не пересекались.
  private revalidateBootstrap(signal?: AbortSignal): Promise<PaywallBootstrap> {
    if (this.inflightBootstrap) return this.inflightBootstrap;
    this.inflightBootstrap = this.fetchBootstrap({
      ifVersion: this.cachedBootstrap?.version,
      signal
    }).finally(() => {
      this.inflightBootstrap = null;
    });
    return this.inflightBootstrap;
  }

  // Применяет fresh bootstrap к state: emit listeners ТОЛЬКО при изменении
  // version (т.е. structure реально другая). Это нужно, чтобы повторный
  // applyBootstrap из storage.watch не перерисовал UI зря, если другая
  // вкладка нашла тот же version. persist=false для пути «получили из
  // storage» — там кто-то другой уже записал.
  private applyBootstrap(
    bootstrap: PaywallBootstrap,
    { persist }: { persist: boolean }
  ): void {
    const versionChanged =
      !this.cachedBootstrap || this.cachedBootstrap.version !== bootstrap.version;

    this.cachedBootstrap = bootstrap;
    this.cachedBootstrapAt = Date.now();

    if (persist) void this.persistBootstrap(bootstrap);

    if (versionChanged) {
      for (const cb of this.bootstrapListeners) {
        try {
          cb(bootstrap);
        } catch (e) {
          console.warn('[paywall] onBootstrapChange listener threw', e);
        }
      }
    }
  }

  private async hydrateBootstrapFromStorage(): Promise<void> {
    if (this.cachedBootstrap) return;
    try {
      const raw = await this.storage.getItem(STORAGE_KEYS.bootstrap(this.paywallId));
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        at: number;
        bootstrap: PaywallBootstrap;
      } | null;
      if (!parsed?.bootstrap) return;
      if (Date.now() - parsed.at > BOOTSTRAP_PERSIST_TTL_MS) return;
      // Race-защита: если за время `await` кто-то успел положить свежий
      // bootstrap (одновременный фоновый fetch) — не перетираем.
      if (this.cachedBootstrap) return;
      // Локали могут быть не применены в persisted-shape'е — гарантируем
      // консистентность накатив их заново. applyLocaleOverrides идемпотентен.
      applyLocaleOverrides(parsed.bootstrap);
      this.cachedBootstrap = parsed.bootstrap;
      this.cachedBootstrapAt = parsed.at;
      // emit listener'ам — host'ы могут подписаться синхронно в конструкторе
      // и ждать первый snapshot. user из persisted — может быть очень старый,
      // не применяем (свежий придёт через сетевой запрос / hydrateUser).
      for (const cb of this.bootstrapListeners) {
        try {
          cb(parsed.bootstrap);
        } catch (e) {
          console.warn('[paywall] onBootstrapChange listener threw', e);
        }
      }
    } catch {
      /* corrupted entry — игнорируем */
    }
  }

  private async persistBootstrap(bootstrap: PaywallBootstrap): Promise<void> {
    // Не персистим bootstrap без version — старый бэк не отдаёт его, и без
    // version нет смысла в ревалидации (всегда придётся тянуть full payload).
    if (!bootstrap.version) return;
    try {
      // user'а в persisted не пишем — он живёт под своим ключом userState
      // с собственным TTL/identity-маппингом.
      const { user: _user, ...rest } = bootstrap;
      await this.storage.setItem(
        STORAGE_KEYS.bootstrap(this.paywallId),
        JSON.stringify({ at: Date.now(), bootstrap: rest })
      );
    } catch {
      /* quota / disabled */
    }
  }

  // Cross-context sync: другая вкладка / popup / sw записали свежий bootstrap
  // → мы подхватываем без сетевого запроса. Адаптеры без watch (memory) —
  // no-op, всё работает как раньше через сеть.
  private subscribeBootstrapStorage(): void {
    if (typeof this.storage.watch !== 'function') return;
    this.bootstrapStorageUnwatch = this.storage.watch(
      STORAGE_KEYS.bootstrap(this.paywallId),
      (raw) => {
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as {
            at: number;
            bootstrap: PaywallBootstrap;
          } | null;
          if (!parsed?.bootstrap) return;
          // Если та же version — нет смысла перезаписывать (избежим лишних
          // listener'ов из applyBootstrap).
          if (
            this.cachedBootstrap?.version &&
            this.cachedBootstrap.version === parsed.bootstrap.version
          ) {
            this.cachedBootstrapAt = parsed.at;
            return;
          }
          applyLocaleOverrides(parsed.bootstrap);
          this.applyBootstrap(parsed.bootstrap, { persist: false });
        } catch {
          /* corrupted entry — ignore */
        }
      }
    );
  }

  /** Возвращает последний загруженный bootstrap без сетевого запроса.
   *  null = bootstrap ещё не загружали. Удобно для post-checkout-логики
   *  (PaywallUI читает success_redirect_url, не делая второго round-trip'а). */
  getCachedBootstrap(): PaywallBootstrap | null {
    return this.cachedBootstrap;
  }

  /**
   * Шорткат поверх `bootstrap()`: ждёт загрузку структуры пейвола и возвращает
   * цены. Полезно когда host рисует цены вне модалки (карточки на лендинге,
   * "Pricing" page и т.п.) и не хочет руками распаковывать bootstrap.
   *
   * Locale-оверрайды (`label`/`description` под `navigator.language`) уже
   * применены — массив готов к рендеру. Кэш/TTL/stale-while-revalidate — те
   * же, что у `bootstrap()`: повторный вызов не штурмует сервер.
   */
  async getPrices(
    opts: { force?: boolean; signal?: AbortSignal } = {}
  ): Promise<PaywallPrice[]> {
    const b = await this.bootstrap(opts);
    return b.prices;
  }

  /** Sync-снимок цен из последнего bootstrap'а. null = ещё не загружали. */
  getCachedPrices(): PaywallPrice[] | null {
    return this.cachedBootstrap?.prices ?? null;
  }

  /**
   * Снимок того, какой язык SDK сейчас считает «языком юзера». Полезно для
   * синхронизации i18n хоста с тем, что фактически показывает пейвол — чтобы
   * окружающий UI не противоречил модалке (например, host рисует кнопку
   * "Subscribe" на английском, а пейвол показывает «Подписаться» на русском).
   *
   * Возвращает структуру, а не один тэг, чтобы интегратор мог:
   *  - быстро взять `tag` для своих переводов;
   *  - отличить «пейвол реально на этом языке» (`applied !== null`) от
   *    «SDK угадал, но локали для этого языка нет — рендерится база»;
   *  - решить, чему доверять при противоречии browserLanguage vs countryLanguage
   *    (тур, expat, VPN — у каждого свой ответ).
   *
   * Sync-вызов: данные уже в bootstrap'е, отдельных запросов не делает.
   * Если `bootstrap()` ещё не вызывался — `applied` и `countryLanguage`
   * будут `null`, но `browserLanguage` и `tag` всё равно отдадутся, если
   * есть `navigator.language`.
   */
  getUserLanguage(): UserLanguageInfo {
    const browserLanguage =
      typeof navigator !== 'undefined' && navigator.language ? navigator.language : null;
    const countryLanguage = this.cachedBootstrap?.settings.locale_default ?? null;
    const applied = this.cachedBootstrap ? pickLocaleKey(this.cachedBootstrap) : null;
    const tag = applied ?? browserLanguage ?? countryLanguage;
    return { tag, applied, browserLanguage, countryLanguage };
  }

  /**
   * Получить актуальное состояние подписки/покупок.
   *
   * - In-memory cache TTL 5с — naïve setInterval(1000) не нагружает сервер.
   * - In-flight dedupe — параллельные вызовы получают один promise.
   * - `force: true` обходит кеш (для post-checkout проверки).
   * - Без identity возвращает empty-state (сервер тоже так делает).
   */
  async getUser(
    { force = false, signal }: { force?: boolean; signal?: AbortSignal } = {}
  ): Promise<PaywallUser> {
    if (!force && this.cachedUser && Date.now() - this.cachedUserAt < USER_CACHE_TTL_MS) {
      return this.cachedUser;
    }
    if (this.inflightUser) return this.inflightUser;

    this.inflightUser = (async () => {
      try {
        if (!this.identity?.email) {
          this.applyUser(EMPTY_USER);
          return EMPTY_USER;
        }
        const fresh = await this.api.request<PaywallUser>(
          `/api/v1/paywall/${this.paywallId}/user-state`,
          { headers: { 'X-User-Email': this.identity.email }, signal }
        );
        this.applyUser(fresh);
        return fresh;
      } finally {
        this.inflightUser = null;
      }
    })();

    return this.inflightUser;
  }

  /**
   * Подписка на изменения user-state. Колбек вызывается:
   * - сразу с last-known user (если есть в кеше) — по умолчанию через
   *   microtask, опционально SYNC (см. опции);
   * - на каждое реальное изменение (getUser/bootstrap принёс другой shape).
   *
   * `opts.immediate`:
   *   - `'microtask'` (default) — initial snapshot отдаётся в queueMicrotask,
   *     чтобы host успел доресетнуть state в том же тике. Безопасный выбор
   *     для большинства интеграций.
   *   - `'sync'` — initial snapshot отдаётся прямо в текущем frame'е, до
   *     возврата из onUserChange. Удобно для React/Vue useEffect-cleanup'а
   *     (избегаем лишнего ре-рендера) и SSR (мгновенная синхронизация).
   *   - `'none'` — не отдавать initial snapshot, только реальные изменения.
   *
   * Возвращает функцию отписки.
   */
  onUserChange(
    cb: UserListener,
    opts: { immediate?: 'microtask' | 'sync' | 'none' } = {}
  ): () => void {
    this.userListeners.add(cb);
    const mode = opts.immediate ?? 'microtask';
    if (this.cachedUser && mode !== 'none') {
      const snapshot = this.cachedUser;
      if (mode === 'sync') {
        try {
          cb(snapshot);
        } catch (e) {
          console.warn('[paywall] onUserChange initial sync threw', e);
        }
      } else {
        queueMicrotask(() => {
          if (this.userListeners.has(cb)) cb(snapshot);
        });
      }
    }
    return () => {
      this.userListeners.delete(cb);
    };
  }

  /** Текущий cached user без сетевого запроса. null = ещё не загружали. */
  getCachedUser(): PaywallUser | null {
    return this.cachedUser;
  }

  private applyUser(user: PaywallUser): void {
    const changed = !sameUser(this.cachedUser, user);
    this.cachedUser = user;
    this.cachedUserAt = Date.now();
    if (changed) {
      void this.persistUser(user);
      for (const cb of this.userListeners) {
        try {
          cb(user);
        } catch (e) {
          console.warn('[paywall] onUserChange listener threw', e);
        }
      }
    }
  }

  private storageKey(): string {
    return STORAGE_KEYS.userState(this.paywallId, identityKey(this.identity));
  }

  private async hydrateUserFromStorage(): Promise<void> {
    if (this.cachedUser) return;
    try {
      const raw = await this.storage.getItem(this.storageKey());
      if (!raw) return;
      const parsed = JSON.parse(raw) as { at: number; user: PaywallUser } | null;
      if (!parsed?.user) return;
      if (Date.now() - parsed.at > USER_PERSIST_TTL_MS) return;
      // Только если за это время никто не успел положить свежий — иначе
      // перетрём более актуальные данные.
      if (this.cachedUser) return;
      this.applyUser(parsed.user);
    } catch {
      /* corrupted entry — игнорируем, в сети возьмём свежий */
    }
  }

  private async persistUser(user: PaywallUser): Promise<void> {
    try {
      await this.storage.setItem(
        this.storageKey(),
        JSON.stringify({ at: Date.now(), user })
      );
    } catch {
      /* quota / disabled — не критично */
    }
  }

  /**
   * Балансы AI-провайдеров (`paywall_balances` × `tokenization_queries`).
   *
   * - In-memory cache TTL 5с — параллельные UI-renders не дёргают сеть;
   * - In-flight dedupe — параллельные `getBalances` получают один promise;
   * - `force: true` обходит кеш (типичный кейс — после QuotaExceededError);
   * - Без auth (Bearer не выдан) возвращает пустой массив без сетевого
   *   запроса: бэк всё равно ответит 401, нет смысла тратить round-trip.
   *
   * Если у пейвола `tokenization=false` — бэк отдаёт `[]`, как для гостя.
   * SDK не различает «нет квоты» и «нет квот вообще» — caller сам решает
   * по `currentBalance` в QuotaExceededError или `balances.length`.
   */
  async getBalances(
    { force = false, signal }: { force?: boolean; signal?: AbortSignal } = {}
  ): Promise<Balance[]> {
    const now = Date.now();
    const age = this.cachedBalances ? now - this.cachedBalancesAt : Infinity;

    // Стабильный путь: cache свежий (in-memory 5с или persisted младше
    // BALANCES_STALE_THRESHOLD_MS). Возврат без сетевого запроса.
    if (
      !force &&
      this.cachedBalances &&
      (age < BALANCES_CACHE_TTL_MS || age < BALANCES_STALE_THRESHOLD_MS)
    ) {
      return this.cachedBalances;
    }

    // Stale-while-revalidate: cache есть, но возраст между
    // STALE_THRESHOLD и PERSIST_TTL. Возвращаем кэш мгновенно, в фоне
    // обновляем — listener'ы получат свежее через storage.watch +
    // applyBalances. Force пропускает эту ветку — caller ждёт свежее.
    if (
      !force &&
      this.cachedBalances &&
      age < BALANCES_PERSIST_TTL_MS
    ) {
      void this.fetchBalances({ signal }).catch(() => {
        /* swallow — fallback на cached, явный force даст следующую попытку */
      });
      return this.cachedBalances;
    }

    // Cache отсутствует или expired (>PERSIST_TTL) — блокирующий запрос.
    if (this.inflightBalances) return this.inflightBalances;
    return this.fetchBalances({ signal });
  }

  // Network primitive — единая точка для force/stale-revalidate/cold-start.
  // Дедуплицируется через `inflightBalances`.
  private fetchBalances({ signal }: { signal?: AbortSignal } = {}): Promise<Balance[]> {
    if (this.inflightBalances) return this.inflightBalances;
    this.inflightBalances = (async () => {
      try {
        // /balances требует Bearer. Без auth — пустой массив, listener'ы
        // не дёргаем (это shape «не загружали», а не «изменилось»).
        if (!this.auth) {
          this.applyBalances([]);
          return [];
        }
        const resp = await this.api.request<{
          balances: Balance[];
          tokenization: boolean;
        }>(`/api/v1/paywall/${this.paywallId}/balances`, { signal });
        const fresh = Array.isArray(resp.balances) ? resp.balances : [];
        this.applyBalances(fresh);
        return fresh;
      } finally {
        this.inflightBalances = null;
      }
    })();
    return this.inflightBalances;
  }

  /** Sync snapshot. null = ещё не загружали (или explicit clear на re-login). */
  getCachedBalances(): Balance[] | null {
    return this.cachedBalances;
  }

  /**
   * Подписка на изменения балансов: getBalances/decrementBalanceLocal/setIdentity.
   * `opts.immediate` работает так же, как в `onUserChange`: 'microtask'
   * (default), 'sync' (для React/Vue useEffect), 'none' (только изменения).
   * Возвращает unsubscribe.
   */
  onBalanceChange(
    cb: BalancesListener,
    opts: { immediate?: 'microtask' | 'sync' | 'none' } = {}
  ): () => void {
    this.balanceListeners.add(cb);
    const mode = opts.immediate ?? 'microtask';
    if (this.cachedBalances && mode !== 'none') {
      const snapshot = this.cachedBalances;
      if (mode === 'sync') {
        try {
          cb(snapshot);
        } catch (e) {
          console.warn('[paywall] onBalanceChange initial sync threw', e);
        }
      } else {
        queueMicrotask(() => {
          if (this.balanceListeners.has(cb)) cb(snapshot);
        });
      }
    }
    return () => {
      this.balanceListeners.delete(cb);
    };
  }

  /**
   * Оптимистично уменьшает count для `queryType` на 1 и нотифицирует
   * listener'ов. Используется ApiGatewayClient'ом сразу после успешного
   * gateway-вызова (бэк уже снял кредит, см. `chargeApiQueries`).
   *
   * Если queryType отсутствует в кеше или count<=0 — no-op (не уходим в
   * отрицательные значения, бэк всё равно правильный source-of-truth).
   * Если кеша нет вовсе — тоже no-op: явный getBalances({force:true}) на
   * следующем рендере подтянет актуальный shape.
   *
   * queryType может быть undefined (gateway не прислал X-Query-Type) —
   * в этом случае декремент не делаем, но просим refreshBalances() для
   * выравнивания.
   */
  decrementBalanceLocal(queryType: string | undefined): void {
    if (!queryType) {
      void this.getBalances({ force: true });
      return;
    }
    if (!this.cachedBalances) return;
    const idx = this.cachedBalances.findIndex((b) => b.type === queryType);
    if (idx < 0) return;
    const current = this.cachedBalances[idx];
    if (current.count <= 0) return;
    const next = this.cachedBalances.map((b, i) =>
      i === idx ? { ...b, count: b.count - 1 } : b
    );
    this.applyBalances(next);
  }

  /** Принудительный re-fetch — типичный вызов после QuotaExceededError, чтобы
   *  UI получил актуальный balance=0 и нарисовал upgrade-prompt. */
  refreshBalances(): Promise<Balance[]> {
    return this.getBalances({ force: true });
  }

  /**
   * Фабрика ApiGatewayClient'а с подключённым к этому billing'у balance-стейтом:
   *  - Bearer/identity берутся из текущего auth/identity;
   *  - на success декрементим cachedBalances оптимистично;
   *  - на 402 (QuotaExceededError) триггерим refreshBalances() для актуального snapshot'а.
   *
   * Если переопределить опции через `overrides` — принимаются как есть, но
   * `onChargeSuccess`/`onQuotaExceeded` всё равно вызываются (composable, host
   * может добавить свой колбек поверх).
   */
  createApiGatewayClient(
    overrides: Partial<
      Omit<ApiGatewayClientOptions, 'paywallId' | 'auth' | 'userId'>
    > = {}
  ): ApiGatewayClient {
    const userOnCharge = overrides.onChargeSuccess;
    const userOnQuota = overrides.onQuotaExceeded;
    return new ApiGatewayClient({
      paywallId: this.paywallId,
      apiOrigin: this.apiOrigin,
      auth: this.auth,
      userId: this.auth ? undefined : this.identity?.userId,
      capabilities: this.capabilities,
      fetch: this.fetchImpl,
      ...overrides,
      onChargeSuccess: (queryType) => {
        this.decrementBalanceLocal(queryType);
        userOnCharge?.(queryType);
      },
      onQuotaExceeded: (err) => {
        void this.refreshBalances();
        userOnQuota?.(err);
      }
    });
  }

  private applyBalances(balances: Balance[], { persist = true } = {}): void {
    const changed = !sameBalances(this.cachedBalances, balances);
    this.cachedBalances = balances;
    this.cachedBalancesAt = Date.now();
    // Persist даже если !changed — обновляем `at` чтобы другие контексты
    // считали кэш свежим (иначе они через 30с уйдут в сеть зря). persist=false
    // для пути «прилетело через storage.watch» — там кто-то уже записал.
    if (persist) void this.persistBalances(balances);
    if (changed) {
      for (const cb of this.balanceListeners) {
        try {
          cb(balances);
        } catch (e) {
          console.warn('[paywall] onBalanceChange listener threw', e);
        }
      }
    }
  }

  private balancesStorageKey(): string {
    return STORAGE_KEYS.balances(this.paywallId, identityKey(this.identity));
  }

  private async hydrateBalancesFromStorage(): Promise<void> {
    if (this.cachedBalances) return;
    try {
      const raw = await this.storage.getItem(this.balancesStorageKey());
      if (!raw) return;
      const parsed = JSON.parse(raw) as { at: number; balances: Balance[] } | null;
      if (!parsed?.balances || !Array.isArray(parsed.balances)) return;
      if (Date.now() - parsed.at > BALANCES_PERSIST_TTL_MS) return;
      // Race-защита: если за время `await` свежий уже прилетел из сети —
      // не перетираем.
      if (this.cachedBalances) return;
      this.cachedBalances = parsed.balances;
      this.cachedBalancesAt = parsed.at;
      for (const cb of this.balanceListeners) {
        try {
          cb(parsed.balances);
        } catch (e) {
          console.warn('[paywall] onBalanceChange listener threw', e);
        }
      }
    } catch {
      /* corrupted entry — игнорируем */
    }
  }

  private async persistBalances(balances: Balance[]): Promise<void> {
    try {
      await this.storage.setItem(
        this.balancesStorageKey(),
        JSON.stringify({ at: Date.now(), balances })
      );
    } catch {
      /* quota / disabled */
    }
  }

  // Cross-context sync: другая вкладка / popup / SW обновили balances
  // (свежий getBalances или оптимистичный decrement) → подхватываем без
  // сетевого запроса.
  private subscribeBalancesStorage(): void {
    if (typeof this.storage.watch !== 'function') return;
    this.balancesStorageUnwatch = this.storage.watch(
      this.balancesStorageKey(),
      (raw) => {
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as { at: number; balances: Balance[] } | null;
          if (!parsed?.balances || !Array.isArray(parsed.balances)) return;
          // Если cached моложе или той же эпохи — наш свежее. Иначе applyBalances
          // без повторного persist (writer уже записал).
          if (parsed.at <= this.cachedBalancesAt) return;
          this.applyBalances(parsed.balances, { persist: false });
        } catch {
          /* corrupted entry — ignore */
        }
      }
    );
  }

  async createCheckout(params: {
    priceId: string;
    successUrl?: string;
    errorUrl?: string;
    shopUrl?: string;
    trialDays?: number;
    /**
     * Stage 1 защиты от дубликатов покупок. Идемпотентный ключ запроса
     * (UUID). Повторный вызов с тем же ключом вернёт тот же checkout-URL
     * без второго обращения к платёжному провайдеру. Если не передан —
     * SDK генерит UUID v4 сам и дедуплицирует параллельные клики по
     * `auto:${priceId}`.
     */
    idempotencyKey?: string;
    /** Renewal/upgrade flow — игнорирует у бэка проверку has_active_subscription.
     *  По умолчанию /start-checkout возвращает 409 если у юзера уже есть
     *  active subscription (защита от случайных двойных оплат). С
     *  `ignoreActivePurchase: true` бэк создаёт новый checkout, прежняя
     *  подписка отменится после успешной оплаты. Передавать только когда
     *  юзер явно выбрал "Renew/Upgrade" в host-UI. */
    ignoreActivePurchase?: boolean;
    /** Отмена inflight-запроса. Параллельные вызовы дедуплицируются по
     *  `inflightKey`, поэтому signal отменяет ВСЕ ожидающие на этот ключ —
     *  это OK для типичного UX (юзер закрыл модалку — все checkout'ы отменены). */
    signal?: AbortSignal;
  }): Promise<CheckoutResult> {
    if (!this.identity?.email) {
      throw new PaywallError(
        'identity_required',
        'createCheckout requires identity with email'
      );
    }

    const inflightKey = params.idempotencyKey ?? `auto:${params.priceId}`;
    const existing = this.inflightCheckouts.get(inflightKey);
    if (existing) return existing;

    const idempotencyKey = params.idempotencyKey ?? generateUuid();

    // Бэк-контракт camelCase (online/app/api/v1/paywall/[id]/start-checkout/route.ts):
    // { email, priceId, successUrl, errorUrl, shopUrl, trial_days, userMeta, localCurrency }.
    // Response: { checkoutUrl, userId, acquiring } — маппим в SDK-shape { url, sessionId }.
    const headers: Record<string, string> = {
      'Idempotency-Key': idempotencyKey
    };
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;

    // Settings из bootstrap'а — fallback для shopUrl/successUrl. Caller всё
    // ещё может перебить их явным аргументом (host-приложение со своим UX).
    const settings = this.cachedBootstrap?.settings;
    const successUrl = params.successUrl ?? settings?.success_redirect_url ?? undefined;
    const shopUrl = params.shopUrl ?? settings?.checkout_shop_url ?? undefined;

    const promise = this.api
      .request<{
        checkoutUrl: string;
        userId: string;
        // Бэк-контракт: имя acquirer'а, к которому ушёл checkout. SDK сам по
        // acquiring ничего не ветвит (URL открывается одним и тем же
        // window.open), но прокидывает его в CheckoutResult и в событие
        // `checkout_started` — чтобы host и /events-аналитика могли строить
        // конверсию по эквайрингам.
        acquiring: Acquiring;
      }>(`/api/v1/paywall/${this.paywallId}/start-checkout`, {
        method: 'POST',
        headers,
        signal: params.signal,
        body: JSON.stringify({
          email: this.identity.email,
          priceId: Number(params.priceId),
          successUrl,
          errorUrl: params.errorUrl,
          shopUrl,
          productName: settings?.checkout_product_name ?? undefined,
          trial_days: params.trialDays,
          ignoreActivePurchase: params.ignoreActivePurchase ? true : undefined,
          userMeta: this.identity.userId ? { userId: this.identity.userId } : undefined
        })
      })
      .then((resp): CheckoutResult => ({ url: resp.checkoutUrl, acquiring: resp.acquiring }))
      .catch((err): never => {
        // Бэк отдаёт 409 + `{ hasActivePurchase: true }` когда у юзера уже есть
        // активная подписка. Это не ошибка checkout-а — это сигнал «покажи
        // success/restored». Нормализуем в отдельный код, чтобы PaywallRoot
        // мог переключиться в purchase_success view без специфичной для этого
        // эндпоинта проверки status+payload.
        if (
          err instanceof PaywallError &&
          err.status === 409 &&
          err.cause &&
          typeof err.cause === 'object' &&
          (err.cause as { hasActivePurchase?: unknown }).hasActivePurchase === true
        ) {
          throw new PaywallError(
            'already_purchased',
            'You already have an active subscription',
            { status: 409, cause: err.cause }
          );
        }
        throw err;
      });

    this.inflightCheckouts.set(inflightKey, promise);
    // Очищаем после завершения, чтобы следующий клик после завершения
    // получил новый ключ и новый запрос. Параллельные ретраи во время
    // запроса при этом честно дедуплицируются на тот же promise.
    // .catch(() => {}) — финализатор не должен превращать reject promise'а
    // в unhandled rejection; caller createCheckout всё равно получит
    // исходный reject через `return promise`.
    promise
      .finally(() => {
        if (this.inflightCheckouts.get(inflightKey) === promise) {
          this.inflightCheckouts.delete(inflightKey);
        }
      })
      .catch(() => {});

    return promise;
  }

  /**
   * URL Stripe/Paddle/Chargebee customer portal — место, где залогиненный
   * юзер может управлять подпиской (отменить, обновить карту, скачать
   * инвойсы). Опен-флоу управляется host'ом:
   *
   * ```ts
   * const { url } = await billing.getCustomerPortalUrl();
   * window.open(url, '_blank');
   * ```
   *
   * Auth: Bearer (через AuthClient) или server-side `apiKey`. Без auth и
   * без apiKey бросает PaywallError('identity_required'). 403 от бэка
   * (нет активной подписки / acquiring не поддерживает portal) пробрасывается
   * как PaywallError('forbidden') с `status: 403` — host рендерит "no
   * subscription to manage".
   */
  async getCustomerPortalUrl(
    opts: { signal?: AbortSignal } = {}
  ): Promise<{ url: string }> {
    if (!this.auth && !this.apiKey && !this.identity?.email) {
      throw new PaywallError(
        'identity_required',
        'getCustomerPortalUrl requires auth, apiKey, or identity.email'
      );
    }
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;
    // Без Bearer — legacy путь: email/userMeta в body. С Bearer — бэк сам
    // достаёт email через GoTrue, body можно слать пустым.
    const body =
      this.auth && this.auth.getCachedSession()
        ? {}
        : {
            email: this.identity?.email,
            userMeta: this.identity?.userId
              ? { userId: this.identity.userId }
              : undefined
          };
    const resp = await this.api.request<{ url: string }>(
      `/api/v1/paywall/${this.paywallId}/get-customer-portal`,
      {
        method: 'POST',
        headers: Object.keys(headers).length ? headers : undefined,
        body: JSON.stringify(body),
        signal: opts.signal
      }
    );
    return { url: resp.url };
  }

  /**
   * Список покупок юзера с rich-полями (цена, валюта, interval, discount,
   * cancel-метаданные). Подходит для customer-portal UI: cards с кнопками
   * Cancel/Renew/Manage. Менее cache-friendly чем `getUser` — ходит в
   * `/api/v1/paywall/[id]/user` без unstable_cache, потому что list для UI
   * должен быть свежим после cancel-а.
   *
   * Auth: Bearer обязателен (через AuthClient). Без Bearer — 401 от бэка,
   * пробрасываем как PaywallError('http_401'). Гость → пустой список.
   */
  async listPurchases(
    opts: { signal?: AbortSignal } = {}
  ): Promise<PaywallPurchaseDetailed[]> {
    if (!this.auth) {
      throw new PaywallError(
        'auth_required',
        'listPurchases requires AuthClient (Bearer auth)'
      );
    }
    const resp = await this.api.request<{
      purchases: PaywallPurchaseDetailed[];
    }>(`/api/v1/paywall/${this.paywallId}/user`, {
      method: 'GET',
      signal: opts.signal
    });
    return resp.purchases ?? [];
  }

  /**
   * Отменить подписку. Бэк проверит что subscription принадлежит auth-юзеру
   * и сделает cancel у acquiring'а (Stripe/Paddle/Chargebee). По умолчанию
   * cancel в конце текущего периода — юзер сохраняет access до renewal date'ы.
   *
   * `reason` обязательна (валидация на бэке). Удобно собрать через select
   * причин в host-UI, как в legacy customer portal'е.
   *
   * Auth: Bearer обязателен.
   */
  async cancelSubscription(params: {
    subscriptionId: string;
    reason: string;
    signal?: AbortSignal;
  }): Promise<{
    subscription: {
      status: string | null;
      canceled_at: string | null;
      cancel_at: string | null;
      cancel_at_period_end: boolean | null;
    };
  }> {
    if (!this.auth) {
      throw new PaywallError(
        'auth_required',
        'cancelSubscription requires AuthClient (Bearer auth)'
      );
    }
    return this.api.request<{
      subscription: {
        status: string | null;
        canceled_at: string | null;
        cancel_at: string | null;
        cancel_at_period_end: boolean | null;
      };
    }>(`/api/paywall/cancel-subscription`, {
      method: 'POST',
      body: JSON.stringify({
        subscriptionId: params.subscriptionId,
        paywallId: this.paywallId,
        cancellationReason: params.reason
      }),
      signal: params.signal
    });
  }

  /**
   * Создаёт саппорт-тикет. Если есть `files` — multipart/form-data, иначе JSON.
   * Email берётся (1) из явного поля payload.email; (2) из identity если оно есть.
   * Если ни того, ни другого нет — бэк отвергнет тикет (`email_required`).
   *
   * Bearer-токен (если AuthClient подключён) добавляется автоматически — бэк
   * перевешивает customer_email на email из сессии (защита от подделки).
   */
  async createSupportTicket(payload: {
    subject: string;
    content: string;
    email?: string;
    files?: File[];
  }): Promise<{ ticket: { id: number; status: string } }> {
    const customerEmail = payload.email ?? this.identity?.email ?? null;
    const path = `/api/v1/paywall/${this.paywallId}/support/ticket`;
    const hasFiles = !!payload.files && payload.files.length > 0;
    if (hasFiles) {
      const form = new FormData();
      form.set('subject', payload.subject);
      form.set('content', payload.content);
      if (customerEmail) form.set('customer_email', customerEmail);
      for (const f of payload.files!) form.append('files', f);
      return this.api.request<{ ticket: { id: number; status: string } }>(path, {
        method: 'POST',
        body: form
      });
    }
    return this.api.request<{ ticket: { id: number; status: string } }>(path, {
      method: 'POST',
      body: JSON.stringify({
        subject: payload.subject,
        content: payload.content,
        customer_email: customerEmail
      })
    });
  }
}

function authUserToIdentity(user: AuthUser): Identity {
  return { email: user.email, userId: user.id };
}

function sameIdentity(a: Identity | undefined, b: Identity | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.email === b.email &&
    a.userId === b.userId &&
    a.anonymousId === b.anonymousId
  );
}

function buildDefaultLayout(settings: PaywallSettings, prices: PaywallPrice[]): Layout {
  return {
    type: 'modal',
    blocks: [
      { type: 'heading', text: settings.name || 'Upgrade', level: 1 },
      { type: 'price_grid', priceIds: prices.map((p) => p.id) },
      { type: 'cta_button', label: 'Continue', action: 'checkout' }
    ]
  };
}

/** Подбирает оверрайды по `navigator.language` (с fallback на base-tag и
 *  на `settings.locale_default`). Возвращает первый существующий ключ из
 *  карты — без normalize'а кейсов: ключи в bootstrap всё равно приходят
 *  с бэка в едином формате. */
function pickLocaleKey(bootstrap: PaywallBootstrap): string | null {
  const map = bootstrap.locales;
  if (!map) return null;
  const candidates: string[] = [];
  if (typeof navigator !== 'undefined') {
    if (navigator.language) candidates.push(navigator.language);
    const base = navigator.language?.split('-')[0];
    if (base && base !== navigator.language) candidates.push(base);
  }
  const fallback = bootstrap.settings.locale_default;
  if (fallback) candidates.push(fallback);
  for (const key of candidates) {
    if (key && Object.prototype.hasOwnProperty.call(map, key)) return key;
  }
  return null;
}

function applyLocaleOverrides(bootstrap: PaywallBootstrap): void {
  const key = pickLocaleKey(bootstrap);
  if (!key) return;
  const overrides: LocaleOverrides | undefined = bootstrap.locales?.[key];
  if (!overrides) return;
  if (overrides.layout) {
    bootstrap.layout = overrides.layout;
  }
  if (overrides.prices) {
    bootstrap.prices = bootstrap.prices.map((p) => {
      const o = overrides.prices?.[p.id];
      if (!o) return p;
      // Точечно перетираем только переданные поля, остальное оставляем как есть.
      // null в overrides — явный сброс (например, скрыть description в этой локали).
      const next: PaywallPrice = { ...p };
      if ('label' in o) next.label = o.label ?? null;
      if ('description' in o) next.description = o.description ?? null;
      return next;
    });
  }
}
