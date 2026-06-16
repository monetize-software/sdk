// RemoteAuthClient — a structural match for AuthClient. The public methods are
// identical, under the hood it's an async proxy through TransportClient into
// offscreen, where the real session and storage live.
//
// Sync getCachedSession is supported via a local mirror, updated (a) on every
// async-method response, (b) on an authChange broadcast.
//
// OAuth (signInWithOAuth) used to throw not-implemented — it required a public
// split API in @sdk/core/auth (Phase 4.5). For email/password/refresh/signOut
// and the rest of the network part — everything works.

import type {
  AuthChangeEvent,
  AuthSession,
  AuthUser,
  LastLogin,
  OAuthProvider,
  OtpVerifyType,
  SignUpResult
} from '@sdk/core/auth';
import { waitForOAuthResult } from '@sdk/core/auth';
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

    // Initial sync from offscreen — bring the restored session into the local
    // mirror BEFORE the first `getCachedSession()`. Listeners receive the
    // restored session via their own INITIAL_SESSION microtask from onAuthChange
    // (see below) — we don't call applySession, so as not to turn "restore from
    // storage" into a looks-like-signin event.
    this.hydrated = this.transport
      .request('auth.getCachedSession', undefined)
      .then((session) => {
        // Concurrency: if during the request someone already set the session
        // (a SIGNED_IN broadcast or a local signIn method), don't overwrite —
        // the hydrate snapshot is stale relative to what's already in the local mirror.
        if (this.session === null && session !== null) {
          this.session = session;
        }
      })
      .catch(() => {
        /* offscreen isn't ready or the transport failed — getCachedSession returns null */
      });
  }

  /** A promise that resolves after the initial session sync from offscreen.
   *  The analog of AuthClient.ready(). */
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
    // Always-fire INITIAL_SESSION after hydrate — matches @sdk/core AuthClient.
    // Contract: the first callback = INITIAL_SESSION with the restored snapshot
    // (or null), subsequent ones = real transitions via applySession.
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
    // Local mirror update + emit. The broadcast from offscreen will also arrive
    // with the same event — the `sameSession` guard in applySession cuts off the
    // second emit, so listeners aren't called twice.
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
    // The authChange broadcast will arrive from offscreen with session=null, and
    // applySession will handle it there. We do nothing here, so as not to call
    // the listeners twice.
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

  /** Last-used auth method + email — read from offscreen storage. AuthPanel uses
   *  it for the "Last used" badge and email pre-fill. Storage is paywall-scoped,
   *  and offscreen is the single source of truth for all tabs/popups. */
  async getLastLogin(): Promise<LastLogin | null> {
    return this.transport.request('auth.getLastLogin', undefined);
  }

  // === Anonymous sign-in ===

  /** Anonymous sign-in (a Supabase user without an email). The logic (an
   *  idempotent check + resume via a stored refresh_token + fresh signin) lives
   *  in the offscreen AuthClient — content only proxies. captchaToken and
   *  forceNewAnon are pass-through for forward-compat / the switch-account flow. */
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

  /** The current access token (lazily refreshable in offscreen). content/popup
   *  uses it for the Bearer in external fetches — the ApiGatewayClient in the
   *  content-script, direct requests from the demo UI. null if signed out or the
   *  offscreen AuthClient couldn't refresh. */
  async getAccessToken(): Promise<string | null> {
    return this.transport.request('auth.getAccessToken', undefined);
  }

  // === OAuth (web-flow via split-API) ===

  /** OAuth via the web variant: window.open in the content-script, a provider
   *  redirect, and the callback page posts the code back to the opener. Under
   *  the hood it's a split into two requests to offscreen — startOAuthFlow (hit
   *  /init, get authorize_url) → open the popup → waitForOAuthCode → exchange.
   *
   *  The PKCE verifier lives ONLY in offscreen (inside the AuthClient) and never
   *  crosses the runtime boundary. Content gets only authorize_url and state.
   *
   *  Popup gesture: `window.open(authorize_url, ...)` runs in the same synchronous
   *  flow as the startOAuthFlow response; the user-gesture is preserved because
   *  the content-script isn't unloaded within that tick (the gesture survives
   *  through all microtasks of a single call stack). If in some browser the
   *  gesture is lost anyway — the host gets `popup_blocked` (the same as in @monetize.software/sdk).
   */
  async signInWithOAuth(input: {
    provider: OAuthProvider;
    scopes?: string;
    userMeta?: Record<string, string>;
    onPopupOpened?: () => void;
    /** Force a plain signin (no anon-upgrade linkIdentity) into the account that
     *  owns the identity. Passed by the UI "sign in with that account" button. */
    switchAccount?: boolean;
  }): Promise<AuthSession> {
    if (typeof window === 'undefined') {
      throw new PaywallError('oauth_unavailable', 'window is required for OAuth');
    }

    // Open the popup SYNCHRONOUSLY — the user-gesture is preserved only within
    // the same synchronous frame as the click handler. An async `await` on
    // transport.request before window.open eats the gesture, and Chrome opens the
    // popup with an empty URL / blocks it entirely.
    //
    // about:blank instead of data:text/html (which used to show the inline loader):
    // data: URLs trip CWS static scanners and EDRs as suspicious. Instead we open
    // about:blank (which inherits the opener's origin) and inject the loader DOM
    // via document.createElement + textContent — exactly the same UX, without a data: URL.
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
      // Async part: hit offscreen for authorize_url and state. For now the popup
      // shows about:blank.
      const { authorizeUrl, state } = await this.transport.request('auth.oauthStart', {
        provider: input.provider,
        scopes: input.scopes,
        userMeta: input.userMeta,
        switchAccount: input.switchAccount
      });

      // Before navigating, rename the popup to the format the callback page
      // expects (pw-oauth-<state>) — the name survives cross-origin redirects
      // (Google → Supabase → our callback). The callback page reads window.name
      // → extracts state → posts back.
      popup.name = `pw-oauth-${state}`;
      popup.location.replace(authorizeUrl);

      input.onPopupOpened?.();

      let result = await waitForOAuthResult(popup, state);

      // Auto switch-account (mirrors @monetize.software/sdk AuthClient.signInWithOAuth):
      // the anon-upgrade linkIdentity failed because this identity already belongs
      // to another user. We re-run as a plain signin reusing the SAME popup + state
      // (provider SSO is established → near-instant). reuseState keeps window.name
      // matching; we can't reset popup.name once it's cross-origin anyway.
      if (
        !input.switchAccount &&
        result.kind === 'error' &&
        result.errorCode === 'identity_already_exists'
      ) {
        const retry = await this.transport.request('auth.oauthStart', {
          provider: input.provider,
          scopes: input.scopes,
          userMeta: input.userMeta,
          switchAccount: true,
          reuseState: state
        });
        try {
          popup.location.replace(retry.authorizeUrl);
          result = await waitForOAuthResult(popup, state);
        } catch {
          // Popup unusable — fall through to the error mapping below.
        }
      }

      try {
        popup.close();
      } catch {
        /* ignore */
      }

      if (result.kind === 'cancelled') {
        throw new PaywallError('oauth_cancelled', 'auth popup was closed');
      }
      if (result.kind === 'timeout') {
        throw new PaywallError('oauth_timeout', 'OAuth flow timed out');
      }
      if (result.kind === 'error') {
        throw new PaywallError(
          result.errorCode === 'identity_already_exists'
            ? 'oauth_identity_already_linked'
            : 'oauth_failed',
          result.description || result.error || 'OAuth provider returned error'
        );
      }

      const session = await this.transport.request('auth.oauthExchange', {
        state,
        code: result.code
      });
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

/** Inject the loader UI into the about:blank popup. Same-origin as the opener,
 *  so we can touch popup.document directly. We use createElement + textContent
 *  (not innerHTML / document.write) so as not to trip XSS scanners even on
 *  hard-coded strings. CSS classes with the pw-oauth-* prefix avoid collisions
 *  with the parent page's styles (the popup is isolated anyway, but just in case).
 *
 *  Defensive try/catch: if in some edge case the popup turns out not to be
 *  same-origin (some extensions intercept this) or the document isn't available
 *  — we quietly give up, and the popup shows the default about:blank for 200-500ms
 *  before redirecting to the provider. */
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
