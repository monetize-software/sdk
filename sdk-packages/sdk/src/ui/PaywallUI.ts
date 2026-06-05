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
  findApplicableOffer,
  readBrowserOfferStart,
  resolveOffer,
  type ResolvedOffer
} from '../core/offer';
import {
  PaywallError,
  type Acquiring,
  type Identity,
  type PaywallBootstrap,
  type PaywallOffer,
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

const CLOSED_STATE: PaywallStateSnapshot = {
  open: false,
  view: null,
  error: null,
  processing: false
};

// The SDK's event contract. The client subscribes via paywall.on(event, handler).
// Each event is strictly typed — the IDE gives autocomplete on the payload.
export interface PaywallEventPayloads {
  /** The modal is opened (an open request — data may still be loading). */
  open: void;
  /** The modal is closed. */
  close: void;
  /** Bootstrap is loaded, the modal shows content. Suitable for impression
   *  metrics. */
  ready: PaywallBootstrap;
  /** Any SDK error (bootstrap, checkout). */
  error: PaywallError;
  /** The user selected a plan (clicked a plan), hasn't yet initiated checkout. */
  price_selected: { priceId: string; price: PaywallPrice };
  /** The checkout URL was received from the backend and opened in a new tab.
   *  `acquiring` — the name of the payment processor the checkout went to (for
   *  conversion by acquiring in host analytics). */
  checkout_started: { priceId: string; url: string; acquiring?: Acquiring };
  /** The user returned with a successful payment (via URL markers or
   *  postMessage), or after signIn / a checkout attempt it turned out the
   *  subscription is already active (`restored: true`). priceId = null when the
   *  payment intent wasn't tied to a specific price (UserWatcher tick,
   *  restore-flow). */
  purchase_completed: {
    priceId: string | null;
    sessionId: string | null;
    /** true — this isn't a fresh payment but an active subscription that the
     *  SDK detected and showed the user a success/restored view. Useful for the
     *  host to distinguish (for metrics — "restore" vs "new purchase"). */
    restored?: boolean;
  };
  /** The user returned with an error/cancel from the provider. */
  purchase_failed: { reason: string | null };
  /** User-state changed (bootstrap snapshot, getUser refresh, watcher tick).
   *  Also fires right away with the last-known user after the first
   *  subscription. */
  userChange: PaywallUser;
  /** The auth session changed. The payload contains `event` (see
   *  AuthChangeEvent — INITIAL_SESSION / SIGNED_IN / SIGNED_OUT /
   *  TOKEN_REFRESHED / USER_UPDATED / PASSWORD_RECOVERY) and `session`
   *  (null = signed out).
   *
   *  Guaranteed contract: the first callback to every subscriber is always
   *  INITIAL_SESSION with the session restored from storage (or null if none).
   *  After that — real transitions. A listener with side effects like
   *  force-refetching balances should catch SIGNED_IN, not any truthy session,
   *  otherwise a page reload would trigger an extra request. */
  authChange: { event: AuthChangeEvent; session: AuthSession | null };
  /** The trial blocked the modal from showing. The payload contains the fresh
   *  status (after recordBlock). For `mode: 'time'` —
   *  startedAt/expiresAt/remainingMs; for `mode: 'opens'` —
   *  remainingActions/totalActions. The host can use the payload to show its
   *  own UI ("3 views left"). */
  trial_blocked: TrialStatus;
  /** The trial expired, the paywall is shown for the first time after expiry.
   *  Emitted once per PaywallUI instance lifetime (not persisted across page
   *  reloads — on each page-load the event may fire once). */
  trial_expired: void;
  /** Targeting didn't match — the paywall doesn't open. The payload contains a
   *  server-computed snapshot from bootstrap (visible=false + reason + country
   *  + tier). The host can show its own fallback ("the service isn't available
   *  in your country") or simply log the impression for analytics. */
  visibility_blocked: VisibilityStatus;
}

export type PaywallEvent = keyof PaywallEventPayloads;

export type PaywallEventHandler<E extends PaywallEvent = PaywallEvent> = (
  payload: PaywallEventPayloads[E]
) => void;

// Helper type: a `void` payload is emitted without an argument (`emit('open')`),
// a non-empty one — with an argument (`emit('ready', bootstrap)`).
type EmitArgs<E extends PaywallEvent> = PaywallEventPayloads[E] extends void
  ? []
  : [PaywallEventPayloads[E]];

export interface AnalyticsOptions {
  enabled?: boolean;
  /** Full URL to /events. Defaults to `${apiOrigin}/api/v1/paywall/${id}/events`. */
  endpoint?: string;
  flushIntervalMs?: number;
  maxBufferSize?: number;
  /** Test override for fetch (jsdom/Vitest). */
  fetch?: typeof fetch;
  /** Test override for sendBeacon. */
  sendBeacon?: (url: string, data: BodyInit) => boolean;
}

/**
 * Managed-auth config. Pass `auth: true` — PaywallUI creates the `AuthClient`
 * itself (with the same `paywallId/apiOrigin/storage` as BillingClient). Pass
 * an object — the same defaults + option overrides. Pass a ready `AuthClient` —
 * PaywallUI just forwards it to BillingClient (useful if the host wants a shared
 * AuthClient across several paywalls / to do manual signIn/signOut from its own
 * UI before opening the modal).
 *
 * Without the `auth` option the SDK works in hybrid mode: identity is passed
 * from outside via `opts.identity` or `paywall.open({identity})`.
 */
export type AuthOption = true | AuthClient | Partial<Omit<AuthClientOptions, 'paywallId'>>;

export interface PaywallUIOptions extends Omit<BillingClientOptions, 'auth'> {
  client?: BillingClient;
  host?: HTMLElement;
  /** Connect the managed-auth layer. See {@link AuthOption}. */
  auth?: AuthOption;
  /**
   * Automatically parse the URL when creating PaywallUI, to catch a return from
   * a checkout provider (?paywall_status=paid|failed|cancelled). Default: true.
   * Emits purchase_completed / purchase_failed via a microtask — subscribe
   * synchronously.
   */
  autoDetectReturn?: boolean;
  /**
   * Shadow DOM mode. Defaults to `closed` — full isolation from the host. For
   * e2e tests (Playwright) and live-preview in the admin panel pass `open`.
   */
  shadowMode?: 'open' | 'closed';
  /**
   * SDK 3.0 analytics. Enabled by default. Pass `false` to fully disable it
   * (nothing is sent to the backend). Accepts an object with batch settings or
   * an endpoint override.
   */
  analytics?: boolean | AnalyticsOptions;
  /**
   * When bootstrap isn't cached — render the modal **immediately** with a
   * spinner and run the gates (visibility/trial) after the data arrives, or
   * **wait** for bootstrap and mount only if the gates pass. Default `true` —
   * a snappy open, the "open" button responds instantly.
   *
   * Trade-off: with `true` and a blocking gate the modal flickers (opened →
   * closed after ~200-500ms). On extensions and sites with the targeting
   * fallback enabled this is a rare path, so the default is optimized for the
   * main 99% case. Pass `false` if for your use-case a flash on
   * blocked-countries/devices is worse than the perceived latency.
   */
  mountThenLoad?: boolean;
  /**
   * Inline mode for the admin panel editor's live-preview. The host is
   * positioned `absolute inset:0` inside its parent (instead of
   * fixed-viewport), the Modal's overlay also becomes absolute, and body-scroll
   * isn't locked. You MUST pass a `host` (HTMLElement) with a positioned parent
   * — otherwise absolute goes to the nearest positioned ancestor or to html.
   * Defaults to false.
   *
   * @internal Admin-only: used in the monetize.software paywall editor for
   * live-preview. End SDK integrators don't need to enable it — the modal would
   * blend into the host's layout instead of being a fullscreen overlay.
   */
  inline?: boolean;
  /**
   * Explicit language override for I18nProvider. Used by the admin panel
   * editor's live-preview ("Preview as user from <country>") — there the
   * browser-locale is always EN, but we need to show it as for a user from the
   * chosen country. Accepts a BCP-47 base-tag from `BUNDLED_LOCALES`
   * (ru/de/fr/…); EN, null, undefined — fall back to the normal resolution
   * logic (navigator.language → locale_default).
   *
   * Live updates — via {@link PaywallUI.setLocale}.
   *
   * @internal Admin-only: for end integrators there's no point forcing the
   * language — the SDK adapts to the browser-locale itself.
   */
  locale?: string | null;
}

/**
 * Result of `paywall.getAccess()` — answers the host's main question: "do I
 * need to block the feature for this user?". No side effects: `recordBlock`
 * isn't called on trial-storage (counters don't move), the modal isn't mounted.
 *
 * `access` semantics:
 *  - `granted` — do NOT block the feature. One of the scenarios:
 *    - `has_subscription` — the user has an active subscription/purchase;
 *    - `visibility_blocked` — targeting (country/device/visibility-flag) didn't
 *       match, the user is outside the paywall's monetization scope →
 *       monetization not applicable;
 *    - `trial_blocked` — the pre-paywall trial is still active.
 *  - `blocked` — block the feature and call `paywall.open()`. The reason is
 *     always `no_subscription`.
 *
 * Discriminated union on `access`: type-narrowing on `result.access === 'blocked'`
 * narrows `reason` to `'no_subscription'`, on `'granted'` — to the three
 * granted variants.
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

/** Internal-only extension of `OpenOptions` — we don't expose `authMode` in the
 *  public API (there are dedicated `openSignin`/`openSignup`), but pass it
 *  through here via private methods plus mountAndShow. */
type InternalOpenOptions = OpenOptions & {
  authMode?: 'signin' | 'signup';
};

export interface OpenOptions {
  identity?: Identity;
  /** Force-open, bypassing the pre-paywall trial check. By default the SDK
   *  reads `bootstrap.settings.trial` and blocks open() while the trial is
   *  active. An escape hatch for cases like "the host decided to show it
   *  anyway" or dev mode. */
  skipTrial?: boolean;
  /** Force-open, bypassing the targeting gate. By default the SDK reads
   *  `bootstrap.settings.visibility` and emits `visibility_blocked` without
   *  opening the modal if visible=false (country/device/visibility-flag didn't
   *  match). An escape hatch for dev debugging. */
  skipVisibility?: boolean;
  /** Renewal/upgrade flow. By default (false) the SDK, after bootstrap or
   *  signIn, checks `user.has_active_subscription` and switches to the restored
   *  success-view without showing the plans — open() for an already-subscribed
   *  user turns into a confirmation "you already have a subscription". With
   *  `renew: true` all these checks are skipped: the plans are always shown,
   *  and on checkout the SDK passes `ignoreActivePurchase: true` to the backend
   *  so /start-checkout doesn't return a 409. Use it when the host UI
   *  explicitly shows a "Renew"/"Upgrade plan" button. */
  renew?: boolean;
}

// URL markers by which the SDK determines the checkout result.
// The contract is shared with the backend — online adds them to success/cancel
// URLs.
const URL_MARKERS = {
  status: 'paywall_status',
  priceId: 'paywall_price_id',
  sessionId: 'paywall_session_id'
} as const;

export class PaywallUI {
  readonly billing: BillingClient;
  /** AuthClient (managed-auth) or undefined in hybrid mode. Publicly available:
   *  the host can call `paywall.auth?.signOut()`, read `getCachedSession()`,
   *  subscribe to `onAuthChange` directly. */
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
  /** The view the modal was last mounted with. Gates the `paywall_viewed`/
   *  `paywall_closed` analytics to the real paywall (`'layout'`): opening
   *  support / standalone-auth / awaiting_payment emits the public `'ready'`
   *  and `'close'`, but that's not "paywall viewed/closed" — otherwise a
   *  support click sends a false `paywall_viewed`. */
  private lastMountedView: PaywallView | null = null;
  /** Lazy TrialStore instance. Resolved on the first open(), when we already
   *  know `bootstrap.settings.trial`. null — the trial is disabled in the
   *  paywall config. */
  private trialStore: TrialStore | null = null;
  /** The config the current trialStore was created for — we rebuild it if it
   *  changed between bootstrap fetches (e.g. the owner switched the mode in the
   *  admin panel between SDK sessions). */
  private trialStoreConfig: TrialConfig | null = null;
  /** In-memory snapshot of the last check() — for synchronous getTrialStatus(). */
  private lastTrialStatus: TrialStatus | null = null;
  /** Dedupe flag for the `trial_expired` event within the instance's lifetime. */
  private trialExpiredFired = false;
  /** In-memory snapshot of the last bootstrap — for synchronous getVisibility(). */
  private lastVisibility: VisibilityStatus | null = null;
  /** open() behavior on a cold bootstrap. See PaywallUIOptions.mountThenLoad. */
  private mountThenLoad: boolean;
  /** Inline mode (editor's live-preview). See PaywallUIOptions.inline. */
  private inline: boolean;
  /** Force-locale for I18nProvider. See PaywallUIOptions.locale. */
  private forceLocale: string | null;
  /** The current UI state-machine snapshot. Updated by PaywallRoot via the
   *  `onState` prop; reset back to CLOSED_STATE on close. */
  private currentState: PaywallStateSnapshot = CLOSED_STATE;
  private stateListeners = new Set<PaywallStateListener>();

  constructor(opts: PaywallUIOptions) {
    // Resolve the AuthClient: a ready instance / managed config (true|object) /
    // undefined. ownsAuth=true → we created it ourselves and must clean it up
    // in destroy().
    const { auth, ownsAuth } = resolveAuth(opts);
    this.auth = auth;
    this.ownsAuth = ownsAuth;

    // If auth exists — we forward it to BillingClient (which connects Bearer
    // and auto-syncs identity via onAuthChange itself). The client from opts
    // wins — we assume the host already configured it itself and don't overwrite
    // its auth.
    this.billing =
      opts.client ?? new BillingClient({ ...opts, auth: this.auth });
    this.host = opts.host;
    this.shadowMode = opts.shadowMode ?? 'closed';
    this.mountThenLoad = opts.mountThenLoad ?? true;
    this.inline = opts.inline === true;
    this.forceLocale = opts.locale ?? null;

    // Forward user-change events from BillingClient to PaywallUI's public API.
    // One source of truth (BillingClient cache) — two consumers (the host via
    // paywall.onUserChange and the watcher itself via billing.onUserChange).
    this.userUnsub = this.billing.onUserChange((user) => {
      this.emit('userChange', user);
      // Drive the awaiting→success transition from the user-state itself, not
      // only from UserWatcher. The manual "I've paid" button (getUser → applyUser
      // → here) and cross-context broadcasts flip cachedUser to active and land
      // here even where the watcher doesn't run (a full extension page on
      // chrome-extension://). Guard on the checkout views so we don't transition
      // when the paywall opens for an already-subscribed user — that path is
      // getAccess=granted and never mounts awaiting_payment.
      if (
        user.has_active_subscription &&
        (this.lastMountedView === 'awaiting_payment' ||
          this.lastMountedView === 'popup_blocked')
      ) {
        this.handlePurchaseDetected(user);
      }
    });

    if (this.auth) {
      this.authUnsub = this.auth.onAuthChange((event, session) => {
        this.emit('authChange', { event, session });
      });
    }

    this.initTracker(opts.analytics);

    if (opts.autoDetectReturn !== false && typeof window !== 'undefined') {
      // Microtask — the client has time to subscribe synchronously after the
      // constructor, before the event actually fires.
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

    // Bind internal SDK events to the analytics transport. One emitter, one
    // consumer (the tracker) — nobody but the tracker should touch these event
    // names outside PaywallUI.
    // paywall_viewed — only for the real paywall ('layout'). The public
    // 'ready'/'close' are emitted for support/auth/awaiting_payment too, but
    // that's not "paywall viewed" (see lastMountedView). 'open' is no longer
    // tracked separately: 'viewed' (on 'ready', after bootstrap loads) is the
    // single signal of a paywall view.
    this.on('ready', (b) => {
      if (this.lastMountedView !== 'layout') return;
      this.tracker?.track('paywall_viewed', {
        is_test_mode: b.settings.is_test_mode,
        prices_count: b.prices.length,
        offers_count: b.offers.length
      });
    });
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
    this.on('close', () => {
      if (this.lastMountedView === 'layout') this.tracker?.track('paywall_closed');
    });
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
    // auth_signin_success / auth_signout aren't fired yet: authChange is
    // emitted on session hydration (the UI restores the cache from storage), on
    // token refresh, and with parallel consumers of one auth-state — it gives
    // false signins. Real login events should be caught via direct
    // signInWithEmail/signUp/signInWithOAuth/signOut calls, not via authChange.
  }

  /**
   * Send an arbitrary analytics event. Names from the system whitelist
   * (`app_opened`, `paywall_viewed`, ...) are allowed as-is. Custom ones —
   * with a `host:` prefix (e.g. `host:user_clicked_upgrade`). The server drops
   * events with disallowed names.
   *
   * The most common case is `track('app_opened')` from the host right after the
   * app loads, to record the funnel before the paywall opens.
   */
  track(name: string, props?: Record<string, unknown>): void {
    this.tracker?.track(name, props);
  }

  /**
   * A convenient shortcut for `paywall.on('userChange', cb)` — the most common
   * pattern in host code, hence a separate named method. The callback receives
   * the last-known user from the cache synchronously via a microtask, if any.
   */
  onUserChange(handler: PaywallEventHandler<'userChange'>): () => void {
    return this.on('userChange', handler);
  }

  /**
   * Replace cachedBootstrap with live data — for preview mode in the admin
   * panel editor. If the modal is open, PaywallRoot is subscribed to
   * onBootstrapChange and re-renders instantly. Before open() — a seed for the
   * bootstrap() effect.
   *
   * See {@link BillingClientOptions.preview} — usually this option is set on
   * the client to also disable the network revalidate. setBootstrap technically
   * works in production mode too, but competing with a revalidate from the
   * network is almost always undesirable.
   */
  setBootstrap(partial: Partial<PaywallBootstrap>): void {
    this.billing.setBootstrap(partial);
  }

  /**
   * Change the force-locale on the fly — for the admin panel editor's
   * live-preview, when the user switches "Preview as user from <country>".
   * Loads the corresponding static chunk and forces a re-render via
   * handle.update. See PaywallUIOptions.locale.
   *
   * Pass `null`/`undefined` to return to the automatic resolution logic
   * (navigator.language → locale_default).
   */
  setLocale(locale: string | null | undefined): void {
    const next = locale ?? null;
    if (next === this.forceLocale) return;
    this.forceLocale = next;
    // handle exists only if the modal is open; otherwise the locale is picked
    // up on the next mountAndShow() from the saved this.forceLocale.
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
   * Warms up the bootstrap cache and balance cache in advance, without opening
   * the modal. Useful when the host knows the user will soon open the paywall
   * (hover on the CTA, component mount) — the first `open()` renders instantly,
   * without a loading flash.
   *
   * Doesn't throw: if the network failed, it silently ignores it (a repeat
   * open() does a fresh bootstrap with an error-state as usual). `signal` for
   * cancellation — e.g. if the host unmounts the component faster than bootstrap
   * returns.
   *
   * Can be called any number of times — subsequent calls return a cached
   * Promise (BillingClient already deduplicates).
   */
  async preload(opts: { signal?: AbortSignal } = {}): Promise<void> {
    try {
      await this.billing.bootstrap({ signal: opts.signal });
      // Balances — best-effort: paywalls without `tokenization` return an empty
      // array, and getBalances doesn't make a network request for an unauth
      // user.
      if (this.billing.auth) {
        await this.billing.getBalances({ signal: opts.signal });
      }
    } catch {
      /* preload is best-effort — open() will show the error-state itself */
    }
  }

  /**
   * Opens the modal straight to the support form (bypassing the layout with
   * plans). Useful when the host app wants to give the user a "Help / Support"
   * button unrelated to a paywall upgrade. Back/Done in the support form close
   * the modal (don't return to the plans), because the user came here directly.
   *
   * From the regular `paywall.open()` flow support is still available via the
   * Contact Support link in the `current_session` block (there Back returns to
   * the layout).
   */
  openSupport(opts: OpenOptions = {}): void {
    this.openInternal('support', opts);
  }

  /**
   * Opens the modal straight to the auth-gate (login/registration), without the
   * layout with plans. Scenario: a returning customer already bought and just
   * needs to sign in so the SDK picks up their purchases. After signIn the
   * modal closes; Back also closes it (the user came only to log in).
   *
   * Without `auth` (managed-auth not connected) the method is a no-op: there's
   * no one to do signIn. If the user is already signed in — the modal still
   * opens and closes via auto-resume in the auth_gate effect (instantly).
   *
   * The trial doesn't block this flow — auth isn't connected to the trial
   * mechanics.
   */
  openAuth(opts: OpenOptions = {}): void {
    if (!this.auth) return;
    this.openInternal('auth', { ...opts, skipTrial: true });
  }

  /**
   * A shortcut over `openAuth()` — opens the modal straight to the signin form.
   * Equivalent to `openAuth()` (signin is the default). Exists for symmetry with
   * `openSignup()` and host-code readability:
   *   - `paywall.openSignin()` — "log in to an existing account"
   *   - `paywall.openSignup()` — "new registration"
   * Without managed-auth — a no-op.
   */
  openSignin(opts: OpenOptions = {}): void {
    if (!this.auth) return;
    this.openInternal('auth', { ...opts, skipTrial: true, authMode: 'signin' });
  }

  /**
   * Opens the modal with the auth-gate straight in registration mode (the
   * AuthPanel's signup mode — email/password/repeat). If the admin disabled
   * allow_signup in the paywall layout, AuthPanel ignores the mode and starts
   * with signin — the admin config is respected.
   * Without managed-auth — a no-op.
   */
  openSignup(opts: OpenOptions = {}): void {
    if (!this.auth) return;
    this.openInternal('auth', { ...opts, skipTrial: true, authMode: 'signup' });
  }

  /**
   * Direct-checkout: create a checkout URL for a specific price and immediately
   * open the payment provider, bypassing the layout with plans. Useful when the
   * host app renders pricing cards/a table with its own UI and wants a click on
   * "Buy / Get this plan" to lead straight to Stripe/Paddle.
   *
   * **Late-mount UX.** Unlike `open()`, the modal doesn't appear during the
   * background work (bootstrap + visibility/trial gates + createCheckout). The
   * host shows a busy-state right on its own button during this phase (via
   * `state.processing === true` from `paywall.getState()` — or automatically via
   * `<PaywallButton priceId>` in sdk-react). The modal is mounted ONLY when the
   * UI is really needed:
   *  - `checkout_mode='preauth'` + managed-auth + not signed in → auth-gate
   *    (the signin form); after success, auto-resume into createCheckout.
   *  - the provider's popup is blocked by the browser → a popup_blocked view
   *    with a retry button under a fresh user gesture.
   *  - the popup opened successfully → an awaiting_payment view (a "pay in the
   *    new tab" indicator + I've paid).
   *
   * What's emitted without the modal:
   *  - `purchase_completed{restored:true, priceId}` when the user is already
   *    subscribed (cached user, fresh bootstrap, or a 409 hasActivePurchase
   *    from the backend) — a headless reject;
   *  - `error` when createCheckout failed or identity.email is missing;
   *  - `visibility_blocked` / `trial_blocked` — the standard gate events.
   *
   * What's emitted together with the modal:
   *  - `checkout_started{priceId, url, acquiring}` exactly when the headless URL
   *    is received, BEFORE mounting awaiting_payment/popup_blocked.
   *
   * The offer (countdown discount) is automatically resolved from cached offers
   * via `getOfferForPrice(priceId)` and passed into createCheckout as `offerId`
   * — so duration_minutes offers also apply on the backend (there's no
   * server-side timer for them, and without an explicit offer-id the discount is
   * lost).
   *
   * Requirements:
   *  - `identity.email` must be set (via `opts.identity`, or managed-auth, or an
   *    early `setIdentity`/`paywall.open({identity})`). Without an email the
   *    backend `/start-checkout` returns 400; the SDK emits `error`.
   *  - In `checkout_mode='preauth'` without managed-auth — the backend requires
   *    an email user; make sure `identity.email` is explicitly set.
   *
   * Without a modal at all (when the host renders its own awaiting-payment
   * screen) — use `paywall.billing.createCheckout({priceId, offerId})` directly,
   * but then you'll have to draw auth-gate / popup_blocked / awaiting_payment
   * yourself.
   */
  checkout(priceId: string, opts: OpenOptions = {}): void {
    if (opts.identity) this.billing.setIdentity(opts.identity);

    // Cached user → already-paid: we mount nothing and emit headless.
    // renew skips all pre-checks — the host is explicitly doing an upgrade.
    if (opts.renew !== true) {
      const cachedUser = this.billing.getCachedUser();
      if (cachedUser?.has_active_subscription) {
        this.emit('purchase_completed', {
          priceId,
          sessionId: null,
          restored: true
        });
        return;
      }
    }

    // Late-mount: everything from here is async. We turn on the processing
    // flag, and via state.processing the host sees "the SDK is doing something"
    // and disables the button. We reset processing to false only in the
    // no-mount returns (headless reject, gate-block, error). For paths ending in
    // mountAndShow, PaywallRoot.onState reports processing=false itself with its
    // very first snapshot — if we did .finally here, there'd be a flicker
    // "processing=false, view=null" between applyProcessing(false) and
    // PaywallRoot.onState (which looks like "nothing is happening").
    void this.runDirectCheckout(priceId, opts);
  }

  /** Headless prep-work for `checkout(priceId, opts)`: bootstrap → gates →
   *  preauth check → createCheckout → mount the modal with the final view.
   *  Extracted into a separate method for a clean async/await flow instead of
   *  nested then-chains (5+ branches). Any error isn't propagated outward: we
   *  emit via `paywall.emit('error')` and exit — the host is subscribed to the
   *  `error` event. */
  private async runDirectCheckout(
    priceId: string,
    opts: OpenOptions
  ): Promise<void> {
    const renew = opts.renew === true;
    const skipTrial = opts.skipTrial === true;
    const skipVisibility = opts.skipVisibility === true;

    // Turn on processing for the host's button.
    this.applyProcessing(true);

    // Helper: emit/headless exit — we must reset processing before returning,
    // otherwise the host's UI hangs in busy-state forever.
    const exitHeadless = (): void => {
      this.applyProcessing(false);
    };

    // 1. Bootstrap. Cached path — instant; cold — RTT 200-500ms.
    let bootstrap: PaywallBootstrap;
    try {
      bootstrap = await this.billing.bootstrap();
    } catch (err) {
      const wrapped =
        err instanceof PaywallError
          ? err
          : new PaywallError('unknown', 'Failed to load paywall', { cause: err });
      this.emit('error', wrapped);
      exitHeadless();
      return;
    }

    // 2. Gates (visibility → trial). We do NOT mount the modal: a blocking gate
    //    → emit and exit. Identical semantics to open(): trial_blocked /
    //    visibility_blocked.
    if (!skipVisibility) {
      const v = bootstrap.settings.visibility;
      if (v) {
        this.lastVisibility = v;
        if (!v.visible) {
          this.emit('visibility_blocked', v);
          exitHeadless();
          return;
        }
      }
    }
    if (!skipTrial) {
      const trialBlocked = await this.checkTrialBeforeCheckout(bootstrap);
      if (trialBlocked) {
        exitHeadless();
        return;
      }
    }

    // 3. Fresh bootstrap user — we re-check the active subscription.
    //    The cached path above may have been stale (signOut in another tab,
    //    etc.).
    if (!renew && bootstrap.user?.has_active_subscription) {
      this.emit('purchase_completed', {
        priceId,
        sessionId: null,
        restored: true
      });
      exitHeadless();
      return;
    }

    // 4. Preauth check. If a real signin is required — we mount the modal with
    //    the auth-gate; after signin PaywallRoot does createCheckout itself
    //    (runCheckout inside the auth-resume effect), and the offer is resolved
    //    there the same way. PaywallRoot.onState resets processing with its
    //    first snapshot (processing=false in computePaywallSnapshot), so we
    //    don't need to do it by hand here.
    const mode = bootstrap.settings.checkout_mode ?? 'guest';
    const cachedSession = this.auth?.getCachedSession() ?? null;
    const hasRealSession = !!cachedSession && !cachedSession.user.is_anonymous;
    const needsAuth = mode === 'preauth' && !!this.auth && !hasRealSession;
    if (needsAuth) {
      this.purchased = false;
      this.mountAndShow('auth', {
        renew,
        authMode: 'signin',
        checkoutPriceId: priceId
      });
      return;
    }

    // 5. Headless createCheckout. We resolve the offer right here — without an
    //    explicit offerId, duration offers (countdown in clientStorage) won't
    //    apply on the backend.
    const offer = this.getOfferForPrice(priceId);
    let result;
    try {
      result = await this.billing.createCheckout({
        priceId,
        offerId: offer?.offer.id,
        ignoreActivePurchase: renew
      });
    } catch (error) {
      if (
        error instanceof PaywallError &&
        error.code === 'already_purchased'
      ) {
        try {
          await this.billing.getUser({ force: true });
        } catch {
          /* offline — getUser will report to the host itself */
        }
        this.emit('purchase_completed', {
          priceId,
          sessionId: null,
          restored: true
        });
        exitHeadless();
        return;
      }
      const wrapped =
        error instanceof PaywallError
          ? error
          : new PaywallError('checkout_failed', 'Checkout failed', { cause: error });
      this.emit('error', wrapped);
      exitHeadless();
      return;
    }

    // 6. We emit checkout_started BEFORE mounting — the host's analytics
    //    listener fires synchronously (the modal isn't on screen yet, but the
    //    event already happened). We also start UserWatcher via onEvent in
    //    mountAndShow (it attaches a handler to checkout_started), but
    //    startUserWatcher is idempotent — a repeat call here won't break
    //    anything.
    this.emit('checkout_started', {
      priceId,
      url: result.url,
      acquiring: result.acquiring
    });
    this.startUserWatcher();

    // 7. Open the popup and mount the corresponding view. SSR/no-window —
    //    awaiting without attempting window.open (the host redirects from its
    //    own env).
    if (typeof window === 'undefined' || !result.url) {
      this.mountAndShow('awaiting_payment', {
        renew,
        checkoutPriceId: priceId,
        checkoutUrl: result.url
      });
      return;
    }
    const popup = window.open(result.url, '_blank');
    this.purchased = false;
    if (popup) {
      try {
        popup.opener = null;
      } catch {
        /* cross-origin already — ok */
      }
      this.mountAndShow('awaiting_payment', {
        renew,
        checkoutPriceId: priceId,
        checkoutUrl: result.url
      });
    } else {
      // Popup blocked — usually after an async signin (the transient activation
      // is lost). The modal stays with its retry button; a click = a fresh
      // gesture and the popup will open.
      this.mountAndShow('popup_blocked', {
        renew,
        checkoutPriceId: priceId,
        checkoutUrl: result.url
      });
    }
  }

  /** Trial check without mounting (for late-mount direct-checkout). Returns
   *  true if the trial blocked — the caller must stop the flow. On any storage
   *  error we log+continue (we don't block the sale). */
  private async checkTrialBeforeCheckout(
    bootstrap: PaywallBootstrap
  ): Promise<boolean> {
    const trialCfg = bootstrap.settings.trial;
    if (!trialCfg) return false;
    const store = this.ensureTrialStore(trialCfg);
    try {
      const status = await store.check();
      this.lastTrialStatus = status;
      if (status.mode === 'none') return false;
      if (status.blocked) {
        const updated = await store.recordBlock();
        this.lastTrialStatus = updated;
        this.emit('trial_blocked', updated);
        return true;
      }
      if (!this.trialExpiredFired) {
        this.trialExpiredFired = true;
        this.emit('trial_expired');
      }
      return false;
    } catch (e) {
      if (typeof console !== 'undefined') {
        console.warn('[paywall] trial check failed', e);
      }
      return false;
    }
  }

  private applyProcessing(value: boolean): void {
    if (this.currentState.processing === value) return;
    // We mutate processing on the current snapshot while keeping the other
    // fields. PaywallRoot emits its snapshots with processing=false; here we
    // update the field before/after mounting — between these points the state
    // doesn't change via PaywallRoot.onState.
    this.applyState({ ...this.currentState, processing: value });
  }

  /**
   * Headless anonymous signin without opening the modal. Internally:
   * idempotent (if already anon — instant return) → resume via the saved
   * refresh_token → fresh /auth/anonymous/signin. Deduplicates parallel calls
   * inside the AuthClient.
   *
   * Convenient for host buttons like "Continue as guest" — the host manages the
   * loading-state on its own button, without a half-empty modal with a spinner.
   * Without managed-auth — resolves with a rejected promise (there's no
   * AuthClient to do signin).
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
    // Reset the success-view flag — a repeat open should start from the regular
    // layout, not from a previous "Payment received".
    this.purchased = false;

    // The support and auth-standalone flows bypass both gates (trial and
    // targeting): the user came for support or to log in to an already-bought
    // subscription — blocking them by trial-stage or targeting is inappropriate.
    // openAuth additionally passes skipTrial:true for compatibility with the
    // former semantics; here we normalize the skip flags uniformly.
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

    // Cache hit — the sync path, gates before mount as before. No compromises:
    // when bootstrap is already in memory, we know in one tick whether we can
    // open or not, without a flash.
    const cached = this.billing.getCachedBootstrap();
    if (cached) {
      this.runOpenGates(view, cached, { skipTrial, skipVisibility, renew });
      return;
    }

    // Cold bootstrap. Two modes:
    //
    // mountThenLoad=true (default): we mount the modal immediately — the user
    //   sees a spinner, the button responds instantly. Bootstrap runs in
    //   parallel. When it arrives — we run the gates, and if one blocks, we
    //   close the modal with a *_blocked emission. The price is a flash "opened
    //   → closed" in the rare case of a visibility/trial block. For extensions
    //   and sites with targeting enabled most open()s pass, so the flash is an
    //   edge case.
    //
    // mountThenLoad=false (legacy): we wait for bootstrap before mounting.
    //   Guaranteed no flash on a block, but the button feels "dead" for
    //   200-500ms on a cold cache.
    if (this.mountThenLoad) {
      this.mountAndShow(view, { renew });
      this.billing
        .bootstrap()
        .then((b) => this.runDelayedGates(b, { skipTrial, skipVisibility }))
        .catch(() => {
          // Bootstrap failed — the modal is already open, PaywallRoot is in the
          // error-state itself.
        });
      return;
    }

    this.billing
      .bootstrap()
      .then((b) =>
        this.runOpenGates(view, b, { skipTrial, skipVisibility, renew })
      )
      .catch(() => {
        // Bootstrap failed — we open without gates; PaywallRoot shows the error.
        this.mountAndShow(view, { renew });
      });
  }

  /** Apply gates AFTER the modal is already mounted (the mount-then-load path).
   *  If a gate blocks — close() + emit. If the user already closed the modal
   *  themselves before bootstrap resolved — a no-op (isOpen=false). */
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

  // Gate order: visibility → trial. A country-mismatch ≠ a trial-block, and
  // keeping a trial-state "N views left" under a user who shouldn't see the
  // paywall at all by targeting is pointless: when they return to the correct
  // country they'd end up with a "stuck" trial counter.
  private runOpenGates(
    view: PaywallView,
    bootstrap: PaywallBootstrap,
    flags: {
      skipTrial: boolean;
      skipVisibility: boolean;
      renew: boolean;
    }
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

  private gateThroughTrial(
    view: PaywallView,
    bootstrap: PaywallBootstrap,
    renew: boolean
  ): void {
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
          // recordBlock writes (init firstOpen / inc skipTimes) and returns the
          // updated snapshot — we emit it so the host gets an up-to-date
          // counter.
          const updated = await store.recordBlock();
          this.lastTrialStatus = updated;
          this.emit('trial_blocked', updated);
          return;
        }
        // The trial is in the config but doesn't block → it expired. We emit
        // once per session, then open as usual.
        if (!this.trialExpiredFired) {
          this.trialExpiredFired = true;
          this.emit('trial_expired');
        }
        this.mountAndShow(view, { renew });
      })
      .catch((e) => {
        // Storage is unavailable (privacy mode, quota) — we don't block the
        // user, we open the modal and don't lose the sale.
        if (typeof console !== 'undefined') console.warn('[paywall] trial check failed', e);
        this.mountAndShow(view, { renew });
      });
  }

  private ensureTrialStore(config: TrialConfig): TrialStore {
    if (this.trialStore && this.trialStoreConfig && sameTrialConfig(this.trialStoreConfig, config)) {
      return this.trialStore;
    }
    this.trialStoreConfig = config;
    // Duck-type: if the billing client provides its own factory (the
    // extension's RemoteBillingClient — an atomic TrialStore via offscreen +
    // navigator.locks), we use it. Otherwise — the regular path via the
    // storage-adapter.
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
    mountOpts: {
      renew?: boolean;
      authMode?: 'signin' | 'signup';
      /** Direct-checkout context. Passed into PaywallRoot for two modes:
       *   - `view='auth'` + priceId → preauth-flow: the gate starts in
       *     auth_gate with pendingCheckout.direct=true;
       *   - `view='awaiting_payment'|'popup_blocked'` + priceId + url →
       *     the headless checkout already issued the URL, the modal shows the
       *     final screen without a loading flash. */
      checkoutPriceId?: string;
      checkoutUrl?: string;
    } = {}
  ): void {
    // We remember the view for the analytics gate (paywall_viewed/paywall_closed)
    // — we emit them only when we actually show the paywall ('layout').
    this.lastMountedView = view;
    const renew = mountOpts.renew === true;
    const initialAuthMode = mountOpts.authMode;
    // priceId only makes sense for auth (preauth direct-checkout) and
    // awaiting_payment/popup_blocked (post-headless mount). On the other views
    // we normalize it to null so handle.update doesn't carry a stale priceId
    // from a previous direct-checkout session.
    const carriesCheckoutContext =
      view === 'auth' || view === 'awaiting_payment' || view === 'popup_blocked';
    const initialCheckoutPriceId = carriesCheckoutContext
      ? mountOpts.checkoutPriceId ?? null
      : null;
    const initialCheckoutUrl =
      view === 'awaiting_payment' || view === 'popup_blocked'
        ? mountOpts.checkoutUrl ?? null
        : null;
    if (this.handle) {
      this.isOpen = true;
      this.handle.update({
        open: true,
        initialView: view,
        initialAuthMode,
        initialCheckoutPriceId,
        initialCheckoutUrl,
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
        initialCheckoutPriceId,
        initialCheckoutUrl,
        purchased: false,
        renew,
        onClose: () => this.close(),
        onEvent: (event, payload) => {
          this.emit(event as PaywallEvent, payload as never);
          // We start the watcher as soon as checkout begins — from here on we
          // rely on the server-confirmed flow, not URL markers.
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
   * A sync snapshot of the modal's current state. Suitable for
   * `useSyncExternalStore` in React
   * (`useSyncExternalStore(paywall.onStateChange, paywall.getState)`) and for
   * one-off checks ("is the paywall open right now?").
   *
   * The snapshot is stable — as long as the state hasn't changed, a repeat
   * getState() returns a `===`-equal object (important for useSyncExternalStore
   * to avoid re-rendering).
   */
  getState(): PaywallStateSnapshot {
    return this.currentState;
  }

  /**
   * Subscribe to state changes. The callback is called on every real change
   * (closed → loading → ready → ...). By default the initial snapshot is
   * delivered via a microtask after subscribing; via `{immediate: 'sync'|'none'}`
   * you can do sync delivery (not needed for useSyncExternalStore — there the
   * snapshot is read via getSnapshot separately) or skip the initial entirely.
   *
   * Returns an unsubscribe function.
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

  /** Sync access to the last known trial status. null — `paywall.open()` hasn't
   *  been called yet or the trial is disabled in the paywall config. Convenient
   *  for the host's own UI ("3 views left", "the trial expires in 2h"). */
  getTrialStatus(): TrialStatus | null {
    return this.lastTrialStatus;
  }

  /** Sync access to the last server-computed visibility status. null —
   *  bootstrap isn't loaded yet or the server doesn't return
   *  `settings.visibility` (e.g. an old version of online without the targeting
   *  patch). The host can use it for its own fallback: "the service isn't
   *  available in your country". Updated on every open() that passes through the
   *  gate. */
  getVisibility(): VisibilityStatus | null {
    return this.lastVisibility;
  }

  /**
   * The paywall's prices — a shortcut over `bootstrap()`. Locales are already
   * applied, and the cache and stale-while-revalidate are identical to
   * `billing.bootstrap()`. Suitable for pricing pages/cards on the site, where
   * the host wants to show the same prices as in the modal without pulling
   * bootstrap by hand.
   */
  getPrices(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<PaywallPrice[]> {
    return this.billing.getPrices(opts);
  }

  /** A sync snapshot of the prices. null — bootstrap hasn't been loaded yet. */
  getCachedPrices(): PaywallPrice[] | null {
    return this.billing.getCachedPrices();
  }

  /** A sync snapshot of the offers. null = bootstrap not loaded, [] = a paywall
   *  without offers. The backend already applied server-side targeting
   *  (countries/email/mode) — only what's applicable to the current user comes
   *  out. */
  getCachedOffers(): PaywallOffer[] | null {
    return this.billing.getCachedOffers();
  }

  /**
   * Resolves the active offer for a specific price: price_id targeting +
   * countdown (`expires_at` OR `duration_minutes` from the first paywall open,
   * see clientStorage `pw-offer-{id}-start`).
   *
   * Read-only — does NOT write the start for `duration_minutes` offers. The
   * write starts only when the modal is actually open (by the renderer). Before
   * that `getOfferForPrice` returns `null` for duration-only offers, so host
   * pages outside the modal (pricing, landing) don't activate the countdown
   * prematurely.
   *
   * A host page that needs a countdown ticking every second should use the React
   * hook `usePaywallOffer(priceId)` from sdk-react, or a wrapper over
   * `setInterval(1000)` + a repeat call to this method.
   */
  getOfferForPrice(priceId: string): ResolvedOffer | null {
    const offers = this.billing.getCachedOffers();
    if (!offers) return null;
    const offer = findApplicableOffer(offers, priceId);
    if (!offer) return null;
    return resolveOffer(offer, {
      now: Date.now(),
      readStart: readBrowserOfferStart
    });
  }

  /** A snapshot of the current "user language" — a proxy over
   *  `billing.getUserLanguage()`. Use it to sync the host's i18n with what the
   *  paywall actually shows. See the details in `BillingClient.getUserLanguage`. */
  getUserLanguage(): UserLanguageInfo {
    return this.billing.getUserLanguage();
  }

  /**
   * Decides whether the feature should be blocked for the current user. No side
   * effects (`recordBlock` isn't called on trial-storage, the modal isn't
   * mounted).
   *
   * Check order (the first one that triggers is final):
   *  1. `has_active_subscription` — the strongest signal, overrides the rest.
   *     A user with a subscription gets access regardless of visibility/trial.
   *  2. `visibility` (country/device/disabled-flag) — the user is outside the
   *     paywall's monetization scope, can't be gated.
   *  3. `trial` — the pre-paywall free period is active.
   *  4. Otherwise — `blocked`, the host locks the feature and calls
   *     `paywall.open()`.
   *
   * Bootstrap is cached in BillingClient — `getAccess()` can be called on every
   * render of the host component, /bootstrap isn't duplicated. On a failed
   * network it falls back to the persistent-cached user from storage: a user
   * with a past subscription gets `granted` offline, otherwise `blocked` (the
   * host shows the paywall with an error-state, the user can retry). Side
   * effect: `lastVisibility` / `lastTrialStatus` are updated so the synchronous
   * getters `getVisibility()` / `getTrialStatus()` see fresh data after the
   * first `getAccess()`, not only after the first `open()`.
   */
  async getAccess(opts: GetAccessOptions = {}): Promise<PaywallAccessResult> {
    let bootstrap = this.billing.getCachedBootstrap();
    if (!bootstrap) {
      try {
        bootstrap = await this.billing.bootstrap({ signal: opts.signal });
      } catch {
        // The network failed. Fall back to the persistent-cached user (TTL 30
        // min in storage). A user with a past subscription → granted
        // (offline-friendly), otherwise → blocked (open() shows the paywall
        // with an error-state, the user retries).
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

    // Cached bootstrap contains a user-snapshot FROM THE MOMENT of its fetch —
    // after a purchase this snapshot is stale (has_active_subscription=false),
    // even though UserWatcher already updated `billing.cachedUser` to true and
    // emitted userChange. `getCachedBootstrap()` intentionally returns the raw
    // structure (it shouldn't be rebuilt every time), so we do the overlay here:
    // we prefer cachedUser, falling back to bootstrap.user if cachedUser isn't
    // loaded yet (cold start or after signOut). Without this fix usePaywallAccess
    // reacts to a userChange event, calls getAccess, but gets a
    // stale-bootstrap.user — the host's <PaywallGate> stays blocked while the
    // subscription is actually active.
    const user = this.billing.getCachedUser() ?? bootstrap.user ?? null;

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

  /** Reset the trial state in storage. Useful for dev mode / an admin button
   *  "run the scenario again". In prod the host usually doesn't call it. */
  async resetTrial(): Promise<void> {
    if (!this.trialStore) return;
    await this.trialStore.reset();
    this.lastTrialStatus = null;
    this.trialExpiredFired = false;
  }

  // Starts polling user-state until has_active_subscription=true or a timeout.
  // Idempotent: a repeat call on an already-running watcher is a no-op (the user
  // might press Continue again after returning).
  //
  // In the extension popup runtime — a no-op (the popup won't survive). There we
  // rely on bootstrap on the next open.
  private startUserWatcher(): void {
    if (this.watcher) return;
    if (!shouldRunUserWatcher()) return;

    this.watcher = new UserWatcher({
      client: this.billing,
      onActive: (user) => this.handlePurchaseDetected(user),
      onTimeout: () => {
        this.watcher = null;
      }
    });
    this.watcher.start();
  }

  // Single funnel for "subscription became active during a checkout flow".
  // Reached from THREE independent sources:
  //   1. UserWatcher.onActive — the background poll (where it runs).
  //   2. billing.onUserChange — the manual "I've paid" button (getUser →
  //      applyUser → onUserChange) and cross-context user-state broadcasts
  //      (sdk-extension offscreen → RemoteBillingClient → onUserChange).
  //   3. (future) any other path that flips cachedUser to active.
  // Idempotent via `this.purchased` (reset to false at the start of every
  // checkout flow — see the direct-checkout/headless mounts).
  //
  // Previously this logic lived ONLY inside watcher.onActive, and the manual
  // button merely posted a `paywall_purchase` window-message to wake the
  // watcher. In runtimes where the watcher doesn't run — a full extension page
  // on chrome-extension:// (shouldRunUserWatcher was false for the whole
  // protocol) — neither the poll nor the manual button could close the awaiting
  // screen: the message had no listener. Funneling through onUserChange fixes
  // both, regardless of whether a watcher exists.
  private handlePurchaseDetected(user: PaywallUser): void {
    if (this.purchased) return;
    this.purchased = true;
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
    // Server-confirmed purchase — a consistent signal for the host regardless
    // of whether there was a URL marker. userChange is emitted by the
    // billing-listener itself.
    this.emit('purchase_completed', { priceId: null, sessionId: null });
    // success_redirect_url from settings — the host explicitly asked to send the
    // user into its apps-flow after payment. The redirect takes priority over
    // PurchaseSuccessView: drawing success for 200ms before the transition would
    // flicker.
    const redirect = this.billing
      .getCachedBootstrap()
      ?.settings.success_redirect_url;
    if (redirect && typeof window !== 'undefined') {
      try {
        window.location.assign(redirect);
        return;
      } catch {
        /* navigation blocked — fall back to the success-view */
      }
    }
    // If the paywall is open — switch to the "Payment received" view with a
    // Continue button. A silent close confused the user: the window just
    // disappeared, without confirmation that the payment went through. If the
    // paywall is closed — the event already fired, the host decides itself.
    if (this.isOpen && this.handle) {
      this.handle.update({ purchased: true });
    }
    void user; // the shape is available via paywall.billing.getCachedUser()
  }

  close(): void {
    if (!this.isOpen || !this.handle) return;
    this.isOpen = false;
    this.purchased = false;
    this.handle.update({ open: false, purchased: false });
    // PaywallRoot emits onState with open=false on handle.update, but due to
    // microtasks the host may read getState() before PaywallRoot's useEffect
    // fires. We apply the closed state right away.
    this.applyState(CLOSED_STATE);
    this.emit('close');
  }

  /**
   * Scans the current URL for checkout-return markers and emits
   * purchase_completed / purchase_failed. The markers are removed from the URL
   * via history.replaceState. It looks in both the hash and the search (the
   * hash takes priority — protection against client SPA routers that intercept
   * the query).
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
      // Acceleration: if the page is loaded in a new tab from the original app
      // (the typical Stripe success_url flow), we send the opener a postMessage.
      // The watcher in the original tab reacts instantly, without waiting for a
      // focus event. If there's no opener (the user closed it / there was none)
      // — fall back to polling.
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
    // If the AuthClient was supplied by the host — its lifecycle isn't ours, we
    // don't touch anything. If we created it — we unsubscribe via BillingClient
    // (which holds the onAuthChange listener itself) and leave the session in
    // storage so the next open picks it up via hydrate.
    if (this.ownsAuth && this.auth) {
      // If we created the AuthClient — we destroy it ourselves so the snapshot
      // listener unsubscribes and doesn't hang around. We don't touch
      // externally-supplied auth.
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
  // Duck-typing: AuthClient OR a structural look-alike (RemoteAuthClient from
  // @monetize/sdk-extension). We check by the public methods PaywallUI uses — if
  // they're all present, we trust it. This lets the host plug in a proxy
  // implementation (offscreen architecture) without changes in PaywallUI.
  // instanceof doesn't fit — the runtime in the content-script and in
  // sdk-extension are different, so the classes aren't nominally equal.
  if (opts.auth instanceof AuthClient || isAuthClientLike(opts.auth)) {
    return { auth: opts.auth as AuthClient, ownsAuth: false };
  }
  // true | partial-options → we create our own AuthClient. We pick up
  // apiOrigin/storage/fetch from PaywallUI's shared options, so the config is
  // "one field — the whole system". The user can override individual fields via
  // opts.auth = { apiOrigin: ... }.
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

// Checks the "AuthClient-likeness" of the passed object by the public methods
// PaywallUI touches (`onAuthChange`, `getCachedSession`, `signOut`).
// Partial<AuthClientOptions> doesn't have these methods — there's no overlap
// with this union, so there will be no false positives.
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
  return (
    a.open === b.open &&
    a.view === b.view &&
    a.error === b.error &&
    a.processing === b.processing
  );
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

// The message contract must match UserWatcher.handleMessage:
// `{ type: 'paywall_purchase' }`. opener — the host's original tab, where
// PaywallUI lives with an active watcher waiting for this signal.
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
    /* the opener is from another origin or closed — the watcher will catch it via focus */
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
