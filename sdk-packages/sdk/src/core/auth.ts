import { ApiClient } from './api';
import { createStorage, type StorageAdapter, STORAGE_KEYS } from './storage';
import { PaywallError } from './types';
import {
  deriveCodeChallenge,
  generateCodeVerifier,
  generateState
} from './pkce';

// AuthClient — клиент SDK 3.0 для эндпоинтов /api/v1/paywall/[id]/auth/*.
// Хранит auth-сессию в StorageAdapter (localStorage / chrome.storage.local /
// memory), отдаёт access_token для Authorization-хедера в `api.ts` через
// getAccessToken() с lazy refresh, дедупит параллельные refresh'ы, эмитит
// onAuthChange при login/logout/refresh.
//
// Не зависит от BillingClient: AuthClient можно использовать standalone
// (например, для собственного ui без bundled-пейвола). BillingClient в свою
// очередь принимает AuthClient опционально и подключает Bearer + auto-sync
// identity.

// За REFRESH_LEEWAY_MS до expiry начинаем refresh — буфер на сетевую
// задержку и часовой дрейф клиента. 60s достаточно: GoTrue access живёт 1ч,
// шанс реально подсунуть истёкший токен в API-запрос ≈ 0.
const REFRESH_LEEWAY_MS = 60_000;
// TTL для pending OAuth-flow между startOAuthFlow и completeOAuthFlow.
// 10мин — больше чем юзеру нужно прокликать Google/Apple/etc; меньше чем
// reasonable «отошёл и вернулся».
const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

export interface AuthUser {
  id: string;
  /** null для анонимного юзера (signInAnonymously). Для всех остальных flow — заполнен. */
  email: string | null;
  country?: string | null;
  /** true — Supabase anonymous user. UI использует, чтобы решать «sign in» vs
   *  «signed in as ...», и чтобы при OAuth-апгрейде звать linkIdentity вместо
   *  signInWithOAuth (зеркалит легаси StartAuthPage.tsx). */
  is_anonymous?: boolean;
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  /** Absolute timestamp в ms (Date.now() сравнимо). null/0 не пишем. */
  expires_at: number;
  user: AuthUser;
}

export type SignUpResult =
  | { kind: 'signed_in'; session: AuthSession }
  | { kind: 'confirmation_required'; user: { id: string; email: string } };

/** Результат `upgradeAnonymousToEmail`. `updated` — confirmation off либо
 *  прошёл; session.user.email уже обновлён, is_anonymous=false. `confirmation_required` —
 *  GoTrue отправил confirmation на новый email; session всё ещё анонимная,
 *  юзер должен кликнуть ссылку (после чего может вызвать `auth.refresh()` —
 *  токены обновятся с email'ом и is_anonymous=false). */
export type UpgradeAnonymousResult =
  | { kind: 'updated'; session: AuthSession }
  | { kind: 'confirmation_required'; email: string };

export type OtpVerifyType = 'email' | 'recovery' | 'signup' | 'magiclink' | 'invite';

export type OAuthProvider = 'google' | 'apple' | 'github' | 'facebook';

/** Метод, которым юзер залогинился в последний раз на этом пейволе.
 *  Хранится per-paywall в storage и используется UI чтобы:
 *   - предзаполнить email-инпут last-known email'ом;
 *   - подсветить ту же OAuth-кнопку / email-форму бейджем "Last used".
 *  `email` — email/password forms (signin или signup → confirm). */
export type LastLoginMethod = OAuthProvider | 'email';

export interface LastLogin {
  method: LastLoginMethod;
  email: string | null;
}

/** Дискриминатор для `onAuthChange`. Позволяет listener'у отличать первый
 *  callback (восстановление сессии из storage / синтетический snapshot для
 *  свежей подписки) от реальных переходов. Конвенция Supabase, минус события,
 *  которых у нас нет (MFA, EMAIL_VERIFIED).
 *
 *  - INITIAL_SESSION — единственный гарантированный первый callback на каждую
 *    подписку. Дёргается через microtask после resolve hydrated-promise, даже
 *    если session=null. Listener'ы по этому event'у НЕ должны делать побочные
 *    эффекты типа force-refetch — это просто доставка стартового state'а.
 *  - SIGNED_IN — свежий вход: email/OAuth/anon, или появление session в этом
 *    инстансе из другого контекста (storage.watch), когда раньше был null.
 *  - SIGNED_OUT — signOut, revokeAllSessions, 401 на refresh, удаление session
 *    из другого контекста.
 *  - TOKEN_REFRESHED — тот же user, обновлённые токены: refresh(), либо
 *    storage.watch когда содержимое сменилось но user.id остался.
 *  - USER_UPDATED — изменился user.email / user.user_metadata (updatePassword,
 *    upgradeAnonymousToEmail) при том же user.id.
 *  - PASSWORD_RECOVERY — verifyOtp(type='recovery'). Listener знает, что надо
 *    показать «set new password» UI вместо обычного post-login flow'а. */
export type AuthChangeEvent =
  | 'INITIAL_SESSION'
  | 'SIGNED_IN'
  | 'SIGNED_OUT'
  | 'TOKEN_REFRESHED'
  | 'USER_UPDATED'
  | 'PASSWORD_RECOVERY';

export type AuthChangeListener = (event: AuthChangeEvent, session: AuthSession | null) => void;

export interface AuthClientOptions {
  paywallId: string;
  /** Origin серверного API SDK — обязательное поле, тот же `custom_domain`, что
   *  у BillingClient. См. {@link BillingClientOptions.apiOrigin}. */
  apiOrigin: string;
  storage?: StorageAdapter;
  fetch?: typeof fetch;
  // Inject для тестов и для Chrome-extension'ов (там popup можно открыть
  // через chrome.windows.create, а не window.open). По дефолту — window.open.
  openPopup?: (url: string, name: string) => Window | null;
}

interface RawTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number | null;
  token_type: 'bearer';
}

export class AuthClient {
  readonly paywallId: string;
  readonly apiOrigin: string;
  private storage: StorageAdapter;
  private api: ApiClient;
  private openPopup: (url: string, name: string) => Window | null;

  private session: AuthSession | null = null;
  private hydrated: Promise<void>;
  private inflightRefresh: Promise<AuthSession | null> | null = null;
  /** Дедупликация параллельных signInAnonymously: два click'а на «Войти как
   *  гость» должны попасть в одного юзера, не плодить двух (двойная капча +
   *  второй /signup создал бы вторую запись с потерянным trial-балансом). */
  private inflightAnonSignin: Promise<AuthSession> | null = null;
  private listeners = new Set<AuthChangeListener>();
  private storageUnwatch: (() => void) | null = null;
  private destroyed = false;
  /** Pending OAuth flows: state → {verifier, userMeta, startedAt}. Между
   *  startOAuthFlow и completeOAuthFlow. GC'атся через OAUTH_FLOW_TTL_MS. */
  private oauthFlows = new Map<
    string,
    {
      verifier: string;
      userMeta: Record<string, string> | undefined;
      provider: OAuthProvider;
      startedAt: number;
    }
  >();

  constructor(opts: AuthClientOptions) {
    if (!opts.paywallId) {
      throw new PaywallError('invalid_config', 'paywallId is required');
    }
    if (!opts.apiOrigin) {
      throw new PaywallError(
        'invalid_config',
        'apiOrigin is required. Pass the paywall custom_domain configured in the platform.'
      );
    }
    this.paywallId = opts.paywallId;
    this.apiOrigin = opts.apiOrigin;
    this.storage = createStorage(opts.storage);
    // Без getAuthToken — auth-эндпоинты либо публичные, либо мы кладём
    // Authorization вручную в headers (signOut). ApiClient не перетрёт его,
    // если getAuthToken отсутствует.
    this.api = new ApiClient({
      apiOrigin: this.apiOrigin,
      paywallId: opts.paywallId,
      fetch: opts.fetch
    });
    this.openPopup =
      opts.openPopup ??
      ((url, name) => {
        if (typeof window === 'undefined') return null;
        return window.open(url, name, 'width=480,height=640,popup=yes');
      });
    this.hydrated = this.hydrate();
    this.startStorageWatch();
  }

  /**
   * Подписывается на изменения session-ключа в storage из других контекстов:
   *  - Chrome Extension: `chrome.storage.onChanged` шарится popup ↔ background ↔
   *    options ↔ content script. Логин в одном контексте → остальные сразу
   *    эмитят onAuthChange и в getAccessToken отдают свежий Bearer.
   *  - Web: `window.storage` event фаерится в ДРУГИХ вкладках того же origin'а
   *    (своя вкладка свой setItem не получает — петель нет).
   *
   * Loop-guard: сравниваем content по полям session перед applySession, чтобы
   * не фрить лишних onAuthChange при идентичной перезаписи. Вызовы из других
   * контекстов с тем же содержимым (пересохранение) — no-op.
   */
  private startStorageWatch(): void {
    if (typeof this.storage.watch !== 'function') return;
    this.storageUnwatch = this.storage.watch(this.storageKey(), (raw) => {
      void this.applyExternalSession(raw);
    });
  }

  private async applyExternalSession(raw: string | null): Promise<void> {
    if (this.destroyed) return;
    // Дожидаемся первичной hydrate'а — иначе можем перетереть session, которая
    // ещё не успела загрузиться при construction'е.
    await this.hydrated;
    if (this.destroyed) return;
    if (raw == null) {
      // Удалили в другом контексте → logout всем подписчикам.
      if (this.session) {
        this.setSession(null, { skipPersist: true, event: 'SIGNED_OUT' });
      }
      return;
    }
    try {
      const parsed = JSON.parse(raw) as AuthSession | null;
      if (
        !parsed ||
        typeof parsed.access_token !== 'string' ||
        typeof parsed.refresh_token !== 'string' ||
        typeof parsed.expires_at !== 'number' ||
        !parsed.user
      ) {
        return;
      }
      // Cross-context update: классифицируем по тому, что было локально.
      // - Не было session → новый login из другой вкладки = SIGNED_IN.
      // - Был тот же user — это refresh-rotation = TOKEN_REFRESHED.
      // - Другой user.id — фактический switch аккаунта, тоже SIGNED_IN
      //   (для consumer'а это новый юзер).
      const event: AuthChangeEvent =
        !this.session || this.session.user.id !== parsed.user.id
          ? 'SIGNED_IN'
          : 'TOKEN_REFRESHED';
      this.setSession(parsed, { skipPersist: true, event });
    } catch {
      /* corrupted payload — игнорируем */
    }
  }

  /**
   * Promise гидратации session из storage. До его resolve getCachedSession()
   * может ещё вернуть null. getAccessToken/refresh/signOut/sign* awaitят его
   * сами, наружу выставляем для UI'я, чтобы он мог дождаться initial state
   * прежде чем рисовать «logged-out» вспышку.
   */
  ready(): Promise<void> {
    return this.hydrated;
  }

  /** Sync snapshot без сетевых запросов. null = разлогинен или ещё не гидрировались. */
  getCachedSession(): AuthSession | null {
    return this.session;
  }

  getCachedUser(): AuthUser | null {
    return this.session?.user ?? null;
  }

  /**
   * access_token для Authorization-хедера. Если до expiry < REFRESH_LEEWAY_MS,
   * делает lazy refresh. null = разлогинен или refresh упал на 401 (refresh
   * token revoked) — вызывающему стоит редиректить на логин.
   *
   * Сетевые/5xx ошибки refresh бросаются — текущий access ещё валиден,
   * вызывающий может попробовать запрос с ним; следующий getAccessToken
   * попробует refresh снова.
   */
  async getAccessToken(): Promise<string | null> {
    await this.hydrated;
    if (!this.session) {
      // Race window: другой контекст (popup) залогинился, но storage-watch
      // event ещё не долетел до этого инстанса (chrome.storage.onChanged
      // async). Один лишний storage read для разлогиненного case'а — приемлемая
      // плата за то, что background не отдаёт null когда токен уже есть.
      await this.rehydrateFromStorage();
      if (!this.session) return null;
    }
    if (this.isFresh(this.session)) return this.session.access_token;
    try {
      const refreshed = await this.refresh();
      return refreshed?.access_token ?? null;
    } catch {
      // Сеть упала — отдаём текущий (возможно скоро истечёт, но лучше чем null).
      return this.session?.access_token ?? null;
    }
  }

  async signInWithEmail(input: {
    email: string;
    password: string;
    userMeta?: Record<string, string>;
    /** Idempotency-key (UUID) — повторный submit при двойном клике вернёт
     *  тот же результат вместо второго запроса в GoTrue. Без передачи
     *  inflight-дедупликации нет; SDK не дедуплицирует auth по умолчанию,
     *  потому что email/password можно поменять между кликами. */
    idempotencyKey?: string;
  }): Promise<AuthSession> {
    await this.hydrated;
    const visitorId = await this.readVisitorId();
    type Resp = RawTokens & { user: AuthUser };
    const headers: Record<string, string> = {};
    if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;
    const resp = await this.api.request<Resp>(
      `/api/v1/paywall/${this.paywallId}/auth/email/signin`,
      {
        method: 'POST',
        headers: Object.keys(headers).length ? headers : undefined,
        body: JSON.stringify({
          email: input.email,
          password: input.password,
          visitor_id: visitorId,
          user_meta: input.userMeta
        })
      }
    );
    const session = this.toSession(resp, resp.user);
    this.setSession(session, { event: 'SIGNED_IN' });
    this.recordLastLogin('email', input.email);
    return session;
  }

  /**
   * Signup. Если в Supabase включён email confirm — сервер возвращает
   * `{status: 'confirmation_required', user}` и НЕ выдаёт токены. В этом
   * случае setSession не зовётся, юзер должен пройти OTP/magic-link
   * (отдельная фича следующего PR).
   */
  async signUp(input: {
    email: string;
    password: string;
    userMeta?: Record<string, string>;
    /** Idempotency-key (UUID). Защита от двойного клика на «Sign Up» —
     *  без неё бэк может создать trial-balances и отправить confirmation-email
     *  дважды. */
    idempotencyKey?: string;
  }): Promise<SignUpResult> {
    await this.hydrated;
    const visitorId = await this.readVisitorId();
    type Resp =
      | { status: 'confirmation_required'; user: { id: string; email: string } }
      | (RawTokens & { status: 'signed_in'; user: AuthUser });
    const headers: Record<string, string> = {};
    if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;
    const resp = await this.api.request<Resp>(
      `/api/v1/paywall/${this.paywallId}/auth/email/signup`,
      {
        method: 'POST',
        headers: Object.keys(headers).length ? headers : undefined,
        body: JSON.stringify({
          email: input.email,
          password: input.password,
          visitor_id: visitorId,
          user_meta: input.userMeta
        })
      }
    );
    if (resp.status === 'confirmation_required') {
      // Email-метод фиксируем заранее: после verifyOtp юзер вернётся уже без
      // нашего знания о выбранном flow (verifyOtp общий и для recovery), а
      // method хочется записать именно для UI-бейджа «Last used».
      this.recordLastLogin('email', input.email);
      return { kind: 'confirmation_required', user: resp.user };
    }
    const session = this.toSession(resp, resp.user);
    this.setSession(session, { event: 'SIGNED_IN' });
    this.recordLastLogin('email', input.email);
    return { kind: 'signed_in', session };
  }

  /**
   * Повторная отправка confirmation-email после signUp с включённым
   * email-confirm. Использует GoTrue `/resend` type='signup'. Бэк всегда
   * отдаёт ok (anti-enumeration), кроме 429 при rate-limit (~1 раз/мин на
   * email на стороне Supabase). Host обрабатывает 429 показом «подождите
   * минуту»; остальное — как success.
   */
  async resendConfirmation(input: {
    email: string;
    /** Защита от двойного клика. */
    idempotencyKey?: string;
  }): Promise<void> {
    await this.hydrated;
    const headers: Record<string, string> = {};
    if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;
    await this.api.request<{ ok: true }>(
      `/api/v1/paywall/${this.paywallId}/auth/email/resend`,
      {
        method: 'POST',
        headers: Object.keys(headers).length ? headers : undefined,
        body: JSON.stringify({ email: input.email })
      }
    );
  }

  /**
   * Email-OTP / signin без password. Шлёт 6-значный код юзеру на email.
   * Anti-enumeration: бэк всегда отдаёт ok, поэтому метод не различает
   * «email не существует» и «отправлено» — следующий шаг (verifyOtp) сам
   * упадёт invalid_otp если юзера нет. Под капотом GoTrue с create_user=true,
   * так что новые юзеры через OTP логинятся за один шаг (отправка → ввод
   * кода → session).
   */
  async sendOtp(input: {
    email: string;
    createUser?: boolean;
    userMeta?: Record<string, unknown>;
  }): Promise<void> {
    await this.hydrated;
    await this.api.request<{ ok: true }>(
      `/api/v1/paywall/${this.paywallId}/auth/otp/send`,
      {
        method: 'POST',
        body: JSON.stringify({
          email: input.email,
          create_user: input.createUser ?? true,
          user_meta: input.userMeta
        })
      }
    );
  }

  /**
   * Верификация OTP. type='email' (signin/signup-by-otp) — после успеха
   * setSession и onAuthChange. type='recovery' — после /requestPasswordReset:
   * выдаётся короткоживущий access_token для последующего updatePassword.
   * Мы храним recovery-session так же, как обычную: SDK не различает «можно
   * залогиниться» vs «можно сменить пароль» — это одна и та же session.
   */
  async verifyOtp(input: {
    email: string;
    token: string;
    type?: OtpVerifyType;
    userMeta?: Record<string, string>;
  }): Promise<AuthSession> {
    await this.hydrated;
    const visitorId = await this.readVisitorId();
    type Resp = RawTokens & { user: AuthUser };
    const resp = await this.api.request<Resp>(
      `/api/v1/paywall/${this.paywallId}/auth/otp/verify`,
      {
        method: 'POST',
        body: JSON.stringify({
          email: input.email,
          token: input.token,
          type: input.type ?? 'email',
          visitor_id: visitorId,
          user_meta: input.userMeta
        })
      }
    );
    const session = this.toSession(resp, resp.user);
    // type='recovery' — это session с короткоживущим токеном для последующего
    // updatePassword'а. PASSWORD_RECOVERY даёт UI знать, что надо показать
    // «set new password» вместо обычного post-login flow'а.
    const event: AuthChangeEvent =
      input.type === 'recovery' ? 'PASSWORD_RECOVERY' : 'SIGNED_IN';
    this.setSession(session, { event });
    return session;
  }

  /**
   * Запрос recovery email. Бэк всегда ok, чтобы не палить enumeration.
   * Юзер вводит код из письма в SDK-ui → verifyOtp({type:'recovery'}) →
   * получает session → updatePassword.
   */
  async requestPasswordReset(input: { email: string }): Promise<void> {
    await this.hydrated;
    await this.api.request<{ ok: true }>(
      `/api/v1/paywall/${this.paywallId}/auth/password/request-reset`,
      {
        method: 'POST',
        body: JSON.stringify({ email: input.email })
      }
    );
  }

  /**
   * Меняет пароль текущей session. Работает после verifyOtp({type:'recovery'})
   * (recovery-session) и после обычного логина — оба случая дают валидный
   * access_token. Если session нет — бросаем PaywallError('not_authenticated')
   * до сетевого запроса, чтобы UI не дёргал бэк впустую.
   */
  async updatePassword(input: { password: string }): Promise<void> {
    await this.hydrated;
    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      throw new PaywallError('not_authenticated', 'no active session');
    }
    await this.api.request<{ ok: true; user: { id: string; email: string | null } }>(
      `/api/v1/paywall/${this.paywallId}/auth/password/update`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ password: input.password })
      }
    );
  }

  /**
   * Анонимный signin (Supabase user без email). Лестница попыток:
   *
   *   1. Если уже залогинены анонимно (session.user.is_anonymous === true) —
   *      no-op, возвращаем текущую session. Идемпотентно для UI'я, который
   *      может звать signInAnonymously() в render-loop'е, не отслеживая state.
   *
   *   2. Resume через сохранённый anon refresh_token (`STORAGE_KEYS.anonRefreshToken`).
   *      Если токен есть — пробуем `/auth/refresh` им. Success → setSession,
   *      возвращаем юзера ТОГО ЖЕ id что был при предыдущем anon signin'е
   *      (обещание из user-фидбека: «если разлогинился из анонимного —
   *      логинить в этот же акк»).
   *
   *   3. Иначе → POST /auth/anonymous/signin → setSession + сохраняем
   *      refresh_token в anonRefreshToken.
   *
   * `captchaToken` сейчас не требуется — captcha protection в Supabase
   * отключена, защита от per-IP abuse держится на rate-limit'е Supabase'а
   * (30/час per real-IP, см. IP forwarding setup в supabaseAuthRest.ts) +
   * CF Bot Fight Mode на edge. Поле оставлено optional для forward-compat:
   * когда сервер начнёт возвращать challenge_required в риск-сценариях,
   * SDK сможет передать proof-of-something обратно без breaking change.
   *
   * `forceCaptcha: true` пропускает шаги 1-2 и сразу делает /signin (создаёт
   * нового anon-юзера). Используется в switch-account flow. Имя поля исторически
   * остаётся `forceCaptcha`, хотя капчи там больше нет — менять имя ломает
   * host-сигнатуру; смысл «принудительно новая anon-сессия» сохранён.
   *
   * Параллельные вызовы дедуплицируются через `inflightAnonSignin` — два
   * click'а на «Войти как гость» не создадут двух anon-юзеров (два /signup =
   * два user_id, второй trial-баланс улетает в нирвану).
   */
  async signInAnonymously(input: {
    captchaToken?: string;
    userMeta?: Record<string, string>;
    forceCaptcha?: boolean;
  } = {}): Promise<AuthSession> {
    if (this.inflightAnonSignin) return this.inflightAnonSignin;

    this.inflightAnonSignin = (async () => {
      await this.hydrated;

      // 1. Уже анон — не дёргаем сеть.
      if (
        !input.forceCaptcha &&
        this.session?.user.is_anonymous === true
      ) {
        return this.session;
      }

      // 2. Resume через сохранённый refresh_token.
      if (!input.forceCaptcha) {
        const resumed = await this.resumeAnonymous();
        if (resumed) return resumed;
      }

      // 3. Fresh signin. captcha_token шлём только если host явно передал
      //    (forward-compat для будущего challenge-response механизма).
      const visitorId = await this.readVisitorId();
      type Resp = RawTokens & { user: AuthUser };
      const resp = await this.api.request<Resp>(
        `/api/v1/paywall/${this.paywallId}/auth/anonymous/signin`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...(input.captchaToken ? { captcha_token: input.captchaToken } : {}),
            visitor_id: visitorId,
            user_meta: input.userMeta
          })
        }
      );

      // Бэк не выставляет is_anonymous=true в user-объекте? Подстраховка для
      // SDK-side флага: всегда true для этого роута.
      const user: AuthUser = {
        ...resp.user,
        email: resp.user.email ?? null,
        is_anonymous: true
      };
      const session = this.toSession(resp, user);
      this.setSession(session, { event: 'SIGNED_IN' });
      // Persist refresh для будущих resume — в writeAnonRefreshToken,
      // так же `setSession` уже сохранил полную session в authSession-storage.
      await this.writeAnonRefreshToken(session.refresh_token);
      return session;
    })();

    try {
      return await this.inflightAnonSignin;
    } finally {
      this.inflightAnonSignin = null;
    }
  }

  /**
   * Внутренний resume — пробует /auth/refresh с сохранённым anon refresh_token.
   * Возвращает session при успехе, null если токена нет или он отозван (401).
   * Сетевые ошибки бросает наружу — caller сам решает, ретраить или просить
   * пользователя пройти капчу.
   */
  private async resumeAnonymous(): Promise<AuthSession | null> {
    const rt = await this.readAnonRefreshToken();
    if (!rt) return null;
    try {
      const resp = await this.api.request<RawTokens>(
        `/api/v1/paywall/${this.paywallId}/auth/refresh`,
        { method: 'POST', body: JSON.stringify({ refresh_token: rt }) }
      );
      // /auth/refresh не возвращает user — реконструируем минимально из текущей
      // session (если был anon в storage) или ставим заглушку. Для полного
      // профиля host может позвать BillingClient.getUser().
      const fallbackUser: AuthUser =
        this.session?.user.is_anonymous === true
          ? this.session.user
          : { id: '', email: null, is_anonymous: true };
      const session = this.toSession(resp, fallbackUser);
      // resumeAnonymous вызывается только из signInAnonymously, где до этого
      // session=null (либо явно forceCaptcha=true). Для listener'а это вход
      // нового анон-юзера — SIGNED_IN. Если был тот же анон до hydrate'а —
      // sameSession отфильтрует emit.
      this.setSession(session, { event: 'SIGNED_IN' });
      // Rotation: GoTrue выдаёт новый refresh_token, обновляем persisted.
      await this.writeAnonRefreshToken(session.refresh_token);
      return session;
    } catch (e) {
      if (e instanceof PaywallError && e.status === 401) {
        // Токен отозван — чистим, fallthrough в caller'е сделает fresh signin
        // на /auth/anonymous/signin (создаст нового anon-юзера).
        await this.clearAnonRefreshToken();
        return null;
      }
      // Сеть/5xx — не трогаем токен, пусть юзер ретрайит.
      throw e;
    }
  }

  /**
   * Анон → email/password upgrade. Сохраняет тот же auth.user.id, балансы
   * и trial-quotas остаются. Поведение зависит от Supabase email-confirm
   * настройки проекта:
   *
   *  - Confirmation OFF → backend сразу обновляет email + password в auth.users.
   *    Возвращаем `kind: 'updated'`, локально патчим session.user.email +
   *    is_anonymous=false (текущий access_token остаётся валидным, перевыдавать
   *    не нужно — GoTrue не вращает токены на updateUser).
   *
   *  - Confirmation ON → backend отдаёт `confirmation_required`. Текущая
   *    session ОСТАЁТСЯ анонимной до клика юзером по confirmation-ссылке.
   *    Password применяется сразу (можно дальше логиниться по нему даже до
   *    confirm'а). После клика — следующий /auth/refresh подтянет обновлённый
   *    is_anonymous=false из JWT (refresh не возвращает user, так что
   *    UI может явно подёргать `auth.refresh()` через минуту-другую, либо
   *    дождаться lazy-refresh при истечении access).
   *
   * Без активной session бросает `not_authenticated`. Дедупликации нет —
   * двойной submit формы UI должен предотвратить idempotencyKey'ом.
   */
  async upgradeAnonymousToEmail(input: {
    email: string;
    password: string;
    userMeta?: Record<string, string>;
    /** Idempotency-key для защиты от двойного клика. GoTrue PUT /user не
     *  идемпотентен сам по себе — повторный submit при двойном клике может
     *  вызвать race с email-confirmation (две confirmation-ссылки на тот же
     *  адрес). UI должен передать UUID. */
    idempotencyKey?: string;
  }): Promise<UpgradeAnonymousResult> {
    await this.hydrated;
    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      throw new PaywallError('not_authenticated', 'no active session');
    }

    type Resp =
      | { status: 'updated'; user: AuthUser }
      | { status: 'confirmation_required'; email: string };

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`
    };
    if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;

    const resp = await this.api.request<Resp>(
      `/api/v1/paywall/${this.paywallId}/auth/anonymous/upgrade`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email: input.email,
          password: input.password,
          user_meta: input.userMeta
        })
      }
    );

    if (resp.status === 'confirmation_required') {
      // Не трогаем local session — она ещё анонимная по факту.
      return { kind: 'confirmation_required', email: resp.email };
    }

    // Confirmation off: патчим локальную user-часть session. Токены те же,
    // но user.email и is_anonymous теперь правильные — UI должен сразу
    // показывать «Signed in as <email>» вместо «Guest».
    const current = this.session;
    if (!current) {
      // Race: session ушёл между getAccessToken и сюда (signOut в другой
      // вкладке). Бэк уже обновил auth.users — но локально ничего не
      // меняем, host увидит чистое logged-out состояние.
      throw new PaywallError(
        'not_authenticated',
        'session disappeared during upgrade'
      );
    }
    const updatedUser: AuthUser = {
      ...current.user,
      id: resp.user.id,
      email: resp.user.email,
      is_anonymous: resp.user.is_anonymous ?? false
    };
    const updatedSession: AuthSession = { ...current, user: updatedUser };
    // Тот же набор токенов — изменился только user (anonymous→named).
    // USER_UPDATED, не SIGNED_IN: listener не должен трактовать это как
    // «появился новый юзер», это апгрейд того же сеанса.
    this.setSession(updatedSession, { event: 'USER_UPDATED' });

    // Юзер больше не анонимный — anon refresh_token «принадлежит» теперь
    // обычному акку. Не имеет смысла держать его как «вернуть в анона»:
    // на signOut он всё равно теперь полноценный logout. Чистим, чтобы
    // следующий signInAnonymously попросил новую капчу (не залогинит в
    // upgraded аккаунт случайно).
    await this.clearAnonRefreshToken();

    return { kind: 'updated', session: updatedSession };
  }

  /**
   * OAuth signin через popup с PKCE. Жизненный цикл:
   * 1. Генерим verifier+challenge+state локально (verifier не уходит на бэк
   *    до /exchange — это защита от перехвата code'а).
   * 2. POST /oauth/init с challenge → бэк отдаёт authorize_url.
   * 3. Открываем popup, ждём postMessage с типом 'pw-oauth' и нашим state.
   * 4. POST /oauth/exchange с {auth_code, code_verifier} → session.
   *
   * Таймаут — 5 минут от открытия popup'а. Если юзер закрыл popup до конца
   * флоу (window.closed → true) — бросаем PaywallError('oauth_cancelled').
   * Параллельные вызовы НЕ дедупятся — каждый открывает свой popup; вызывать
   * параллельно не имеет смысла, но защищаться от этого код не должен.
   *
   * onPopupOpened вызывается сразу после успешного window.open (до ожидания
   * code'а). UI использует это, чтобы сбросить loading-state кнопки: дальше
   * ответственность за флоу у popup'а, основная страница не должна висеть.
   * Если popup'ом не вернулся code (юзер закрыл вкладку, closed-detection
   * не сработал из-за COOP-severance) — promise дойдёт до oauth_timeout
   * через 5 минут, но кнопка к этому моменту уже свободна.
   */
  async signInWithOAuth(input: {
    provider: OAuthProvider;
    scopes?: string;
    userMeta?: Record<string, string>;
    onPopupOpened?: () => void;
  }): Promise<AuthSession> {
    if (typeof window === 'undefined') {
      throw new PaywallError('oauth_unavailable', 'window is required for OAuth');
    }

    // Single-process путь: start → openPopup → waitForOAuthCode → complete.
    // Состояние flow живёт у нас на heap'е до complete'а; для split-режима
    // (offscreen-architecture в @monetize/sdk-extension) start и complete
    // вызываются отдельными запросами — verifier остаётся внутри AuthClient'а.
    const { authorize_url, state } = await this.startOAuthFlow({
      provider: input.provider,
      scopes: input.scopes,
      userMeta: input.userMeta
    });

    const popup = this.openPopup(authorize_url, `pw-oauth-${state}`);
    if (!popup) {
      // Cleanup pending flow — без popup'а complete никогда не позовут.
      this.oauthFlows.delete(state);
      throw new PaywallError(
        'popup_blocked',
        'browser blocked auth popup — call from a user gesture'
      );
    }
    input.onPopupOpened?.();

    const code = await waitForOAuthCode(popup, state);

    if (this.destroyed) {
      this.oauthFlows.delete(state);
      throw new PaywallError('aborted', 'AuthClient destroyed mid-flow');
    }

    return this.completeOAuthFlow({ state, code });
  }

  /**
   * Шаг 1 OAuth split-API: инициирует flow на бэке, генерит PKCE verifier
   * + state, сохраняет их у себя, возвращает `{authorize_url, state}` для
   * открытия popup'а. Верификатор НЕ выходит наружу — его держит AuthClient
   * до `completeOAuthFlow`.
   *
   * Используется в offscreen-архитектуре (@monetize/sdk-extension): start
   * вызывается через RPC из content-script'а, content открывает popup
   * нативно (gesture preserved), затем зовёт completeOAuthFlow с code'ом.
   * AuthClient (в offscreen'е) делает /exchange с сохранённым verifier'ом.
   *
   * Pending flows GC'атся через 10мин — больше чем юзеру нужно прокликать
   * Google. Без cleanup'а Map бы рос на каждый закрытый popup.
   */
  async startOAuthFlow(input: {
    provider: OAuthProvider;
    scopes?: string;
    userMeta?: Record<string, string>;
  }): Promise<{ authorize_url: string; state: string }> {
    await this.hydrated;
    this.gcOAuthFlows();

    const verifier = generateCodeVerifier();
    const challenge = await deriveCodeChallenge(verifier);
    const state = generateState();

    // Anon-upgrade hand-off: если у нас уже есть session (обычно — анонимная
    // после signInAnonymously()), шлём её access_token на /oauth/init. Бэк
    // пойдёт через GoTrue `linkIdentity` вместо `signInWithOAuth` — после
    // OAuth callback'а user_id останется тот же, что был у анона, и
    // привязанные к нему trial-balances/purchases никуда не денутся.
    // Зеркалит legacy StartAuthPage.tsx (is_anonymous → linkIdentity).
    //
    // Если host хочет именно «свич аккаунт» (новый user_id) — он должен
    // сначала signOut({forgetAnonymous: true}), тогда session=null, Bearer
    // не уйдёт, и /oauth/init вернёт обычный signin-flow.
    const headers: Record<string, string> = {};
    const accessToken = await this.getAccessToken().catch((): string | null => null);
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    const { authorize_url } = await this.api.request<{ authorize_url: string }>(
      `/api/v1/paywall/${this.paywallId}/auth/oauth/init`,
      {
        method: 'POST',
        headers: Object.keys(headers).length ? headers : undefined,
        body: JSON.stringify({
          provider: input.provider,
          code_challenge: challenge,
          code_challenge_method: 's256',
          scopes: input.scopes
        })
      }
    );

    this.oauthFlows.set(state, {
      verifier,
      userMeta: input.userMeta,
      provider: input.provider,
      startedAt: Date.now()
    });

    // Method фиксируем до popup'а: provider в input явно указан юзером, в этой
    // точке мы 100% знаем что он выбрал. Не делать через app_metadata.provider
    // после exchange'а — для уже зарегистрированного юзера GoTrue возвращает
    // ПЕРВЫЙ зарегистрированный provider, а не текущий (зеркало легаси-фикса
    // в online/app/paywall/auth/callback/AuthCallback.tsx).
    this.recordLastLoginMethod(input.provider);

    return { authorize_url, state };
  }

  /**
   * Шаг 2 OAuth split-API: обменивает code (полученный из popup) на session,
   * используя verifier, сохранённый при startOAuthFlow. После успеха — set
   * session и эмит onAuthChange.
   *
   * Если flow не найден (state не из startOAuthFlow или GC'нулся за TTL'ом) —
   * бросает `oauth_invalid_state`. Caller должен начать заново через
   * startOAuthFlow.
   */
  async completeOAuthFlow(input: { state: string; code: string }): Promise<AuthSession> {
    await this.hydrated;
    const flow = this.oauthFlows.get(input.state);
    if (!flow) {
      throw new PaywallError(
        'oauth_invalid_state',
        'OAuth flow not found — start with startOAuthFlow first or check TTL'
      );
    }
    this.oauthFlows.delete(input.state);

    const visitorId = await this.readVisitorId();
    type Resp = RawTokens & { user: AuthUser };
    const resp = await this.api.request<Resp>(
      `/api/v1/paywall/${this.paywallId}/auth/oauth/exchange`,
      {
        method: 'POST',
        body: JSON.stringify({
          auth_code: input.code,
          code_verifier: flow.verifier,
          visitor_id: visitorId,
          user_meta: flow.userMeta
        })
      }
    );
    if (this.destroyed) {
      throw new PaywallError('aborted', 'AuthClient destroyed mid-flow');
    }
    const session = this.toSession(resp, resp.user);
    this.setSession(session, { event: 'SIGNED_IN' });
    // Email из session.user пишем только если бэк его вернул. У Apple email
    // приходит только на первом signin (если юзер не "Hide my email"); во всех
    // последующих login'ах session.user.email может быть null — тогда сохраняем
    // только method (он уже записан в startOAuthFlow).
    if (session.user.email) this.recordLastLoginEmail(session.user.email);
    return session;
  }

  private gcOAuthFlows(): void {
    const cutoff = Date.now() - OAUTH_FLOW_TTL_MS;
    for (const [k, v] of this.oauthFlows) {
      if (v.startedAt < cutoff) this.oauthFlows.delete(k);
    }
  }

  /**
   * Refresh access/refresh пары через текущий refresh_token. Дедуплицирует
   * параллельные вызовы (один in-flight promise на весь клиент).
   *
   * - 401 → refresh_token отозван/невалиден → чистим session, эмитим logout.
   * - Сеть/5xx → пробрасываем ошибку, session оставляем — юзер не должен
   *   разлогиниваться из-за временной сетевой проблемы.
   * - Нет session → возвращаем null без сетевого запроса.
   */
  async refresh(): Promise<AuthSession | null> {
    await this.hydrated;
    if (!this.session) return null;
    if (this.inflightRefresh) return this.inflightRefresh;

    const refreshToken = this.session.refresh_token;
    const currentUser = this.session.user;

    this.inflightRefresh = (async () => {
      try {
        const resp = await this.api.request<RawTokens>(
          `/api/v1/paywall/${this.paywallId}/auth/refresh`,
          {
            method: 'POST',
            body: JSON.stringify({ refresh_token: refreshToken })
          }
        );
        // Сервер user в /refresh не возвращает — переносим из текущей session.
        const session = this.toSession(resp, currentUser);
        this.setSession(session, { event: 'TOKEN_REFRESHED' });
        // Anon-rotation: refresh_token вращается на каждый refresh, держим
        // persisted-копию синхронной, иначе при signOut() и попытке resume
        // будет старый, уже отозванный токен → 401 → потеря анон-аккаунта.
        if (currentUser.is_anonymous === true) {
          await this.writeAnonRefreshToken(session.refresh_token);
        }
        return session;
      } catch (e) {
        if (e instanceof PaywallError && e.status === 401) {
          // Если refresh упал на анон-юзере — чистим anonRefreshToken тоже,
          // он невалиден. Иначе следующий resumeAnonymous() пойдёт по тому
          // же мёртвому токену и снова получит 401.
          if (currentUser.is_anonymous === true) {
            await this.clearAnonRefreshToken();
          }
          this.setSession(null, { event: 'SIGNED_OUT' });
          return null;
        }
        throw e;
      } finally {
        this.inflightRefresh = null;
      }
    })();

    return this.inflightRefresh;
  }

  /**
   * Глобальный logout — инвалидирует ВСЕ refresh-токены юзера на всех
   * устройствах/контекстах через GoTrue `/logout?scope=global`. Используется
   * для compromise-account флоу («подозрительная активность, разлогинить
   * везде»).
   *
   * Local-side: чистим текущую session, остальные контексты (другие вкладки
   * / extension popup и background) подхватят logout через storage-watch
   * автоматически. Active access-токены в других контекстах останутся валидны
   * до их естественного истечения (1 час max), но refresh уже не сработает —
   * после первого `getAccessToken()` каждый контекст разлогинится сам.
   *
   * Безопасность: бэк не принимает целевой user_id — резолвит юзера из
   * Bearer, нельзя разлогинить чужой аккаунт.
   */
  async revokeAllSessions(): Promise<void> {
    await this.hydrated;
    const accessToken = this.session?.access_token;
    if (!accessToken) {
      throw new PaywallError('not_authenticated', 'no active session');
    }
    // Сначала сетевой запрос, потом local clear — обратный порядок относительно
    // signOut(). Если бэк упадёт, оставляем юзера залогиненным локально (он
    // может попробовать ещё раз); UX-преимущество мгновенного logout'а здесь
    // меньше, чем риск думать что устройство разлогинено когда оно не
    // разлогинено реально.
    await this.api.request<{ ok: true }>(
      `/api/v1/paywall/${this.paywallId}/auth/revoke-all`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );
    this.setSession(null, { event: 'SIGNED_OUT' });
  }

  /**
   * Signout: чистит локальную session СРАЗУ (UX — мгновенный logout без
   * ожидания сети), потом best-effort POST /auth/signout с текущим access.
   * Ошибка сети/5xx тут уже не критична — на бэке токен и так истечёт.
   *
   * Anon-aware: по умолчанию anonRefreshToken сохраняется. Это позволяет
   * после signOut() позвать signInAnonymously() и попасть в ТОТ ЖЕ
   * анон-аккаунт без капчи (см. resumeAnonymous). Поведение предсказуемое
   * для UX'а «гость → залогинился → разлогинился → снова гость с теми же
   * балансами».
   *
   * `forgetAnonymous: true` — полное забытие, вместе с anonRefreshToken.
   * Нужно для сценариев типа «свич аккаунта на устройстве» или жалоб на
   * приватность («очисти все мои следы»).
   */
  async signOut(opts: { forgetAnonymous?: boolean } = {}): Promise<void> {
    await this.hydrated;
    const accessToken = this.session?.access_token;
    const wasAnonymous = this.session?.user.is_anonymous === true;
    this.setSession(null, { event: 'SIGNED_OUT' });
    if (opts.forgetAnonymous) {
      await this.clearAnonRefreshToken();
    }
    if (!accessToken) return;
    // Тонкий момент: GoTrue `/logout` (scope=local default) инвалидирует
    // текущий refresh_token. Для анона текущий refresh_token = anonRefreshToken
    // в нашем storage'е; если позвать /logout — anonRefreshToken станет
    // невалиден, и следующий signInAnonymously() не сможет resume этого
    // юзера. Поэтому при signOut'е анона БЕЗ forgetAnonymous пропускаем
    // /logout — токен остаётся живым для будущего возврата. Local-side
    // юзер уже разлогинен (setSession(null)), что и нужно UX'у.
    if (wasAnonymous && !opts.forgetAnonymous) return;
    try {
      await this.api.request(
        `/api/v1/paywall/${this.paywallId}/auth/signout`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` }
        }
      );
    } catch {
      /* swallow — local state уже чистый */
    }
  }

  /**
   * Подписка на изменения session: signin/signup/refresh/signOut/expired-401.
   *
   * Гарантированный контракт: ПЕРВЫЙ callback каждому subscriber'у — всегда
   * `event = 'INITIAL_SESSION'`, дёргается асинхронно после resolve hydrate'а
   * (даже если session=null — listener получает explicit «нет сессии», а не
   * молчание). Все последующие callback'и — реальные переходы с конкретным
   * event'ом (SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED / USER_UPDATED /
   * PASSWORD_RECOVERY).
   *
   * Это позволяет listener'у безопасно делать «only on real signin» побочные
   * эффекты (force refetch balances и т.п.) через `event === 'SIGNED_IN'`,
   * не путая их с восстановлением из storage.
   *
   * Возвращает unsubscribe.
   */
  onAuthChange(cb: AuthChangeListener): () => void {
    this.listeners.add(cb);
    // INITIAL_SESSION после hydrate'а: даём время storage.getItem отработать,
    // чтобы listener получил настоящий restored state, а не пустоту. Если до
    // resolve'а уже произошёл setSession (cross-context signin прилетел через
    // applyExternalSession, или сразу sign-in пользователем) — это ок,
    // listener сначала получит INITIAL_SESSION с текущим (уже обновлённым)
    // snapshot'ом, потом — событие самого перехода. Дубль snapshot'а не страшен,
    // главное что event'ы различимы.
    void this.hydrated.then(() => {
      if (this.destroyed || !this.listeners.has(cb)) return;
      const snapshot = this.session;
      try {
        cb('INITIAL_SESSION', snapshot);
      } catch (e) {
        console.warn('[paywall] onAuthChange INITIAL_SESSION threw', e);
      }
    });
    return () => {
      this.listeners.delete(cb);
    };
  }

  private isFresh(s: AuthSession): boolean {
    return s.expires_at - Date.now() > REFRESH_LEEWAY_MS;
  }

  private toSession(raw: RawTokens, user: AuthUser): AuthSession {
    // GoTrue отдаёт expires_at в секундах (unix), expires_in — в секундах.
    // SDK хранит абсолютный ms, чтобы isFresh() был тривиальным сравнением.
    const expiresAt =
      raw.expires_at != null
        ? raw.expires_at * 1000
        : Date.now() + raw.expires_in * 1000;
    return {
      access_token: raw.access_token,
      refresh_token: raw.refresh_token,
      expires_at: expiresAt,
      user
    };
  }

  private setSession(
    s: AuthSession | null,
    opts: { event: AuthChangeEvent; skipPersist?: boolean }
  ): void {
    if (this.destroyed) return;
    const before = this.session;
    this.session = s;
    // skipPersist: применяем session, пришедшую из storage-watch'а
    // (другой контекст уже записал ровно это в storage). Без флага мы бы
    // делали лишний writeback и в Chrome Extension получили бы петлю
    // onChanged → applyExternalSession → setSession → persist → onChanged.
    if (!opts.skipPersist) void this.persist();
    if (!sameSession(before, s)) this.emit(opts.event);
  }

  private emit(event: AuthChangeEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event, this.session);
      } catch (e) {
        console.warn('[paywall] onAuthChange listener threw', e);
      }
    }
  }

  private storageKey(): string {
    return STORAGE_KEYS.authSession(this.paywallId);
  }

  private async hydrate(): Promise<void> {
    try {
      const raw = await this.storage.getItem(this.storageKey());
      if (!raw) return;
      const parsed = JSON.parse(raw) as AuthSession | null;
      if (
        !parsed ||
        typeof parsed.access_token !== 'string' ||
        typeof parsed.refresh_token !== 'string' ||
        typeof parsed.expires_at !== 'number' ||
        !parsed.user
      ) {
        return;
      }
      // Просроченный access — оставляем session, lazy refresh подберёт.
      // Если refresh_token тоже мёртв (>30 дней неактивности), refresh
      // упадёт 401 и AuthClient разлогинит сам.
      //
      // НЕ зовём emit() — listener'ы получат восстановленную session
      // отдельным INITIAL_SESSION callback'ом из onAuthChange после resolve
      // hydrated. Это разделяет «сессия восстановилась из storage» от
      // «реальный signin», что важно для consumer'ов вроде demo content'а,
      // которые на signin делают force-refetch balances.
      this.session = parsed;
    } catch {
      /* corrupted entry — игнорируем, юзер просто увидит logged-out */
    }
  }

  // Используется как race-fallback в getAccessToken: между construction'ом
  // (когда storage был пуст) и onChanged-доставкой могло произойти signin
  // в другом контексте. Не дублирует watch — тот про push, этот про pull.
  private async rehydrateFromStorage(): Promise<void> {
    try {
      const raw = await this.storage.getItem(this.storageKey());
      if (!raw) return;
      const parsed = JSON.parse(raw) as AuthSession | null;
      if (
        !parsed ||
        typeof parsed.access_token !== 'string' ||
        typeof parsed.refresh_token !== 'string' ||
        typeof parsed.expires_at !== 'number' ||
        !parsed.user
      ) {
        return;
      }
      // Вызывается только когда `this.session` был null и юзер где-то залогинился
      // вне этого контекста — для listener'а это SIGNED_IN (того же класса
      // событие, что и cross-context login в applyExternalSession).
      this.setSession(parsed, { skipPersist: true, event: 'SIGNED_IN' });
    } catch {
      /* ignore */
    }
  }

  /**
   * Освобождает ресурсы AuthClient'а: отписывает storage-watch, чистит
   * listener'ы, выставляет destroyed-флаг. После destroy все async-операции
   * (inflight refresh, OAuth popup, applyExternalSession) early-return'ят
   * через `isDestroyed()` guard'ы — никаких write-back'ов в storage,
   * никаких эмитов на пустые listener'ы.
   *
   * destroy() идемпотентен: повторный вызов — no-op.
   */
  destroy(): void {
    this.destroyed = true;
    if (this.storageUnwatch) {
      this.storageUnwatch();
      this.storageUnwatch = null;
    }
    this.listeners.clear();
    // inflightRefresh не отменяется (Promise нельзя cancel'нуть), но его
    // success-handler проверяет destroyed и пропускает setSession. То же
    // для waitForOAuthCode — добавляется guard в signInWithOAuth.
    this.inflightRefresh = null;
  }

  /** Sync-проверка: был ли вызван destroy(). Полезно для UI / тестов. */
  isDestroyed(): boolean {
    return this.destroyed;
  }

  private async persist(): Promise<void> {
    try {
      if (this.session) {
        await this.storage.setItem(
          this.storageKey(),
          JSON.stringify(this.session)
        );
      } else {
        await this.storage.removeItem(this.storageKey());
      }
    } catch {
      /* quota / disabled — не критично, in-memory состояние верное */
    }
  }

  private async readAnonRefreshToken(): Promise<string | null> {
    try {
      const v = await this.storage.getItem(STORAGE_KEYS.anonRefreshToken(this.paywallId));
      return typeof v === 'string' && v.length > 0 ? v : null;
    } catch {
      return null;
    }
  }

  private async writeAnonRefreshToken(token: string): Promise<void> {
    try {
      await this.storage.setItem(
        STORAGE_KEYS.anonRefreshToken(this.paywallId),
        token
      );
    } catch {
      /* quota / disabled — anon resume сломается, но текущая session жива */
    }
  }

  private async clearAnonRefreshToken(): Promise<void> {
    try {
      await this.storage.removeItem(
        STORAGE_KEYS.anonRefreshToken(this.paywallId)
      );
    } catch {
      /* ignore */
    }
  }

  /**
   * Last-used auth method + email — для UI бейджа "Last used" и pre-fill'а
   * email-инпута. Storage paywall-scoped, поэтому переключение между
   * пейволами на одном host'е не пересекает данные. Чтение всегда возвращает
   * объект — отсутствующие поля = null. */
  async getLastLogin(): Promise<LastLogin | null> {
    try {
      const [method, email] = await Promise.all([
        this.storage.getItem(STORAGE_KEYS.lastLoginMethod(this.paywallId)),
        this.storage.getItem(STORAGE_KEYS.lastLoginEmail(this.paywallId))
      ]);
      if (!method) return null;
      if (!isLastLoginMethod(method)) return null;
      return { method, email: typeof email === 'string' && email ? email : null };
    } catch {
      return null;
    }
  }

  /** Запись method и email атомарно (для email/password flows — оба известны
   *  на момент signin/signup'а). OAuth-flows используют раздельные
   *  recordLastLoginMethod (до popup) и recordLastLoginEmail (после exchange). */
  private recordLastLogin(method: LastLoginMethod, email: string | null): void {
    this.recordLastLoginMethod(method);
    if (email) this.recordLastLoginEmail(email);
  }

  private recordLastLoginMethod(method: LastLoginMethod): void {
    // Fire-and-forget — UI-фича, не блокируем signin flow. Ошибки storage
    // (quota / private mode) ломают только бейдж, не сам signin.
    this.storage
      .setItem(STORAGE_KEYS.lastLoginMethod(this.paywallId), method)
      .catch(() => {});
  }

  private recordLastLoginEmail(email: string): void {
    this.storage
      .setItem(STORAGE_KEYS.lastLoginEmail(this.paywallId), email)
      .catch(() => {});
  }

  /**
   * Читает stable visitor_id из storage если он там уже есть. НЕ генерит:
   * AuthClient может быть инстанцирован раньше BillingClient, а синтетический
   * visitor_id без касания пейвола не имеет смысла (нет гостевых покупок,
   * которые надо бы линковать). undefined → бэк сам пропустит ветку
   * "merge guest purchases".
   */
  private async readVisitorId(): Promise<string | undefined> {
    try {
      const v = await this.storage.getItem(STORAGE_KEYS.visitorId);
      return typeof v === 'string' && v.length >= 16 ? v : undefined;
    } catch {
      return undefined;
    }
  }
}

// Таймаут OAuth-флоу. 5 минут с запасом покрывают: 2FA в Google, ручной
// switch-account в Apple, медленную сеть. Дольше — почти гарантированно
// зависший popup, лучше показать ошибку.
const OAUTH_TIMEOUT_MS = 5 * 60_000;
// Период проверки window.closed. Браузер не эмитит событие закрытия popup'а
// для cross-origin окон, поэтому опрашиваем поллингом. 500ms — компромисс
// между отзывчивостью и cpu.
const OAUTH_POLL_MS = 500;

interface OAuthMessage {
  type?: string;
  status?: string;
  code?: string;
  error?: string;
  description?: string;
  messageId?: string;
}

/** Ожидает OAuth-callback в popup'е и резолвится с code'ом. Используется
 *  в `signInWithOAuth` и при split-API flow (где popup открывается извне,
 *  например в content-script'е extension'а с offscreen-AuthClient'ом). */
export function waitForOAuthCode(popup: Window, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      settled = true;
      window.removeEventListener('message', onMessage);
      clearInterval(closedTimer);
      clearTimeout(timeoutTimer);
    };

    const onMessage = (e: MessageEvent) => {
      if (settled) return;
      const data = e.data as OAuthMessage | null;
      if (!data || data.type !== 'pw-oauth') return;
      // Origin не валидируем: callback page отсылает с targetOrigin='*' из-за
      // COOP-ограничений в popup'е. state — единственный нонc, привязанный
      // к открытому popup'у в этой странице, так что defence именно через
      // него: чужой постмессадж не знает наш state.
      if (data.messageId !== expectedState) return;

      if (data.status === 'success' && data.code) {
        cleanup();
        try { popup.close(); } catch { /* ignore */ }
        resolve(data.code);
      } else if (data.status === 'error') {
        cleanup();
        try { popup.close(); } catch { /* ignore */ }
        reject(
          new PaywallError(
            'oauth_failed',
            data.description || data.error || 'OAuth provider returned error'
          )
        );
      }
    };

    // window.closed — true когда юзер закрыл popup сам или браузер закрыл его
    // из-за провайдерской ошибки (некоторые провайдеры так делают). Закрытие
    // без message = отмена.
    const closedTimer = setInterval(() => {
      if (settled) return;
      let closed: boolean;
      try {
        closed = popup.closed;
      } catch {
        // Cross-origin доступ запрещён — лучше игнорировать, чем падать.
        return;
      }
      if (closed) {
        cleanup();
        reject(new PaywallError('oauth_cancelled', 'auth popup was closed'));
      }
    }, OAUTH_POLL_MS);

    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      cleanup();
      try { popup.close(); } catch { /* ignore */ }
      reject(new PaywallError('oauth_timeout', 'OAuth flow timed out'));
    }, OAUTH_TIMEOUT_MS);

    window.addEventListener('message', onMessage);
  });
}

function isLastLoginMethod(v: unknown): v is LastLoginMethod {
  return (
    v === 'google' || v === 'apple' || v === 'github' || v === 'facebook' || v === 'email'
  );
}

function sameSession(a: AuthSession | null, b: AuthSession | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.access_token === b.access_token &&
    a.refresh_token === b.refresh_token &&
    a.expires_at === b.expires_at &&
    a.user.id === b.user.id &&
    a.user.email === b.user.email
  );
}
