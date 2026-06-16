import { ApiClient } from './api';
import { createStorage, type StorageAdapter, STORAGE_KEYS } from './storage';
import { PaywallError } from './types';
import {
  deriveCodeChallenge,
  generateCodeVerifier,
  generateState
} from './pkce';

// AuthClient — the SDK 3.0 client for the /api/v1/paywall/[id]/auth/* endpoints.
// Stores the auth session in a StorageAdapter (localStorage / chrome.storage.local /
// memory), provides the access_token for the Authorization header in `api.ts` via
// getAccessToken() with lazy refresh, dedupes parallel refreshes, and emits
// onAuthChange on login/logout/refresh.
//
// It doesn't depend on BillingClient: AuthClient can be used standalone (e.g. for
// your own ui without the bundled paywall). BillingClient, in turn, accepts
// AuthClient optionally and wires up Bearer + auto-sync of identity.

// REFRESH_LEEWAY_MS before expiry we start a refresh — a buffer for network
// latency and the client's clock drift. 60s is enough: GoTrue access lives for
// 1h, the chance of actually slipping an expired token into an API request ≈ 0.
const REFRESH_LEEWAY_MS = 60_000;
// TTL for a pending OAuth flow between startOAuthFlow and completeOAuthFlow.
// 10min — more than a user needs to click through Google/Apple/etc; less than a
// reasonable "stepped away and came back".
const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

export interface AuthUser {
  id: string;
  /** null for an anonymous user (signInAnonymously). For all other flows — filled in. */
  email: string | null;
  country?: string | null;
  /** Display name from the provider profile (OAuth `full_name`/`name`). null for
   *  anonymous / email users without a name. */
  name?: string | null;
  /** Avatar URL from the provider profile (OAuth `avatar_url`/`picture`). Present
   *  for Google and most social logins; null for Apple "hide email" / email /
   *  anonymous users. Carried in the session so the UI can show it from
   *  `auth.getCachedUser()?.avatar` without an extra request. */
  avatar?: string | null;
  /** true — a Supabase anonymous user. The UI uses it to decide "sign in" vs
   *  "signed in as ...", and to call linkIdentity instead of signInWithOAuth on an
   *  OAuth upgrade (mirrors the legacy StartAuthPage.tsx). */
  is_anonymous?: boolean;
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  /** An absolute timestamp in ms (comparable to Date.now()). We don't write null/0. */
  expires_at: number;
  user: AuthUser;
}

export type SignUpResult =
  | { kind: 'signed_in'; session: AuthSession }
  | { kind: 'confirmation_required'; user: { id: string; email: string } }
  /** The email is already registered (possibly via an OAuth provider). GoTrue's
   *  anti-enumeration makes /signup look like "confirmation pending", so the
   *  backend disambiguates it for us — the UI should send the user to sign in
   *  (password or the social button they used) instead of a dead-end "check your
   *  email" screen. */
  | { kind: 'already_registered'; email: string };

/** The result of `upgradeAnonymousToEmail`. `updated` — confirmation is off or
 *  already passed; session.user.email is updated, is_anonymous=false. `confirmation_required` —
 *  GoTrue sent a confirmation to the new email; the session is still anonymous,
 *  the user must click the link (after which they can call `auth.refresh()` —
 *  the tokens refresh with the email and is_anonymous=false). */
export type UpgradeAnonymousResult =
  | { kind: 'updated'; session: AuthSession }
  | { kind: 'confirmation_required'; email: string };

export type OtpVerifyType = 'email' | 'recovery' | 'signup' | 'magiclink' | 'invite';

export type OAuthProvider = 'google' | 'apple' | 'github' | 'facebook';

/** The method the user last logged in with on this paywall. Stored per-paywall
 *  in storage and used by the UI to:
 *   - pre-fill the email input with the last-known email;
 *   - highlight the same OAuth button / email form with a "Last used" badge.
 *  `email` — email/password forms (signin or signup → confirm). */
export type LastLoginMethod = OAuthProvider | 'email';

export interface LastLogin {
  method: LastLoginMethod;
  email: string | null;
}

/** The discriminator for `onAuthChange`. Lets the listener distinguish the first
 *  callback (session restored from storage / a synthetic snapshot for a fresh
 *  subscription) from real transitions. The Supabase convention, minus events we
 *  don't have (MFA, EMAIL_VERIFIED).
 *
 *  - INITIAL_SESSION — the only guaranteed first callback per subscription.
 *    Triggered via a microtask after the hydrated promise resolves, even if
 *    session=null. Listeners on this event must NOT do side effects like
 *    force-refetch — it's just delivery of the starting state.
 *  - SIGNED_IN — a fresh login: email/OAuth/anon, or the appearance of a session
 *    in this instance from another context (storage.watch) when it was null before.
 *  - SIGNED_OUT — signOut, revokeAllSessions, a 401 on refresh, deletion of the
 *    session from another context.
 *  - TOKEN_REFRESHED — the same user, refreshed tokens: refresh(), or
 *    storage.watch when the content changed but user.id stayed.
 *  - USER_UPDATED — user.email / user.user_metadata changed (updatePassword,
 *    upgradeAnonymousToEmail) with the same user.id.
 *  - PASSWORD_RECOVERY — verifyOtp(type='recovery'). The listener knows it should
 *    show the "set new password" UI instead of the usual post-login flow. */
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
  /** Origin of the SDK server API — required, the same `custom_domain` as in
   *  BillingClient. See {@link BillingClientOptions.apiOrigin}. */
  apiOrigin: string;
  storage?: StorageAdapter;
  fetch?: typeof fetch;
  // Injectable for tests and for Chrome extensions (there a popup can be opened
  // via chrome.windows.create rather than window.open). Default — window.open.
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
  /** Deduplication of parallel signInAnonymously: two clicks on "Sign in as
   *  guest" must land in one user, not spawn two (a double captcha + a second
   *  /signup would create a second record with a lost trial balance). */
  private inflightAnonSignin: Promise<AuthSession> | null = null;
  private listeners = new Set<AuthChangeListener>();
  private storageUnwatch: (() => void) | null = null;
  private destroyed = false;
  /** Pending OAuth flows: state → {verifier, userMeta, startedAt}. Between
   *  startOAuthFlow and completeOAuthFlow. GC'd via OAUTH_FLOW_TTL_MS. */
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
    // Without getAuthToken — auth endpoints are either public, or we set
    // Authorization manually in the headers (signOut). ApiClient won't overwrite
    // it if getAuthToken is absent.
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
   * Subscribes to changes of the session key in storage from other contexts:
   *  - Chrome Extension: `chrome.storage.onChanged` is shared across popup ↔
   *    background ↔ options ↔ content script. A login in one context → the others
   *    immediately emit onAuthChange and serve a fresh Bearer in getAccessToken.
   *  - Web: the `window.storage` event fires in OTHER tabs of the same origin
   *    (a tab doesn't receive its own setItem — no loops).
   *
   * Loop-guard: we compare the content by session fields before applySession, so
   * as not to fire extra onAuthChange on an identical overwrite. Calls from other
   * contexts with the same content (a re-save) — a no-op.
   */
  private startStorageWatch(): void {
    if (typeof this.storage.watch !== 'function') return;
    this.storageUnwatch = this.storage.watch(this.storageKey(), (raw) => {
      void this.applyExternalSession(raw);
    });
  }

  private async applyExternalSession(raw: string | null): Promise<void> {
    if (this.destroyed) return;
    // We wait for the initial hydrate — otherwise we could overwrite a session
    // that hasn't finished loading at construction time.
    await this.hydrated;
    if (this.destroyed) return;
    if (raw == null) {
      // Deleted in another context → logout for all subscribers.
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
      // Cross-context update: we classify by what was local.
      // - There was no session → a new login from another tab = SIGNED_IN.
      // - It was the same user — this is a refresh-rotation = TOKEN_REFRESHED.
      // - A different user.id — an actual account switch, also SIGNED_IN
      //   (for the consumer it's a new user).
      const event: AuthChangeEvent =
        !this.session || this.session.user.id !== parsed.user.id
          ? 'SIGNED_IN'
          : 'TOKEN_REFRESHED';
      this.setSession(parsed, { skipPersist: true, event });
    } catch {
      /* corrupted payload — ignore */
    }
  }

  /**
   * The promise of hydrating the session from storage. Before it resolves,
   * getCachedSession() may still return null. getAccessToken/refresh/signOut/sign*
   * await it themselves; we expose it for the UI so it can wait for the initial
   * state before rendering a "logged-out" flash.
   */
  ready(): Promise<void> {
    return this.hydrated;
  }

  /** Sync snapshot with no network requests. null = logged out or not hydrated yet. */
  getCachedSession(): AuthSession | null {
    return this.session;
  }

  getCachedUser(): AuthUser | null {
    return this.session?.user ?? null;
  }

  /**
   * The access_token for the Authorization header. If time-to-expiry <
   * REFRESH_LEEWAY_MS, it does a lazy refresh. null = logged out or the refresh
   * failed with 401 (refresh token revoked) — the caller should redirect to login.
   *
   * Network/5xx refresh errors are thrown — the current access is still valid,
   * the caller can try a request with it; the next getAccessToken will try the
   * refresh again.
   */
  async getAccessToken(): Promise<string | null> {
    await this.hydrated;
    if (!this.session) {
      // Race window: another context (a popup) logged in, but the storage-watch
      // event hasn't reached this instance yet (chrome.storage.onChanged is
      // async). One extra storage read for the logged-out case is an acceptable
      // price for the background not returning null when a token already exists.
      await this.rehydrateFromStorage();
      if (!this.session) return null;
    }
    if (this.isFresh(this.session)) return this.session.access_token;
    try {
      const refreshed = await this.refresh();
      return refreshed?.access_token ?? null;
    } catch {
      // The network failed — we return the current one (it may expire soon, but better than null).
      return this.session?.access_token ?? null;
    }
  }

  async signInWithEmail(input: {
    email: string;
    password: string;
    userMeta?: Record<string, string>;
    /** Idempotency-key (UUID) — a repeated submit on a double-click returns the
     *  same result instead of a second request to GoTrue. Without passing it
     *  there's no inflight dedup; the SDK doesn't dedupe auth by default, because
     *  email/password can be changed between clicks. */
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
   * Signup. If email confirm is enabled in Supabase — the server returns
   * `{status: 'confirmation_required', user}` and does NOT issue tokens. In that
   * case setSession isn't called, the user must go through OTP/magic-link (a
   * separate feature in the next PR).
   */
  async signUp(input: {
    email: string;
    password: string;
    userMeta?: Record<string, string>;
    /** Idempotency-key (UUID). Protection against a double-click on "Sign Up" —
     *  without it the backend may create trial-balances and send a confirmation
     *  email twice. */
    idempotencyKey?: string;
  }): Promise<SignUpResult> {
    await this.hydrated;
    const visitorId = await this.readVisitorId();
    type Resp =
      | { status: 'confirmation_required'; user: { id: string; email: string } }
      | { status: 'already_registered'; email: string }
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
    if (resp.status === 'already_registered') {
      // Don't record a last-login method — we didn't actually sign anyone in, and
      // we don't know which method the existing account uses.
      return { kind: 'already_registered', email: resp.email };
    }
    if (resp.status === 'confirmation_required') {
      // We record the email method ahead of time: after verifyOtp the user comes
      // back without our knowledge of the chosen flow (verifyOtp is shared with
      // recovery too), and we want to record method specifically for the "Last used" UI badge.
      this.recordLastLogin('email', input.email);
      return { kind: 'confirmation_required', user: resp.user };
    }
    const session = this.toSession(resp, resp.user);
    this.setSession(session, { event: 'SIGNED_IN' });
    this.recordLastLogin('email', input.email);
    return { kind: 'signed_in', session };
  }

  /**
   * Resends the confirmation email after a signUp with email-confirm enabled.
   * Uses GoTrue `/resend` type='signup'. The backend always returns ok
   * (anti-enumeration), except 429 on rate-limit (~once/min per email on the
   * Supabase side). The host handles 429 by showing "wait a minute"; everything
   * else — as success.
   */
  async resendConfirmation(input: {
    email: string;
    /** Protection against a double-click. */
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
   * Email-OTP / signin without a password. Sends a 6-digit code to the user's
   * email. Anti-enumeration: the backend always returns ok, so the method doesn't
   * distinguish "email doesn't exist" from "sent" — the next step (verifyOtp)
   * fails with invalid_otp itself if the user doesn't exist. Under the hood it's
   * GoTrue with create_user=true, so new users log in via OTP in one step
   * (send → enter code → session).
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
   * OTP verification. type='email' (signin/signup-by-otp) — on success,
   * setSession and onAuthChange. type='recovery' — after /requestPasswordReset:
   * a short-lived access_token is issued for the subsequent updatePassword. We
   * store the recovery session the same as a regular one: the SDK doesn't
   * distinguish "can log in" vs "can change password" — it's the same session.
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
    // type='recovery' — this is a session with a short-lived token for the
    // subsequent updatePassword. PASSWORD_RECOVERY lets the UI know it should show
    // "set new password" instead of the usual post-login flow.
    const event: AuthChangeEvent =
      input.type === 'recovery' ? 'PASSWORD_RECOVERY' : 'SIGNED_IN';
    this.setSession(session, { event });
    return session;
  }

  /**
   * Requests a recovery email. The backend always returns ok so as not to give
   * away enumeration. The user enters the code from the email into the SDK ui →
   * verifyOtp({type:'recovery'}) → gets a session → updatePassword.
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
   * Changes the password of the current session. Works after
   * verifyOtp({type:'recovery'}) (a recovery session) and after a regular login —
   * both cases give a valid access_token. If there's no session — we throw
   * PaywallError('not_authenticated') before the network request, so the UI
   * doesn't hit the backend in vain.
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
   * Anonymous signin (a Supabase user without an email). The ladder of attempts:
   *
   *   1. If already logged in anonymously (session.user.is_anonymous === true) —
   *      a no-op, we return the current session. Idempotent for a UI that may
   *      call signInAnonymously() in a render loop without tracking state.
   *
   *   2. Resume via the saved anon refresh_token (`STORAGE_KEYS.anonRefreshToken`).
   *      If the token exists — we try `/auth/refresh` with it. Success →
   *      setSession, we return the user with the SAME id as at the previous anon
   *      signin (the promise from user feedback: "if I logged out from anonymous —
   *      log me into the same account").
   *
   *   3. Otherwise → POST /auth/anonymous/signin → setSession + save the
   *      refresh_token in anonRefreshToken.
   *
   * `captchaToken` isn't required right now — captcha protection in Supabase is
   * disabled, protection against per-IP abuse rests on Supabase's rate limit
   * (30/hour per real-IP, see the IP forwarding setup in supabaseAuthRest.ts) +
   * CF Bot Fight Mode at the edge. The field is left optional for forward-compat:
   * when the server starts returning challenge_required in risk scenarios, the
   * SDK can pass proof-of-something back without a breaking change.
   *
   * `forceNewAnon: true` skips steps 1-2 and does /signin straight away (creates
   * a new anon user). Used in the switch-account flow.
   *
   * Parallel calls are deduplicated via `inflightAnonSignin` — two clicks on
   * "Sign in as guest" won't create two anon users (two /signup = two user_ids,
   * the second trial balance flies into oblivion).
   */
  async signInAnonymously(input: {
    captchaToken?: string;
    userMeta?: Record<string, string>;
    forceNewAnon?: boolean;
  } = {}): Promise<AuthSession> {
    if (this.inflightAnonSignin) return this.inflightAnonSignin;

    this.inflightAnonSignin = (async () => {
      await this.hydrated;

      // 1. Already anon — don't hit the network.
      if (
        !input.forceNewAnon &&
        this.session?.user.is_anonymous === true
      ) {
        return this.session;
      }

      // 2. Resume via the saved refresh_token.
      if (!input.forceNewAnon) {
        const resumed = await this.resumeAnonymous();
        if (resumed) return resumed;
      }

      // 3. Fresh signin. We send captcha_token only if the host passed it
      //    explicitly (forward-compat for a future challenge-response mechanism).
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

      // The backend doesn't set is_anonymous=true in the user object? A safeguard
      // for the SDK-side flag: always true for this route.
      const user: AuthUser = {
        ...resp.user,
        email: resp.user.email ?? null,
        is_anonymous: true
      };
      const session = this.toSession(resp, user);
      this.setSession(session, { event: 'SIGNED_IN' });
      // Persist refresh for future resumes — in writeAnonRefreshToken; likewise
      // `setSession` has already saved the full session into authSession storage.
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
   * Internal resume — tries /auth/refresh with the saved anon refresh_token.
   * Returns a session on success, null if there's no token or it's revoked (401).
   * It throws network errors out — the caller decides whether to retry or ask the
   * user to pass a captcha.
   */
  private async resumeAnonymous(): Promise<AuthSession | null> {
    const rt = await this.readAnonRefreshToken();
    if (!rt) return null;
    try {
      const resp = await this.api.request<RawTokens>(
        `/api/v1/paywall/${this.paywallId}/auth/refresh`,
        { method: 'POST', body: JSON.stringify({ refresh_token: rt }) }
      );
      // /auth/refresh doesn't return user — we reconstruct it minimally from the
      // current session (if there was anon in storage) or set a stub. For the full
      // profile the host can call BillingClient.getUser().
      const fallbackUser: AuthUser =
        this.session?.user.is_anonymous === true
          ? this.session.user
          : { id: '', email: null, is_anonymous: true };
      const session = this.toSession(resp, fallbackUser);
      // resumeAnonymous is called only from signInAnonymously, where session=null
      // before this. For the listener it's a login of a new anon user — SIGNED_IN.
      // If it was the same anon before hydrate — sameSession filters out the emit.
      this.setSession(session, { event: 'SIGNED_IN' });
      // Rotation: GoTrue issues a new refresh_token, we update the persisted one.
      await this.writeAnonRefreshToken(session.refresh_token);
      return session;
    } catch (e) {
      if (e instanceof PaywallError && e.status === 401) {
        // The token is revoked — we clear it, the fallthrough in the caller does
        // a fresh signin to /auth/anonymous/signin (creates a new anon user).
        await this.clearAnonRefreshToken();
        return null;
      }
      // Network/5xx — we don't touch the token, let the user retry.
      throw e;
    }
  }

  /**
   * Anon → email/password upgrade. Keeps the same auth.user.id, the balances and
   * trial-quotas remain. The behavior depends on the project's Supabase
   * email-confirm setting:
   *
   *  - Confirmation OFF → the backend immediately updates email + password in
   *    auth.users. We return `kind: 'updated'`, locally patch session.user.email +
   *    is_anonymous=false (the current access_token stays valid, no need to
   *    reissue — GoTrue doesn't rotate tokens on updateUser).
   *
   *  - Confirmation ON → the backend returns `confirmation_required`. The current
   *    session STAYS anonymous until the user clicks the confirmation link. The
   *    password is applied right away (you can keep logging in with it even before
   *    confirm). After the click — the next /auth/refresh pulls the updated
   *    is_anonymous=false from the JWT (refresh doesn't return user, so the UI can
   *    explicitly poke `auth.refresh()` a minute or two later, or wait for the
   *    lazy-refresh at access expiry).
   *
   * Without an active session it throws `not_authenticated`. There's no dedup —
   * a double form submit must be prevented by the UI with idempotencyKey.
   */
  async upgradeAnonymousToEmail(input: {
    email: string;
    password: string;
    userMeta?: Record<string, string>;
    /** Idempotency-key to protect against a double-click. GoTrue PUT /user isn't
     *  idempotent by itself — a repeated submit on a double-click can cause a race
     *  with email-confirmation (two confirmation links to the same address). The
     *  UI must pass a UUID. */
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
      // We don't touch the local session — it's still anonymous in fact.
      return { kind: 'confirmation_required', email: resp.email };
    }

    // Confirmation off: we patch the local user part of the session. The tokens
    // are the same, but user.email and is_anonymous are now correct — the UI must
    // immediately show "Signed in as <email>" instead of "Guest".
    const current = this.session;
    if (!current) {
      // Race: the session went away between getAccessToken and here (signOut in
      // another tab). The backend already updated auth.users — but we change
      // nothing locally, the host will see a clean logged-out state.
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
    // The same set of tokens — only user changed (anonymous→named).
    // USER_UPDATED, not SIGNED_IN: the listener must not interpret this as "a new
    // user appeared", it's an upgrade of the same session.
    this.setSession(updatedSession, { event: 'USER_UPDATED' });

    // The user is no longer anonymous — the anon refresh_token now "belongs" to a
    // regular account. There's no point keeping it as "return to anon": on signOut
    // it's now a full logout anyway. We clear it so the next signInAnonymously
    // asks for a new captcha (doesn't accidentally log into the upgraded account).
    await this.clearAnonRefreshToken();

    return { kind: 'updated', session: updatedSession };
  }

  /**
   * OAuth signin via a popup with PKCE. Lifecycle:
   * 1. Generate verifier+challenge+state locally (the verifier doesn't go to the
   *    backend until /exchange — this protects against interception of the code).
   * 2. POST /oauth/init with the challenge → the backend returns authorize_url.
   * 3. Open the popup, wait for a postMessage of type 'pw-oauth' with our state.
   * 4. POST /oauth/exchange with {auth_code, code_verifier} → session.
   *
   * Timeout — 5 minutes from opening the popup. If the user closed the popup
   * before the flow finished (window.closed → true) — we throw
   * PaywallError('oauth_cancelled'). Parallel calls are NOT deduped — each opens
   * its own popup; calling in parallel makes no sense, but the code shouldn't
   * defend against it.
   *
   * onPopupOpened is called right after a successful window.open (before waiting
   * for the code). The UI uses it to reset the button's loading state: from here
   * responsibility for the flow is on the popup, the main page shouldn't hang. If
   * the popup didn't return a code (the user closed the tab, closed-detection
   * didn't fire due to a COOP severance) — the promise reaches oauth_timeout after
   * 5 minutes, but by then the button is already free.
   */
  async signInWithOAuth(input: {
    provider: OAuthProvider;
    scopes?: string;
    userMeta?: Record<string, string>;
    onPopupOpened?: () => void;
    /** Skip the anon-upgrade linkIdentity path and sign straight into the account
     *  that owns the OAuth identity (dropping the current anon session). The UI
     *  passes this from the "sign in with that account" button after an
     *  `oauth_identity_already_linked` error. */
    switchAccount?: boolean;
  }): Promise<AuthSession> {
    if (typeof window === 'undefined') {
      throw new PaywallError('oauth_unavailable', 'window is required for OAuth');
    }

    // Single-process path: start → openPopup → waitForOAuthResult → complete. The
    // flow state lives on our heap until complete; for the split mode
    // (offscreen-architecture in @monetize/sdk-extension) start and complete are
    // called as separate requests — the verifier stays inside AuthClient.
    const { authorize_url, state } = await this.startOAuthFlow({
      provider: input.provider,
      scopes: input.scopes,
      userMeta: input.userMeta,
      switchAccount: input.switchAccount
    });

    const popup = this.openPopup(authorize_url, `pw-oauth-${state}`);
    if (!popup) {
      // Cleanup pending flow — without a popup, complete will never be called.
      this.oauthFlows.delete(state);
      throw new PaywallError(
        'popup_blocked',
        'browser blocked auth popup — call from a user gesture'
      );
    }
    input.onPopupOpened?.();

    const result = await waitForOAuthResult(popup, state);

    try {
      popup.close();
    } catch {
      /* ignore */
    }

    if (this.destroyed) {
      this.oauthFlows.delete(state);
      throw new PaywallError('aborted', 'AuthClient destroyed mid-flow');
    }

    if (result.kind === 'cancelled') {
      throw new PaywallError('oauth_cancelled', 'auth popup was closed');
    }
    if (result.kind === 'timeout') {
      throw new PaywallError('oauth_timeout', 'OAuth flow timed out');
    }
    if (result.kind === 'error') {
      this.oauthFlows.delete(state);
      throw new PaywallError(
        isIdentityAlreadyLinked(result) ? 'oauth_identity_already_linked' : 'oauth_failed',
        result.description || result.error || 'OAuth provider returned error'
      );
    }

    return this.completeOAuthFlow({ state, code: result.code });
  }

  /**
   * Step 1 of the OAuth split-API: initiates the flow on the backend, generates
   * the PKCE verifier + state, stores them itself, returns `{authorize_url, state}`
   * for opening the popup. The verifier does NOT leave — AuthClient holds it until
   * `completeOAuthFlow`.
   *
   * Used in the offscreen architecture (@monetize/sdk-extension): start is called
   * via RPC from the content-script, content opens the popup natively (gesture
   * preserved), then calls completeOAuthFlow with the code. AuthClient (in the
   * offscreen) does /exchange with the saved verifier.
   *
   * Pending flows are GC'd after 10min — more than a user needs to click through
   * Google. Without cleanup the Map would grow for every closed popup.
   */
  async startOAuthFlow(input: {
    provider: OAuthProvider;
    scopes?: string;
    userMeta?: Record<string, string>;
    /** Force a plain sign-in instead of the anon-upgrade `linkIdentity` path: we
     *  do NOT attach the Bearer, so /oauth/init returns the signin authorize URL.
     *  Set by the UI "sign in with that account" button shown after an
     *  `oauth_identity_already_linked` error — the user lands in the account that
     *  already owns the OAuth identity (the anon session is dropped). */
    switchAccount?: boolean;
  }): Promise<{ authorize_url: string; state: string }> {
    await this.hydrated;
    this.gcOAuthFlows();

    const verifier = generateCodeVerifier();
    const challenge = await deriveCodeChallenge(verifier);
    const state = generateState();

    // Anon-upgrade hand-off: if we already have a session (usually — anonymous
    // after signInAnonymously()), we send its access_token to /oauth/init. The
    // backend will go through GoTrue `linkIdentity` instead of `signInWithOAuth` —
    // after the OAuth callback the user_id stays the same as the anon's, and the
    // trial-balances/purchases linked to it don't go anywhere.
    // Mirrors the legacy StartAuthPage.tsx (is_anonymous → linkIdentity).
    //
    // switchAccount skips the Bearer entirely → /oauth/init returns the plain
    // signin flow (no linking), so the user logs into whatever account owns the
    // OAuth identity. The host can also reach this by signOut({forgetAnonymous})
    // first (then session=null and the Bearer wouldn't go either).
    const headers: Record<string, string> = {};
    if (!input.switchAccount) {
      const accessToken = await this.getAccessToken().catch((): string | null => null);
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    }

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

    // We record method before the popup: the provider in input is explicitly
    // chosen by the user, at this point we 100% know what they selected. Don't do
    // it via app_metadata.provider after the exchange — for an already-registered
    // user GoTrue returns the FIRST registered provider, not the current one (a
    // mirror of the legacy fix in online/app/paywall/auth/callback/AuthCallback.tsx).
    this.recordLastLoginMethod(input.provider);

    return { authorize_url, state };
  }

  /**
   * Step 2 of the OAuth split-API: exchanges the code (obtained from the popup)
   * for a session, using the verifier saved at startOAuthFlow. On success — set
   * session and emit onAuthChange.
   *
   * If the flow isn't found (the state isn't from startOAuthFlow or was GC'd past
   * the TTL) — it throws `oauth_invalid_state`. The caller must start over via
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
    // We write email from session.user only if the backend returned it. With
    // Apple the email arrives only on the first signin (unless the user uses "Hide
    // my email"); on all subsequent logins session.user.email may be null — then
    // we save only method (it's already recorded in startOAuthFlow).
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
   * Refreshes the access/refresh pair via the current refresh_token. Deduplicates
   * parallel calls (one in-flight promise for the whole client).
   *
   * - 401 → refresh_token revoked/invalid → we clear the session, emit logout.
   * - Network/5xx → we propagate the error, keep the session — the user shouldn't
   *   be logged out due to a temporary network problem.
   * - No session → we return null without a network request.
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
        // The server doesn't return user in /refresh — we carry it over from the current session.
        const session = this.toSession(resp, currentUser);
        this.setSession(session, { event: 'TOKEN_REFRESHED' });
        // Anon-rotation: the refresh_token rotates on every refresh, we keep the
        // persisted copy in sync, otherwise on signOut() and a resume attempt
        // there'd be an old, already-revoked token → 401 → loss of the anon account.
        if (currentUser.is_anonymous === true) {
          await this.writeAnonRefreshToken(session.refresh_token);
        }
        return session;
      } catch (e) {
        if (e instanceof PaywallError && e.status === 401) {
          // If the refresh failed on an anon user — we clear anonRefreshToken too,
          // it's invalid. Otherwise the next resumeAnonymous() would go through the
          // same dead token and get 401 again.
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
   * Global logout — invalidates ALL of the user's refresh tokens across all
   * devices/contexts via GoTrue `/logout?scope=global`. Used for the
   * compromise-account flow ("suspicious activity, log out everywhere").
   *
   * Local-side: we clear the current session, the other contexts (other tabs /
   * extension popup and background) pick up the logout via storage-watch
   * automatically. Active access tokens in other contexts stay valid until their
   * natural expiry (1 hour max), but refresh no longer works — after the first
   * `getAccessToken()` each context logs itself out.
   *
   * Security: the backend doesn't accept a target user_id — it resolves the user
   * from Bearer, you can't log out someone else's account.
   */
  async revokeAllSessions(): Promise<void> {
    await this.hydrated;
    const accessToken = this.session?.access_token;
    if (!accessToken) {
      throw new PaywallError('not_authenticated', 'no active session');
    }
    // First the network request, then the local clear — the reverse order
    // relative to signOut(). If the backend fails, we leave the user logged in
    // locally (they can try again); the UX advantage of an instant logout here is
    // smaller than the risk of thinking the device is logged out when it really isn't.
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
   * Signout: clears the local session IMMEDIATELY (UX — an instant logout without
   * waiting for the network), then a best-effort POST /auth/signout with the
   * current access. A network/5xx error here is no longer critical — the token
   * will expire on the backend anyway.
   *
   * Anon-aware: by default anonRefreshToken is kept. This allows calling
   * signInAnonymously() after signOut() and landing in the SAME anon account
   * without a captcha (see resumeAnonymous). The behavior is predictable for the
   * UX "guest → logged in → logged out → guest again with the same balances".
   *
   * `forgetAnonymous: true` — full forgetting, including anonRefreshToken. Needed
   * for scenarios like "switch account on the device" or privacy complaints
   * ("erase all my traces").
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
    // A subtle point: GoTrue `/logout` (scope=local default) invalidates the
    // current refresh_token. For an anon the current refresh_token =
    // anonRefreshToken in our storage; if we call /logout — anonRefreshToken
    // becomes invalid, and the next signInAnonymously() can't resume this user.
    // So on an anon signOut WITHOUT forgetAnonymous we skip /logout — the token
    // stays alive for a future return. Local-side the user is already logged out
    // (setSession(null)), which is what the UX needs.
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
      /* swallow — the local state is already clean */
    }
  }

  /**
   * Subscribe to session changes: signin/signup/refresh/signOut/expired-401.
   *
   * Guaranteed contract: the FIRST callback to each subscriber is always
   * `event = 'INITIAL_SESSION'`, triggered asynchronously after the hydrate
   * resolves (even if session=null — the listener gets an explicit "no session",
   * not silence). All subsequent callbacks are real transitions with a concrete
   * event (SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED / USER_UPDATED /
   * PASSWORD_RECOVERY).
   *
   * This lets the listener safely do "only on real signin" side effects (force
   * refetch balances, etc.) via `event === 'SIGNED_IN'` without confusing them
   * with a restore from storage.
   *
   * Returns an unsubscribe.
   */
  onAuthChange(cb: AuthChangeListener): () => void {
    this.listeners.add(cb);
    // INITIAL_SESSION after hydrate: we give storage.getItem time to run so the
    // listener gets the real restored state, not emptiness. If a setSession
    // already happened before the resolve (a cross-context signin arrived via
    // applyExternalSession, or an immediate sign-in by the user) — that's ok, the
    // listener first gets INITIAL_SESSION with the current (already updated)
    // snapshot, then the event of the transition itself. A duplicate snapshot is
    // harmless, the key thing is that the events are distinguishable.
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
    // GoTrue returns expires_at in seconds (unix), expires_in in seconds. The SDK
    // stores absolute ms so that isFresh() is a trivial comparison.
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
    // skipPersist: we apply a session that came from storage-watch (another
    // context already wrote exactly this to storage). Without the flag we'd do an
    // extra writeback and in a Chrome Extension get a loop
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
      // Expired access — we keep the session, the lazy refresh picks it up. If the
      // refresh_token is dead too (>30 days of inactivity), the refresh fails with
      // 401 and AuthClient logs out itself.
      //
      // We do NOT call emit() — listeners get the restored session as a separate
      // INITIAL_SESSION callback from onAuthChange after hydrated resolves. This
      // separates "the session was restored from storage" from "a real signin",
      // which matters for consumers like the demo content that force-refetch
      // balances on signin.
      this.session = parsed;
    } catch {
      /* corrupted entry — ignore, the user just sees logged-out */
    }
  }

  // Used as a race-fallback in getAccessToken: between construction (when storage
  // was empty) and onChanged delivery, a signin could have happened in another
  // context. It doesn't duplicate watch — that one is about push, this one about pull.
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
      // Called only when `this.session` was null and the user logged in somewhere
      // outside this context — for the listener it's SIGNED_IN (the same class of
      // event as the cross-context login in applyExternalSession).
      this.setSession(parsed, { skipPersist: true, event: 'SIGNED_IN' });
    } catch {
      /* ignore */
    }
  }

  /**
   * Releases AuthClient's resources: unsubscribes storage-watch, clears
   * listeners, sets the destroyed flag. After destroy all async operations
   * (inflight refresh, OAuth popup, applyExternalSession) early-return via
   * `isDestroyed()` guards — no write-backs to storage, no emits to empty listeners.
   *
   * destroy() is idempotent: a repeated call is a no-op.
   */
  destroy(): void {
    this.destroyed = true;
    if (this.storageUnwatch) {
      this.storageUnwatch();
      this.storageUnwatch = null;
    }
    this.listeners.clear();
    // inflightRefresh isn't canceled (a Promise can't be canceled), but its
    // success handler checks destroyed and skips setSession. Same for
    // waitForOAuthCode — a guard is added in signInWithOAuth.
    this.inflightRefresh = null;
  }

  /** Sync check: was destroy() called. Useful for UI / tests. */
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
      /* quota / disabled — not critical, the in-memory state is correct */
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
      /* quota / disabled — anon resume will break, but the current session is alive */
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
   * Last-used auth method + email — for the "Last used" UI badge and pre-filling
   * the email input. Storage is paywall-scoped, so switching between paywalls on
   * one host doesn't cross the data. A read always returns an object — missing
   * fields = null. */
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

  /** Records method and email atomically (for email/password flows — both are
   *  known at signin/signup time). OAuth flows use separate recordLastLoginMethod
   *  (before the popup) and recordLastLoginEmail (after the exchange). */
  private recordLastLogin(method: LastLoginMethod, email: string | null): void {
    this.recordLastLoginMethod(method);
    if (email) this.recordLastLoginEmail(email);
  }

  private recordLastLoginMethod(method: LastLoginMethod): void {
    // Fire-and-forget — a UI feature, we don't block the signin flow. Storage
    // errors (quota / private mode) break only the badge, not the signin itself.
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
   * Reads the stable visitor_id from storage if it's already there. Does NOT
   * generate it: AuthClient may be instantiated before BillingClient, and a
   * synthetic visitor_id without touching the paywall is meaningless (there are no
   * guest purchases to link). undefined → the backend itself skips the
   * "merge guest purchases" branch.
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

// OAuth flow timeout. 5 minutes comfortably cover: 2FA in Google, a manual
// switch-account in Apple, a slow network. Longer — almost certainly a hung
// popup, better to show an error.
const OAUTH_TIMEOUT_MS = 5 * 60_000;
// The window.closed check interval. The browser doesn't emit a close event for a
// popup of cross-origin windows, so we poll. 500ms is a compromise between
// responsiveness and cpu.
const OAUTH_POLL_MS = 500;

interface OAuthMessage {
  type?: string;
  status?: string;
  code?: string;
  error?: string;
  /** Machine code from GoTrue (e.g. `identity_already_exists`). The callback page
   *  forwards it so the SDK can branch into the switch-account retry. */
  errorCode?: string;
  description?: string;
  messageId?: string;
}

/** The structured outcome of an OAuth popup round-trip. */
export type OAuthResult =
  | { kind: 'code'; code: string }
  | { kind: 'error'; error: string; errorCode?: string; description?: string }
  | { kind: 'cancelled' }
  | { kind: 'timeout' };

/** Waits for the OAuth callback in the popup and resolves with a structured
 *  {@link OAuthResult}. Unlike {@link waitForOAuthCode} it does NOT close the
 *  popup — the caller decides whether to close it or REUSE it (the
 *  `identity_already_exists` → switch-account retry navigates the same popup).
 *  Never rejects: provider errors / cancel / timeout come back as result kinds. */
export function waitForOAuthResult(
  popup: Window,
  expectedState: string
): Promise<OAuthResult> {
  return new Promise((resolve) => {
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
      // We don't validate origin: the callback page sends with targetOrigin='*'
      // due to COOP restrictions in the popup. state is the only nonce tied to the
      // popup opened in this page, so the defense is exactly through it: a foreign
      // postMessage doesn't know our state.
      if (data.messageId !== expectedState) return;

      if (data.status === 'success' && data.code) {
        cleanup();
        resolve({ kind: 'code', code: data.code });
      } else if (data.status === 'error') {
        cleanup();
        resolve({
          kind: 'error',
          error: data.error || 'oauth_error',
          errorCode: data.errorCode,
          description: data.description
        });
      }
    };

    // window.closed — true when the user closed the popup themselves or the
    // browser closed it due to a provider error (some providers do that). Closing
    // without a message = cancellation.
    const closedTimer = setInterval(() => {
      if (settled) return;
      let closed: boolean;
      try {
        closed = popup.closed;
      } catch {
        // Cross-origin access is forbidden — better to ignore than to crash.
        return;
      }
      if (closed) {
        cleanup();
        resolve({ kind: 'cancelled' });
      }
    }, OAUTH_POLL_MS);

    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      cleanup();
      resolve({ kind: 'timeout' });
    }, OAUTH_TIMEOUT_MS);

    window.addEventListener('message', onMessage);
  });
}

/** Back-compat wrapper around {@link waitForOAuthResult}: resolves with the code,
 *  closes the popup, and throws a PaywallError for cancel/timeout/provider-error.
 *  Used by the extension's content-script split flow. */
export function waitForOAuthCode(popup: Window, expectedState: string): Promise<string> {
  return waitForOAuthResult(popup, expectedState).then((result) => {
    try { popup.close(); } catch { /* ignore */ }
    if (result.kind === 'code') return result.code;
    if (result.kind === 'cancelled') {
      throw new PaywallError('oauth_cancelled', 'auth popup was closed');
    }
    if (result.kind === 'timeout') {
      throw new PaywallError('oauth_timeout', 'OAuth flow timed out');
    }
    throw new PaywallError(
      isIdentityAlreadyLinked(result) ? 'oauth_identity_already_linked' : 'oauth_failed',
      result.description || result.error || 'OAuth provider returned error'
    );
  });
}

/**
 * True when an OAuth popup error means the chosen provider identity already
 * belongs to ANOTHER account (so the anon-upgrade linkIdentity was rejected and
 * the user should sign straight into that account).
 *
 * Primary signal — the machine `errorCode` (`identity_already_exists`). But we
 * also match the GoTrue `error_description` ("Identity is already linked to
 * another user") as a fallback: the hosted callback page and the SDK deploy
 * independently, and an older/cached callback build forwards only the human
 * description, not the machine code. Matching the description keeps the
 * switch-account UX working across that version skew instead of degrading to a
 * generic "Sign-in failed".
 */
export function isIdentityAlreadyLinked(result: OAuthResult): boolean {
  if (result.kind !== 'error') return false;
  if (result.errorCode === 'identity_already_exists') return true;
  const text = `${result.error ?? ''} ${result.description ?? ''}`.toLowerCase();
  return text.includes('identity_already_exists') || text.includes('already linked');
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
