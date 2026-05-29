// RemoteAuthClient — структурный совместимец AuthClient. Public методы
// идентичны, под капотом — async-прокси через TransportClient в offscreen,
// где живёт реальная сессия и storage.
//
// Sync-getCachedSession поддерживается через локальный mirror, обновляемый
// (a) на каждом ответе async-метода, (b) на broadcast'е authChange.
//
// OAuth (signInWithOAuth) пока бросает not-implemented — требует publicного
// split-API в @sdk/core/auth (Phase 4.5). Для email/password/refresh/signOut
// и прочей сетевой части — всё работает.

import type {
  AuthChangeEvent,
  AuthSession,
  AuthUser,
  LastLogin,
  OAuthProvider,
  OtpVerifyType,
  SignUpResult
} from '@sdk/core/auth';
import { waitForOAuthCode } from '@sdk/core/auth';
import { PaywallError } from '@sdk/core/types';
import { TransportClient } from '../shared/transport-client';

export type AuthChangeListener = (event: AuthChangeEvent, session: AuthSession | null) => void;

export interface RemoteAuthClientOptions {
  paywallId: string;
  apiOrigin?: string;
}

export class RemoteAuthClient {
  readonly paywallId: string;
  readonly apiOrigin: string | undefined;

  private session: AuthSession | null = null;
  private listeners = new Set<AuthChangeListener>();
  private unsubBroadcast: (() => void) | null = null;
  private hydrated: Promise<void>;

  constructor(
    private readonly transport: TransportClient,
    opts: RemoteAuthClientOptions
  ) {
    this.paywallId = opts.paywallId;
    this.apiOrigin = opts.apiOrigin;

    this.unsubBroadcast = this.transport.on('authChange', ({ event, session }) => {
      this.applySession(event, session);
    });

    // Initial sync с offscreen'а — поднимаем restored session в local mirror
    // ДО первого `getCachedSession()`. listeners получат восстановленную
    // session через свой собственный INITIAL_SESSION microtask из onAuthChange
    // (см. ниже) — не дёргаем applySession, чтобы не превратить «восстановление
    // из storage» в выглядящий как-будто-signin event.
    this.hydrated = this.transport
      .request('auth.getCachedSession', undefined)
      .then((session) => {
        // Конкурентность: если за время request'а кто-то уже выставил session
        // (broadcast SIGNED_IN или локальный signIn-метод), не перетираем —
        // hydrate-снимок stale относительно того, что уже в local mirror.
        if (this.session === null && session !== null) {
          this.session = session;
        }
      })
      .catch(() => {
        /* offscreen не готов или транспорт упал — getCachedSession отдаст null */
      });
  }

  /** Promise, который резолвится после первичной синхронизации session с
   *  offscreen'а. Аналог AuthClient.ready(). */
  ready(): Promise<void> {
    return this.hydrated;
  }

  getCachedSession(): AuthSession | null {
    return this.session;
  }

  getCachedUser(): AuthUser | null {
    return this.session?.user ?? null;
  }

  onAuthChange(cb: AuthChangeListener): () => void {
    this.listeners.add(cb);
    // Always-fire INITIAL_SESSION после hydrate'а — match @sdk/core AuthClient.
    // Контракт: первый callback = INITIAL_SESSION с restored snapshot'ом
    // (или null), последующие = реальные переходы через applySession.
    void this.hydrated.then(() => {
      if (!this.listeners.has(cb)) return;
      try {
        cb('INITIAL_SESSION', this.session);
      } catch (e) {
        console.warn('[paywall] onAuthChange INITIAL_SESSION threw', e);
      }
    });
    return () => {
      this.listeners.delete(cb);
    };
  }

  // === Email/password ===

  async signInWithEmail(input: { email: string; password: string }): Promise<AuthSession> {
    const session = await this.transport.request('auth.signInWithEmail', input);
    // Локальный mirror-update + emit. Broadcast от offscreen'а тоже прилетит
    // с тем же event'ом — `sameSession` guard в applySession отсечёт второй
    // emit, не дёргая listener'ов дважды.
    this.applySession('SIGNED_IN', session);
    return session;
  }

  async signUp(input: {
    email: string;
    password: string;
    userMeta?: Record<string, string>;
  }): Promise<SignUpResult> {
    const result = await this.transport.request('auth.signUp', input);
    if (result.kind === 'signed_in') this.applySession('SIGNED_IN', result.session);
    return result;
  }

  async signOut(): Promise<void> {
    await this.transport.request('auth.signOut', undefined);
    // Broadcast authChange придёт от offscreen'а с session=null, applySession
    // там уже отработает. Тут ничего не делаем, чтобы не дёрнуть listener'ы
    // дважды.
  }

  async refresh(): Promise<AuthSession | null> {
    const session = await this.transport.request('auth.refresh', undefined);
    this.applySession(session ? 'TOKEN_REFRESHED' : 'SIGNED_OUT', session);
    return session;
  }

  // === OTP / password reset / confirmation ===

  async sendOtp(input: {
    email: string;
    createUser?: boolean;
    userMeta?: Record<string, unknown>;
  }): Promise<void> {
    await this.transport.request('auth.sendOtp', input);
  }

  async verifyOtp(input: {
    email: string;
    token: string;
    type: OtpVerifyType;
  }): Promise<AuthSession> {
    const session = await this.transport.request('auth.verifyOtp', input);
    this.applySession(input.type === 'recovery' ? 'PASSWORD_RECOVERY' : 'SIGNED_IN', session);
    return session;
  }

  async resendConfirmation(input: { email: string }): Promise<void> {
    await this.transport.request('auth.resendConfirmation', input);
  }

  async requestPasswordReset(input: { email: string }): Promise<void> {
    await this.transport.request('auth.requestPasswordReset', input);
  }

  async updatePassword(input: { password: string }): Promise<void> {
    await this.transport.request('auth.updatePassword', input);
  }

  async revokeAllSessions(): Promise<void> {
    await this.transport.request('auth.revokeAllSessions', undefined);
  }

  /** Last-used auth method + email — читается из offscreen-storage. AuthPanel
   *  использует для "Last used"-бейджа и pre-fill'а email. Storage paywall-
   *  scoped, и offscreen — единый источник правды для всех вкладок/popup'ов. */
  async getLastLogin(): Promise<LastLogin | null> {
    return this.transport.request('auth.getLastLogin', undefined);
  }

  // === Anonymous sign-in ===

  /** Анонимный sign-in (Supabase user без email). Логика (idempotent-check +
   *  resume через сохранённый refresh_token + fresh signin) живёт в
   *  offscreen-AuthClient'е — content только проксирует. captchaToken и
   *  forceNewAnon — pass-through для forward-compat / switch-account flow. */
  async signInAnonymously(input: {
    captchaToken?: string;
    userMeta?: Record<string, string>;
    forceNewAnon?: boolean;
  } = {}): Promise<AuthSession> {
    const session = await this.transport.request('auth.signInAnonymously', {
      captchaToken: input.captchaToken,
      userMeta: input.userMeta,
      forceNewAnon: input.forceNewAnon
    });
    this.applySession('SIGNED_IN', session);
    return session;
  }

  /** Текущий access token (lazy-refreshable в offscreen'е). content/popup
   *  использует для Bearer'а в внешние fetch'и — ApiGatewayClient в
   *  content-script'е, прямые запросы из demo-UI. null если разлогинен или
   *  offscreen'овский AuthClient не смог рефрешнуть. */
  async getAccessToken(): Promise<string | null> {
    return this.transport.request('auth.getAccessToken', undefined);
  }

  // === OAuth (web-flow через split-API) ===

  /** OAuth через web-вариант: window.open в content-script'е, provider
   *  redirect, callback page постит code в opener. Под капотом split на
   *  два request'а в offscreen — startOAuthFlow (дёргаем /init, получаем
   *  authorize_url) → открываем popup → waitForOAuthCode → exchange.
   *
   *  PKCE verifier живёт ТОЛЬКО в offscreen'е (внутри AuthClient'а), через
   *  runtime-границу не идёт. Content получает только authorize_url и state.
   *
   *  Popup-gesture: `window.open(authorize_url, ...)` идёт в том же synchronous
   *  flow'е, что startOAuthFlow ответ; user-gesture сохраняется потому что
   *  content-script unloaded не за этот tick (gesture сохраняется через все
   *  microtask'и одного call stack'а). Если в каком-то браузере gesture
   *  всё-таки теряется — host получит `popup_blocked` (тот же что в @monetize.software/sdk).
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

    // Открываем popup СИНХРОННО — user-gesture сохраняется только в том же
    // synchronous frame, что click-handler. Async `await` на transport.request
    // до window.open съедает gesture, и Chrome открывает popup с пустым URL'ом
    // / блокирует совсем.
    //
    // about:blank вместо data:text/html (которым раньше показывали inline-loader):
    // data:-URL'ы триггерят static-сканеры CWS и EDR'ы как подозрительные. Вместо
    // этого открываем about:blank (наследует origin opener'а) и инжектим loader-DOM
    // через document.createElement + textContent — ровно то же UX, без data:-URL'а.
    const tempName = `pw-oauth-pending-${Math.random().toString(36).slice(2, 10)}`;
    const popup = window.open('about:blank', tempName, 'width=480,height=640,popup=yes');
    if (!popup) {
      throw new PaywallError(
        'popup_blocked',
        'browser blocked auth popup — call from a user gesture'
      );
    }
    injectLoaderUI(popup, input.provider);

    try {
      // Async-часть: дёргаем offscreen за authorize_url и state. Popup пока
      // показывает about:blank.
      const { authorizeUrl, state } = await this.transport.request('auth.oauthStart', {
        provider: input.provider,
        scopes: input.scopes,
        userMeta: input.userMeta
      });

      // Перед navigate'ом меняем имя popup'а на формат, который ожидает
      // callback page (pw-oauth-<state>) — name переживает cross-origin
      // редиректы (Google → Supabase → наш callback). callback page
      // читает window.name → извлекает state → posts back.
      popup.name = `pw-oauth-${state}`;
      popup.location.replace(authorizeUrl);

      input.onPopupOpened?.();

      const code = await waitForOAuthCode(popup, state);
      const session = await this.transport.request('auth.oauthExchange', { state, code });
      this.applySession('SIGNED_IN', session);
      return session;
    } catch (e) {
      try {
        popup.close();
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  destroy(): void {
    this.unsubBroadcast?.();
    this.unsubBroadcast = null;
    this.listeners.clear();
    this.session = null;
  }

  private applySession(event: AuthChangeEvent, next: AuthSession | null): void {
    if (sameSession(this.session, next)) return;
    this.session = next;
    for (const cb of [...this.listeners]) {
      try {
        cb(event, next);
      } catch (e) {
        console.warn('[paywall] onAuthChange listener threw', e);
      }
    }
  }
}

function sameSession(a: AuthSession | null, b: AuthSession | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.access_token === b.access_token &&
    a.refresh_token === b.refresh_token &&
    a.expires_at === b.expires_at &&
    a.user.id === b.user.id
  );
}

const PROVIDER_NAMES: Record<string, string> = {
  google: 'Google',
  apple: 'Apple',
  github: 'GitHub',
  facebook: 'Facebook'
};

/** Inject loader-UI в about:blank popup. Same-origin как opener — мы можем
 *  трогать popup.document напрямую. Используем createElement + textContent
 *  (не innerHTML / document.write) чтобы не триггерить XSS-сканеры даже на
 *  hard-coded строках. CSS-классы с pw-oauth-* префиксом — без коллизий со
 *  стилями родительской страницы (popup всё равно изолирован, но на всякий).
 *
 *  Defensive try/catch: если в каком-то edge-кейсе popup оказался не
 *  same-origin (некоторые расширения это перехватывают) или document не
 *  доступен — тихо забиваем, popup покажет дефолтный about:blank на 200-500мс
 *  до redirect'а на provider'а. */
function injectLoaderUI(popup: Window, provider: string): void {
  const name = PROVIDER_NAMES[provider] ?? provider;
  try {
    const doc = popup.document;
    doc.title = `Sign in with ${name}`;

    const style = doc.createElement('style');
    style.textContent =
      'html,body{margin:0;padding:0;height:100%;font-family:-apple-system,system-ui,sans-serif;background:#fafafa;color:#475569}' +
      '.pw-oauth-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px}' +
      '.pw-oauth-spinner{width:36px;height:36px;border:3px solid #e2e8f0;border-top-color:#7c3aed;border-radius:50%;animation:pw-oauth-spin 800ms linear infinite}' +
      '.pw-oauth-label{font-size:14px;font-weight:500;letter-spacing:-0.01em}' +
      '@keyframes pw-oauth-spin{to{transform:rotate(360deg)}}';
    doc.head.appendChild(style);

    const wrap = doc.createElement('div');
    wrap.className = 'pw-oauth-wrap';
    const spinner = doc.createElement('div');
    spinner.className = 'pw-oauth-spinner';
    const label = doc.createElement('div');
    label.className = 'pw-oauth-label';
    label.textContent = `Connecting to ${name}…`;
    wrap.appendChild(spinner);
    wrap.appendChild(label);
    doc.body.appendChild(wrap);
  } catch {
    /* popup not same-origin or document not ready — fall back to blank */
  }
}
