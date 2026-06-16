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
  type PaywallOffer,
  type PaywallPrice,
  type PaywallPurchaseDetailed,
  type PaywallSettings,
  type PaywallUser,
  type UserLanguageInfo,
  PaywallError
} from './types';

// Freshness of the in-memory user cache. 5s is a compromise: enough that a
// naïve user calling getUser in setInterval(1000) doesn't load the server;
// not so much that a successful payment is missed for longer than a couple of
// seconds after revalidateTag.
const USER_CACHE_TTL_MS = 5_000;
// The persistent cache (storage) lives for 30 minutes. Longer — it's risky to
// serve a stale snapshot without the network.
const USER_PERSIST_TTL_MS = 30 * 60_000;
// The persistent bootstrap lives for 1 hour. On every mount BillingClient
// hydrates it from storage and in parallel sends a revalidate with
// `?if_version=<v>`. If the server answered `unchanged: true` — we only update
// user, the structure stays the same (cheap path). On TTL expiry — a blocking
// full request; we don't serve stale that potentially doesn't reflect settings
// changes made by an admin (revalidateTag on the backend invalidates
// unstable_cache but doesn't know about client storage). 1 hour is a
// compromise: cache hits dominate over cold starts, while admin changes reach
// the client within an hour without an explicit refresh.
const BOOTSTRAP_PERSIST_TTL_MS = 60 * 60_000;
// Freshness threshold for the cached bootstrap: if the last write was older
// than this — the next `bootstrap()` fires a background revalidate with
// `?if_version`. Younger — return cached without the network (no point hitting
// it for milliseconds between two `bootstrap()` calls). 5 minutes — most popup
// reopenings fall into the cold period, while we don't storm the server during bursts.
const BOOTSTRAP_STALE_THRESHOLD_MS = 5 * 60_000;
const EMPTY_USER: PaywallUser = {
  has_active_subscription: false,
  purchases: [],
  trial: null,
  had_previous_trial: false
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

// AI provider balances. 5s TTL — same as the user cache: the balance changes
// only after a successful gateway call (we decrement optimistically) or outside
// the SDK (a payment topped up the quota); a short TTL is enough in both cases.
const BALANCES_CACHE_TTL_MS = 5_000;
// Persistent balances live for 5 minutes. Enough that a popup reopening within
// a working session (the typical extension pattern) comes from cache; not so
// long that the balance drifts far from the server truth across several
// purchases in a row. A fresh decrement via `decrementBalanceLocal` is written
// to storage right away and reaches other tabs via `storage.watch`.
const BALANCES_PERSIST_TTL_MS = 5 * 60_000;
// Freshness threshold for the cached balances: when younger, `getBalances()`
// returns the cache without a network request. Older — a background refetch
// (stale-while-revalidate). force=true bypasses the threshold. 30 seconds is a
// compromise: frequent UI renders (the balance counter in a widget) don't storm
// the server, while changes made on the backend without the SDK's involvement
// reach the client fairly quickly.
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
  /**
   * Origin of the SDK server API — required. Must match the `custom_domain`
   * configured for the paywall in the platform (moderation binds the domain to
   * paywall_id). The SDK checks this value against `bootstrap.settings.custom_domain`
   * on the first response and throws `invalid_config` on a mismatch — protection
   * against integrator typos. The intermediate `appbox.space` is NOT used in the
   * new SDK (that's for legacy v2 only).
   */
  apiOrigin: string;
  identity?: Identity;
  storage?: StorageAdapter;
  capabilities?: string[];
  fetch?: typeof fetch;
  /**
   * Server SDK API key. Used for `/start-checkout` in headless/hybrid scenarios
   * where the call comes from a trusted environment (the client's backend). On
   * the client-native path do NOT pass the key — the private token would leak into the browser.
   *
   * By default the constructor throws `apikey_in_browser` if the key is set in a
   * browser context (`window.document`) — protection against the typical
   * integrator blunder. The block can only be lifted deliberately via
   * `allowInsecureBrowserUsage: true`.
   */
  apiKey?: string;
  /**
   * Allow `apiKey` in a browser context. ONLY for e2e/integration tests where
   * the key is injected into the browser intentionally. In production this is a
   * leak of the server-SDK key and a compromise of the entire account. Default
   * false → the constructor throws when it detects the key in the browser. When
   * true — instead of throwing, just a `console.error` warning.
   */
  allowInsecureBrowserUsage?: boolean;
  /**
   * AuthClient for wiring up Bearer authorization and auto-syncing identity. If
   * passed — every request gets `Authorization: Bearer <access_token>`, and
   * identity is recomputed from auth.user on each login/logout/refresh
   * (overrides an explicitly set `opts.identity` after the first auth event).
   *
   * Without auth BillingClient works as before: identity comes from outside via
   * `setIdentity`, Bearer is not sent.
   */
  auth?: AuthClient;
  /**
   * Preview/editor mode. When true:
   *  - `bootstrap()` does NOT hit the network — it returns only `cachedBootstrap`,
   *    set via `setBootstrap()`. Without a seed it throws (the caller must seed before open).
   *  - Storage.watch / persist are disabled (the editor preview is local to the current tab).
   *  - `setBootstrap(partial)` is available as a public setter — the host is
   *    allowed to mutate the cache for live updates of the modal in the admin editor.
   * Default false — normal production mode.
   */
  preview?: boolean;
}

export class BillingClient {
  readonly paywallId: string;
  readonly apiOrigin: string;
  readonly capabilities: string[] | undefined;
  /** AuthClient, if one was passed in options. Otherwise undefined. */
  readonly auth: AuthClient | undefined;
  private api: ApiClient;
  private storage: StorageAdapter;
  private identity: Identity | undefined;
  private apiKey: string | undefined;
  private fetchImpl: typeof fetch | undefined;
  private cachedBootstrap: PaywallBootstrap | null = null;
  // Time of the last successful cachedBootstrap write (mono Date.now). Used for
  // the TTL: after BOOTSTRAP_PERSIST_TTL_MS we consider it stale and go to the
  // network blockingly (we mustn't serve a stale layout — an admin may have changed it).
  private cachedBootstrapAt = 0;
  // In-flight dedupe for bootstrap. Parallel `bootstrap()` calls (e.g. mounting
  // two widgets at once) get the same promise — a single network request. The
  // stale-while-revalidate branch also writes a background promise here so that
  // commits don't cross.
  private inflightBootstrap: Promise<PaywallBootstrap> | null = null;
  private bootstrapListeners = new Set<(b: PaywallBootstrap) => void>();
  // Unsubscribe from storage.watch — another tab / popup / service-worker may
  // have updated the bootstrap; via watch we get onChanged without a network
  // request. null = the adapter doesn't support watch (memory).
  private bootstrapStorageUnwatch: (() => void) | null = null;
  private authUnsubscribe: (() => void) | null = null;

  // user cache: in-memory with TTL + in-flight dedupe + persistent fallback.
  private cachedUser: PaywallUser | null = null;
  private cachedUserAt = 0;
  private inflightUser: Promise<PaywallUser> | null = null;
  private userListeners = new Set<UserListener>();

  // Stable visitor_id for analytics. Resolved once on initialization, reused for
  // all track calls. Not bound to identity.
  private visitorIdPromise: Promise<string> | null = null;
  private visitorId: string | null = null;

  // In-flight createCheckout dedupe — Stage 1 of protection against duplicate
  // purchases. Parallel clicks on the CTA (a double-click, two tabs on the same
  // page) get the same promise and the same server-side checkout URL instead of
  // two requests to /start-checkout. The key is either the passed idempotencyKey,
  // or `auto:${priceId}` (one inflight per price for auto-generated keys).
  private inflightCheckouts = new Map<string, Promise<CheckoutResult>>();

  // balances cache: symmetric to the user cache. ApiGatewayClient decrements
  // optimistically via decrementBalanceLocal(); an explicit getBalances({force:true})
  // hits /balances and updates state. Listeners receive a snapshot after every
  // real change (we don't compare with Object.is — the arrays differ).
  private cachedBalances: Balance[] | null = null;
  private cachedBalancesAt = 0;
  // Unsubscribe from storage.watch for balances. The key is identity-bound; on
  // setIdentity we unsubscribe and re-subscribe under the new identityKey.
  private balancesStorageUnwatch: (() => void) | null = null;
  private inflightBalances: Promise<Balance[]> | null = null;
  private balanceListeners = new Set<BalancesListener>();

  // Preview/editor mode: see BillingClientOptions.preview. Fixed in the
  // constructor; runtime switching is not provided — preview/production are
  // different lifecycles of the client.
  private readonly previewMode: boolean;
  // Monotonic counter for generating a synthetic version in setBootstrap. A real
  // server-version looks like "<paywall_id>:<hash>"; here we put "preview:<n>"
  // so that applyBootstrap is guaranteed to see a version change and trigger the
  // listeners (PaywallRoot re-renders on every setBootstrap).
  private previewVersionCounter = 0;

  constructor(opts: BillingClientOptions) {
    if (!opts.paywallId) {
      throw new PaywallError('invalid_config', 'paywallId is required');
    }

    if (!opts.apiOrigin) {
      throw new PaywallError(
        'invalid_config',
        'apiOrigin is required. Pass the paywall custom_domain configured in the platform (e.g. "https://pay.your-domain.com"). The legacy "appbox.space" fallback is not used in SDK 3.0.'
      );
    }

    this.paywallId = opts.paywallId;
    this.apiOrigin = opts.apiOrigin;
    this.capabilities = opts.capabilities;
    this.auth = opts.auth;
    this.previewMode = opts.preview === true;
    // If auth is passed — we take the initial identity from the cached user (if
    // it managed to hydrate in the AuthClient constructor — usually not, so
    // below we subscribe to onAuthChange and update as soon as the session
    // resolves). An explicitly set opts.identity wins only until the first auth
    // event — after login/logout this field is overwritten.
    const authUser = opts.auth?.getCachedUser();
    this.identity = opts.identity ?? (authUser ? authUserToIdentity(authUser) : undefined);
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch;
    // Security: the private server-SDK key must NEVER reach the browser. The
    // detection heuristic is the presence of `window.document` (not perfect, but
    // it catches ordinary web/extension cases; in Node/Deno/Bun we fall back to
    // `typeof window === 'undefined'`). By default we throw on the very first
    // line of `new BillingClient(...)` — a naive integrator won't assemble a
    // working client with a key and won't notice. A deliberate non-standard
    // scenario (e2e with an injected key) lifts the block via the
    // allowInsecureBrowserUsage flag — then only a loud console.error for Sentry / logs.
    if (
      opts.apiKey &&
      typeof window !== 'undefined' &&
      typeof (window as { document?: unknown }).document !== 'undefined'
    ) {
      if (!opts.allowInsecureBrowserUsage) {
        throw new PaywallError(
          'apikey_in_browser',
          'BillingClient.apiKey detected in browser context. This is a server-SDK ' +
            'key and exposes your entire account. Move BillingClient to a trusted ' +
            'backend, or pass allowInsecureBrowserUsage:true if this is intentional ' +
            '(e2e tests).'
        );
      }
      console.error(
        '[paywall] SECURITY: BillingClient.apiKey detected in browser context ' +
          '(allowInsecureBrowserUsage). This is a server-SDK key and exposes your ' +
          'account. Never ship this to production.'
      );
    }
    this.storage = createStorage(opts.storage);
    this.api = new ApiClient({
      apiOrigin: this.apiOrigin,
      paywallId: opts.paywallId,
      capabilities: opts.capabilities,
      fetch: opts.fetch,
      // Bearer is passed on every request. AuthClient.getAccessToken does a lazy
      // refresh, dedupes, and on 401 returns null — then the Authorization
      // header simply isn't set.
      getAuthToken: opts.auth ? () => opts.auth!.getAccessToken() : undefined
    });

    if (opts.auth) {
      // BillingClient syncs identity on any session change (including
      // INITIAL_SESSION — otherwise after a reload, until the first real event,
      // identity wouldn't be set). The sameIdentity guard below suppresses no-ops
      // for events like TOKEN_REFRESHED where user.id didn't change.
      this.authUnsubscribe = opts.auth.onAuthChange((_event, session) => {
        const next = session ? authUserToIdentity(session.user) : undefined;
        if (sameIdentity(this.identity, next)) return;
        this.setIdentity(next);
      });
    }

    // Seed from persistent storage — so the first getUser() can return the
    // last-known value instantly (offline fallback). Don't block the constructor.
    void this.hydrateUserFromStorage();

    // Same for the bootstrap: hydrate + subscribe to cross-context changes. If a
    // popup already fetched a fresh bootstrap, the content-script picks it up via
    // storage.watch without its own network request.
    void this.hydrateBootstrapFromStorage();
    this.subscribeBootstrapStorage();

    // Balances: identity-bound persist. On init the key = identity at constructor
    // time; setIdentity unsubscribes and re-subscribes under the new one.
    void this.hydrateBalancesFromStorage();
    this.subscribeBalancesStorage();

    // Resolve visitor_id ahead of time so EventTracker can take a sync reference
    // (this.visitorId) almost immediately after the first microtask.
    this.visitorIdPromise = ensureVisitorId(this.storage).then((id) => {
      this.visitorId = id;
      return id;
    });
  }

  /**
   * Stable visitor_id (UUID v4). The first call awaits the initial resolve from
   * storage; subsequent ones — instantly from the in-memory cache. Used by
   * EventTracker for analytics attribution.
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

  /** Sync access to visitor_id. null if not resolved yet (the first ms of life). */
  getCachedVisitorId(): string | null {
    return this.visitorId;
  }

  setIdentity(identity: Identity | undefined): void {
    this.identity = identity;
    // We do NOT reset the bootstrap: structure (layout/prices/offers/locales)
    // doesn't depend on identity, we reuse the persisted shape. user is updated
    // separately via getUser({force:true}) below + the next bootstrap revalidate
    // pulls in a fresh user in one round-trip if needed. user is bound to
    // identity — switching clears it, otherwise one user would see another's
    // subscription after re-login.
    this.cachedUser = null;
    this.cachedUserAt = 0;
    this.inflightUser = null;
    // Balances are bound to the Bearer user (see the /balances route — it uses
    // the Auth user, not identity.email). On re-login/signout we clear them;
    // below we explicitly emit EMPTY shapes, otherwise listeners won't learn of
    // the identity change (applyUser/applyBalances are the only emit points).
    this.cachedBalances = null;
    this.cachedBalancesAt = 0;
    this.inflightBalances = null;
    // The balances storage key is identity-bound — we unsubscribe from the old
    // key and re-subscribe under the new identityKey. Hydrate picks up the new
    // user's persisted balances (if they opened the extension before).
    if (this.balancesStorageUnwatch) {
      this.balancesStorageUnwatch();
      this.balancesStorageUnwatch = null;
    }
    void this.hydrateBalancesFromStorage();
    this.subscribeBalancesStorage();
    void this.hydrateUserFromStorage();
    if (identity) {
      // Auto-refetch the user in the background for the new identity. Without
      // this, UIs subscribed to onUserChange (account widgets, status pops) would
      // have to call getUser manually after every signin — and they usually don't
      // know a signin happened. With the refetch, onUserChange broadcasts the
      // fresh has_active_subscription automatically. The promise swallows errors —
      // getUser itself updates cachedUser to EMPTY_USER on a network failure, and
      // listeners get the rollback snapshot.
      void this.getUser({ force: true }).catch(() => {
        /* network failure — listeners get EMPTY_USER via applyUser */
      });
    } else {
      // Signout: identity is cleared, a network /user-state without Bearer won't
      // return anything useful (the backend answers empty-state). We emit EMPTY
      // shapes synchronously so that listeners (account widgets, usePaywallUser,
      // RemoteBillingClient via broadcast) switch to guest-state. The
      // Hydrate*FromStorage calls above are skipped via the truthy guard on cached*.
      this.applyUser(EMPTY_USER);
      this.applyBalances([]);
    }
  }

  /**
   * Unsubscribe from auth events and clear listeners. Call when BillingClient is
   * no longer needed (tests, hot-reload, re-initialization). Without destroy()
   * the listener on AuthClient outlives BillingClient and keeps calling
   * setIdentity on a released instance. The user/balance listeners are cleared so
   * that a torn-down host (e.g. an unmounted React tree) doesn't hold closures
   * over these callbacks.
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
    // The old signature `bootstrap(force: boolean)` is kept for compatibility
    // with already-written host code; the new one is `bootstrap({force?, signal?})`.
    const opts =
      typeof forceOrOpts === 'boolean' ? { force: forceOrOpts } : forceOrOpts;

    // Preview mode: the network is disabled. The caller had to seed
    // cachedBootstrap via setBootstrap() before the first open(). Without a seed
    // we throw an explicit error so the admin editor immediately sees the reason
    // for an empty modal.
    if (this.previewMode) {
      if (this.cachedBootstrap) return this.cachedBootstrap;
      throw new PaywallError(
        'invalid_config',
        'BillingClient in preview mode but cachedBootstrap is not seeded. Call setBootstrap(bootstrap) before open().'
      );
    }

    // Stale-while-revalidate: if the cache is fresh by TTL — we return instantly
    // and fetch a fresh one in the background (with `?if_version=<v>`, so that in
    // 99% of cases the backend answers a short `unchanged: true`). Force bypasses
    // the whole cache and blocks.
    const now = Date.now();
    const cacheFresh =
      this.cachedBootstrap &&
      this.cachedBootstrapAt > 0 &&
      now - this.cachedBootstrapAt < BOOTSTRAP_PERSIST_TTL_MS;

    if (!opts.force && cacheFresh) {
      const shouldRevalidate =
        now - this.cachedBootstrapAt > BOOTSTRAP_STALE_THRESHOLD_MS;
      if (shouldRevalidate) {
        // Background revalidate — we don't block the caller, we swallow errors
        // (the cache is still considered authoritative until the TTL expires).
        void this.revalidateBootstrap(opts.signal).catch(() => {
          /* network/abort — listeners get the fresh value on the next request */
        });
      }
      // Bootstrap.user can be stale: setIdentity cleared cachedUser but does NOT
      // touch cachedBootstrap.user (the structure cache survives re-identity).
      // The fresh user arrives separately via applyUser after a force-getUser. So
      // that the caller (RemoteBillingClient → applyUser in the mirror) doesn't
      // overwrite the fresh user with stale data from the cached bootstrap — we
      // return the bootstrap with user from the current cachedUser. A null
      // cachedUser = "not loaded yet" — we return undefined, then
      // RemoteBillingClient won't call applyUser and will wait for the broadcast.
      return { ...this.cachedBootstrap!, user: this.cachedUser ?? undefined };
    }

    // Parallel mounts (widget + popup) get the same promise. Without dedupe —
    // two network requests with an identical result.
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
   * Subscribe to bootstrap changes: applyBootstrap (network revalidate,
   * cross-context storage.watch). Fires ONLY on a real `version` change (an
   * unchanged response from the server doesn't trigger listeners). Returns an
   * unsubscribe.
   */
  onBootstrapChange(cb: (b: PaywallBootstrap) => void): () => void {
    this.bootstrapListeners.add(cb);
    return () => {
      this.bootstrapListeners.delete(cb);
    };
  }

  /**
   * Replace cachedBootstrap with partial or full data and emit to all
   * subscribers. Used by the host in preview mode (the admin editor) for
   * live-updating the open modal without a network revalidate.
   *
   * Behavior:
   *  - Without `cachedBootstrap`, at least `settings` + `prices` are expected —
   *    otherwise PaywallRoot can't render the plans and will crash.
   *  - With an existing cache, the partial is merged on top: `settings` is a deep
   *    merge one level down (settings fields), the `prices`/`offers` arrays are overwritten.
   *  - Every call bumps `version` ("preview:<n>") so that applyBootstrap's
   *    `versionChanged` check always fires and listeners are triggered.
   *  - We do NOT persist to storage — preview must not leak into other tabs.
   *
   * In non-preview mode the method is available, but it's a rare path (e.g. for
   * host tests) — production code should rely on bootstrap() + revalidate.
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

  // Network primitive — a single point for the force request, the revalidate,
  // and the first cold bootstrap. `ifVersion` sends a server-side short-circuit:
  // if it matches — the backend answers `{unchanged: true, version, user}` and we
  // only update the cached user, leaving structure (layout/prices/offers/locales) untouched.
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
      // Server-side confirmed the structure hasn't changed. Cached stays, we
      // update only user. If cached is somehow null (a race at startup) —
      // fallback: repeat the request without if_version to get the full payload.
      if (!this.cachedBootstrap) {
        return this.fetchBootstrap({ signal: opts.signal });
      }
      // Refresh the TTL — an unchanged response also went over the network, the cache is still valid.
      this.cachedBootstrapAt = Date.now();
      if (resp.user) this.applyUser(resp.user);
      return this.cachedBootstrap;
    }

    const bootstrap = resp as PaywallBootstrap;
    // Self-check: compare the custom_domain bound to paywall_id in the platform
    // against the apiOrigin the SDK was initialized with. A mismatch almost
    // always means an integrator typo (entered the wrong domain) — without an
    // explicit error the user would see an empty paywall / broken checkout with
    // no explanation. We compare normalized origins; an empty custom_domain
    // (legacy v2 paywall) — skip.
    assertApiOriginMatchesCustomDomain(bootstrap.settings.custom_domain, this.apiOrigin);
    if (!bootstrap.layout) {
      bootstrap.layout = buildDefaultLayout(bootstrap.settings, bootstrap.prices);
    }
    applyLocaleOverrides(bootstrap);

    this.applyBootstrap(bootstrap, { persist: true });
    if (bootstrap.user) this.applyUser(bootstrap.user);

    return bootstrap;
  }

  // Background revalidate from the stale-while-revalidate branch. Deduplicated
  // via `inflightBootstrap` so that parallel revalidates don't cross.
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

  // Applies a fresh bootstrap to state: emit listeners ONLY on a version change
  // (i.e. the structure is really different). This is needed so a repeated
  // applyBootstrap from storage.watch doesn't redraw the UI for nothing if
  // another tab found the same version. persist=false for the "got it from
  // storage" path — there someone else already wrote it.
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
      // Race protection: if during the `await` someone managed to store a fresh
      // bootstrap (a concurrent background fetch) — don't overwrite.
      if (this.cachedBootstrap) return;
      // Locales may not be applied in the persisted shape — we guarantee
      // consistency by reapplying them. applyLocaleOverrides is idempotent.
      applyLocaleOverrides(parsed.bootstrap);
      this.cachedBootstrap = parsed.bootstrap;
      this.cachedBootstrapAt = parsed.at;
      // emit to listeners — hosts may subscribe synchronously in the constructor
      // and wait for the first snapshot. user from persisted — may be very old,
      // we don't apply it (a fresh one will come via the network request / hydrateUser).
      for (const cb of this.bootstrapListeners) {
        try {
          cb(parsed.bootstrap);
        } catch (e) {
          console.warn('[paywall] onBootstrapChange listener threw', e);
        }
      }
    } catch {
      /* corrupted entry — ignore */
    }
  }

  private async persistBootstrap(bootstrap: PaywallBootstrap): Promise<void> {
    // We don't persist a bootstrap without version — the old backend doesn't
    // return it, and without version there's no point in revalidation (we'd
    // always have to pull the full payload).
    if (!bootstrap.version) return;
    try {
      // We don't write user into persisted — it lives under its own userState
      // key with its own TTL/identity mapping.
      const { user: _user, ...rest } = bootstrap;
      await this.storage.setItem(
        STORAGE_KEYS.bootstrap(this.paywallId),
        JSON.stringify({ at: Date.now(), bootstrap: rest })
      );
    } catch {
      /* quota / disabled */
    }
  }

  // Cross-context sync: another tab / popup / sw wrote a fresh bootstrap → we
  // pick it up without a network request. Adapters without watch (memory) — a
  // no-op, everything works as before via the network.
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
          // If it's the same version — no point overwriting (we avoid extra
          // listener calls from applyBootstrap).
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

  /** Returns the last loaded bootstrap without a network request.
   *  null = the bootstrap hasn't been loaded yet. Handy for post-checkout logic
   *  (PaywallUI reads success_redirect_url without doing a second round-trip). */
  getCachedBootstrap(): PaywallBootstrap | null {
    return this.cachedBootstrap;
  }

  /**
   * A shortcut over `bootstrap()`: waits for the paywall structure to load and
   * returns the prices. Useful when the host renders prices outside the modal
   * (cards on a landing page, a "Pricing" page, etc.) and doesn't want to unpack
   * the bootstrap by hand.
   *
   * Locale overrides (`label`/`description` under `navigator.language`) are
   * already applied — the array is ready to render. Cache/TTL/stale-while-revalidate
   * are the same as `bootstrap()`: a repeat call doesn't storm the server.
   */
  async getPrices(
    opts: { force?: boolean; signal?: AbortSignal } = {}
  ): Promise<PaywallPrice[]> {
    const b = await this.bootstrap(opts);
    return b.prices;
  }

  /** Sync snapshot of prices from the last bootstrap. null = not loaded yet. */
  getCachedPrices(): PaywallPrice[] | null {
    return this.cachedBootstrap?.prices ?? null;
  }

  /** Sync snapshot of offers from the last bootstrap. null = the bootstrap
   *  hasn't been loaded yet, an empty array = the backend returned a paywall with
   *  no offers. The backend has already applied server-side targeting
   *  (target_countries / target_emails / targeting_mode from offer_settings) —
   *  only what's applicable to the current user comes out. The client side
   *  remains responsible for price_id matching and the countdown
   *  (see core/offer.ts → resolveOffer). */
  getCachedOffers(): PaywallOffer[] | null {
    return this.cachedBootstrap?.offers ?? null;
  }

  /**
   * A snapshot of what language the SDK currently considers the "user's
   * language". Useful for syncing the host's i18n with what the paywall actually
   * shows — so the surrounding UI doesn't contradict the modal (e.g. the host
   * renders a "Subscribe" button in English while the paywall shows «Подписаться» in Russian).
   *
   * Returns a structure rather than a single tag, so the integrator can:
   *  - quickly take `tag` for their own translations;
   *  - distinguish "the paywall is really in this language" (`applied !== null`)
   *    from "the SDK guessed, but there's no locale for this language — the base is rendered";
   *  - decide what to trust when browserLanguage vs countryLanguage conflict
   *    (a trip, an expat, a VPN — each has its own answer).
   *
   * Sync call: the data is already in the bootstrap, no separate requests are
   * made. If `bootstrap()` hasn't been called yet — `applied` and
   * `countryLanguage` will be `null`, but `browserLanguage` and `tag` are still
   * returned if `navigator.language` is present.
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
   * Get the current subscription/purchases state.
   *
   * - In-memory cache TTL 5s — a naïve setInterval(1000) doesn't load the server.
   * - In-flight dedupe — parallel calls get a single promise.
   * - `force: true` bypasses the cache (for a post-checkout check).
   * - Without identity it returns empty-state (the server does the same).
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
   * Subscribe to user-state changes. The callback is invoked:
   * - immediately with the last-known user (if present in the cache) — by default
   *   via a microtask, optionally SYNC (see options);
   * - on every real change (getUser/bootstrap brought a different shape).
   *
   * `opts.immediate`:
   *   - `'microtask'` (default) — the initial snapshot is delivered in
   *     queueMicrotask, so the host can finish resetting state in the same tick.
   *     The safe choice for most integrations.
   *   - `'sync'` — the initial snapshot is delivered right in the current frame,
   *     before onUserChange returns. Convenient for React/Vue useEffect cleanup
   *     (avoids an extra re-render) and SSR (instant synchronization).
   *   - `'none'` — don't deliver an initial snapshot, only real changes.
   *
   * Returns the unsubscribe function.
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

  /** The current cached user without a network request. null = not loaded yet. */
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
      // Only if no one managed to store a fresh one in the meantime — otherwise
      // we'd overwrite more current data.
      if (this.cachedUser) return;
      this.applyUser(parsed.user);
    } catch {
      /* corrupted entry — ignore, we'll fetch a fresh one over the network */
    }
  }

  private async persistUser(user: PaywallUser): Promise<void> {
    try {
      await this.storage.setItem(
        this.storageKey(),
        JSON.stringify({ at: Date.now(), user })
      );
    } catch {
      /* quota / disabled — not critical */
    }
  }

  /**
   * AI provider balances (`paywall_balances` × `tokenization_queries`).
   *
   * - In-memory cache TTL 5s — parallel UI renders don't hit the network;
   * - In-flight dedupe — parallel `getBalances` calls get a single promise;
   * - `force: true` bypasses the cache (the typical case — after QuotaExceededError);
   * - Without auth (Bearer not issued) it returns an empty array without a
   *   network request: the backend would answer 401 anyway, no point spending a round-trip.
   *
   * If the paywall has `tokenization=false` — the backend returns `[]`, as for a
   * guest. The SDK doesn't distinguish "no quota" from "no quotas at all" — the
   * caller decides via `currentBalance` in QuotaExceededError or `balances.length`.
   */
  async getBalances(
    { force = false, signal }: { force?: boolean; signal?: AbortSignal } = {}
  ): Promise<Balance[]> {
    const now = Date.now();
    const age = this.cachedBalances ? now - this.cachedBalancesAt : Infinity;

    // Stable path: the cache is fresh (in-memory 5s or persisted younger than
    // BALANCES_STALE_THRESHOLD_MS). Return without a network request.
    if (
      !force &&
      this.cachedBalances &&
      (age < BALANCES_CACHE_TTL_MS || age < BALANCES_STALE_THRESHOLD_MS)
    ) {
      return this.cachedBalances;
    }

    // Stale-while-revalidate: there's a cache, but the age is between
    // STALE_THRESHOLD and PERSIST_TTL. We return the cache instantly and update
    // in the background — listeners get the fresh value via storage.watch +
    // applyBalances. Force skips this branch — the caller waits for the fresh value.
    if (
      !force &&
      this.cachedBalances &&
      age < BALANCES_PERSIST_TTL_MS
    ) {
      void this.fetchBalances({ signal }).catch(() => {
        /* swallow — fall back to cached, an explicit force gives the next attempt */
      });
      return this.cachedBalances;
    }

    // Cache is absent or expired (>PERSIST_TTL) — a blocking request.
    if (this.inflightBalances) return this.inflightBalances;
    return this.fetchBalances({ signal });
  }

  // Network primitive — a single point for force/stale-revalidate/cold-start.
  // Deduplicated via `inflightBalances`.
  private fetchBalances({ signal }: { signal?: AbortSignal } = {}): Promise<Balance[]> {
    if (this.inflightBalances) return this.inflightBalances;
    this.inflightBalances = (async () => {
      try {
        // /balances requires Bearer. Without auth — an empty array, we don't
        // trigger listeners (this is the "not loaded" shape, not "changed").
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

  /** Sync snapshot. null = not loaded yet (or an explicit clear on re-login). */
  getCachedBalances(): Balance[] | null {
    return this.cachedBalances;
  }

  /**
   * Subscribe to balance changes: getBalances/decrementBalanceLocal/setIdentity.
   * `opts.immediate` works the same as in `onUserChange`: 'microtask' (default),
   * 'sync' (for React/Vue useEffect), 'none' (changes only). Returns an unsubscribe.
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
   * Optimistically decrements the count for `queryType` by 1 and notifies
   * listeners. Used by ApiGatewayClient right after a successful gateway call
   * (the backend has already taken the credit, see `chargeApiQueries`).
   *
   * If queryType is missing from the cache or count<=0 — a no-op (we don't go
   * into negative values, the backend is the correct source-of-truth anyway). If
   * there's no cache at all — also a no-op: an explicit getBalances({force:true})
   * on the next render pulls in the current shape.
   *
   * queryType may be undefined (the gateway didn't send X-Query-Type) — in that
   * case we don't decrement but request refreshBalances() to realign.
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

  /** A forced re-fetch — the typical call after QuotaExceededError, so the UI
   *  gets the current balance=0 and renders an upgrade prompt. */
  refreshBalances(): Promise<Balance[]> {
    return this.getBalances({ force: true });
  }

  /**
   * Factory for an ApiGatewayClient wired to this billing's balance state:
   *  - Bearer/identity are taken from the current auth/identity;
   *  - on success we decrement cachedBalances optimistically;
   *  - on 402 (QuotaExceededError) we trigger refreshBalances() for the current snapshot.
   *
   * If you override options via `overrides` — they're taken as-is, but
   * `onChargeSuccess`/`onQuotaExceeded` are still called (composable, the host
   * can add its own callback on top).
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
    // Persist even if !changed — we update `at` so other contexts consider the
    // cache fresh (otherwise they'd go to the network for nothing after 30s).
    // persist=false for the "arrived via storage.watch" path — someone already wrote it there.
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
      // Race protection: if during the `await` a fresh value already arrived from
      // the network — don't overwrite.
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
      /* corrupted entry — ignore */
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

  // Cross-context sync: another tab / popup / SW updated balances (a fresh
  // getBalances or an optimistic decrement) → we pick it up without a network request.
  private subscribeBalancesStorage(): void {
    if (typeof this.storage.watch !== 'function') return;
    this.balancesStorageUnwatch = this.storage.watch(
      this.balancesStorageKey(),
      (raw) => {
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as { at: number; balances: Balance[] } | null;
          if (!parsed?.balances || !Array.isArray(parsed.balances)) return;
          // If cached is younger or of the same epoch — ours is fresher.
          // Otherwise applyBalances without re-persisting (the writer already wrote it).
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
    /** The active offer for this price — resolved by the host via
     *  `paywall.getOfferForPrice(priceId)?.offer.id` or
     *  `findApplicableOffer(client.getCachedOffers(), priceId)?.id`. Without
     *  passing it explicitly the backend will auto-resolve by email — but only
     *  for end_date offers. duration_minutes offers tick in clientStorage and the
     *  server doesn't see them: for them offerId MUST come from the client,
     *  otherwise the discount won't apply at checkout even though the UI showed it.
     *
     *  Passing offer-id is always safe — the backend itself checks whether the
     *  offer is applicable to this user (country/email/mode) and ignores it if not. */
    offerId?: string;
    /**
     * Stage 1 of protection against duplicate purchases. An idempotent request
     * key (UUID). A repeat call with the same key returns the same checkout URL
     * without a second hit to the payment provider. If not passed — the SDK
     * generates a UUID v4 itself and deduplicates parallel clicks via `auto:${priceId}`.
     */
    idempotencyKey?: string;
    /** Renewal/upgrade flow — makes the backend skip the has_active_subscription
     *  check. By default /start-checkout returns 409 if the user already has an
     *  active subscription (protection against accidental double payments). With
     *  `ignoreActivePurchase: true` the backend creates a new checkout, and the
     *  previous subscription is canceled after a successful payment. Pass only
     *  when the user explicitly chose "Renew/Upgrade" in the host UI. */
    ignoreActivePurchase?: boolean;
    /** Cancellation of the inflight request. Parallel calls are deduplicated by
     *  `inflightKey`, so the signal cancels ALL waiters on that key — this is OK
     *  for the typical UX (the user closed the modal — all checkouts are canceled). */
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

    // The backend contract is camelCase (online/app/api/v1/paywall/[id]/start-checkout/route.ts):
    // { email, priceId, successUrl, errorUrl, shopUrl, trial_days, userMeta, localCurrency }.
    // Response: { checkoutUrl, userId, acquiring } — we map it to the SDK shape { url, sessionId }.
    const headers: Record<string, string> = {
      'Idempotency-Key': idempotencyKey
    };
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;

    // Settings from the bootstrap — a fallback for shopUrl/successUrl. The caller
    // can still override them with an explicit argument (a host app with its own UX).
    const settings = this.cachedBootstrap?.settings;
    const successUrl = params.successUrl ?? settings?.success_redirect_url ?? undefined;
    const shopUrl = params.shopUrl ?? settings?.checkout_shop_url ?? undefined;

    // Resolve the local currency from the cached prices. The backend
    // (checkout-with-acquiring) picks the localized price from
    // paywall_internal_local_prices by this currency. Without passing it
    // explicitly the backend falls back to the base currency (USD), and a user
    // who was shown £9.99 on the paywall sees $9.99 on Stripe — a literal
    // UI/checkout mismatch. The canonical source is `price.local.currency` from
    // the bootstrap (where the backend resolves by geolocation/settings).
    const cachedPrice = this.cachedBootstrap?.prices.find(
      (p) => p.id === params.priceId
    );
    const localCurrency = cachedPrice?.local?.currency ?? undefined;

    const promise = this.api
      .request<{
        checkoutUrl: string;
        userId: string;
        // Backend contract: the name of the acquirer the checkout went to. The
        // SDK doesn't branch on acquiring itself (the URL opens with the same
        // window.open), but passes it through to CheckoutResult and to the
        // `checkout_started` event — so the host and /events analytics can build
        // conversion by acquirer.
        acquiring: Acquiring;
      }>(`/api/v1/paywall/${this.paywallId}/start-checkout`, {
        method: 'POST',
        headers,
        signal: params.signal,
        body: JSON.stringify({
          email: this.identity.email,
          priceId: Number(params.priceId),
          offerId: params.offerId,
          successUrl,
          errorUrl: params.errorUrl,
          shopUrl,
          productName: settings?.checkout_product_name ?? undefined,
          trial_days: params.trialDays,
          ignoreActivePurchase: params.ignoreActivePurchase ? true : undefined,
          userMeta: this.identity.userId ? { userId: this.identity.userId } : undefined,
          localCurrency
        })
      })
      .then((resp): CheckoutResult => ({ url: resp.checkoutUrl, acquiring: resp.acquiring }))
      .catch((err): never => {
        // The backend returns 409 + `{ hasActivePurchase: true }` when the user
        // already has an active subscription. This isn't a checkout error — it's
        // a signal to "show success/restored". We normalize it into a separate
        // code so PaywallRoot can switch to the purchase_success view without an
        // endpoint-specific status+payload check.
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
    // We clean up after completion so that the next click after completion gets
    // a new key and a new request. Parallel retries during the request are still
    // honestly deduplicated onto the same promise. .catch(() => {}) — the
    // finalizer must not turn the promise's reject into an unhandled rejection;
    // the createCheckout caller still receives the original reject via `return promise`.
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
   * The URL of the Stripe/Paddle/Chargebee customer portal — the place where a
   * logged-in user can manage their subscription (cancel, update card, download
   * invoices). The open flow is controlled by the host:
   *
   * ```ts
   * const { url } = await billing.getCustomerPortalUrl({
   *   returnUrl: 'https://your-app.com/account'
   * });
   * window.open(url, '_blank');
   * ```
   *
   * Auth: Bearer (via AuthClient) or server-side `apiKey`. Without auth and
   * without apiKey it throws PaywallError('identity_required'). A 403 from the
   * backend (no active subscription / acquiring doesn't support a portal) is
   * passed through as PaywallError('forbidden') with `status: 403` — the host
   * renders "no subscription to manage".
   */
  async getCustomerPortalUrl(
    opts: {
      signal?: AbortSignal;
      /** The URL for the provider's return button (Stripe "Return to ...", Paddle
       *  and Chargebee redirect_urls). Pass your app's account page there —
       *  `https://your-app.com/account`. Without an explicit returnUrl the backend
       *  applies a fallback in the order: `paywall_settings.shop_url` → the
       *  paywall's custom_domain → NEXT_PUBLIC_ONLINE_ORIGIN (the last is a page
       *  in the online service itself, suitable only for the legacy v2-iframe flow). */
      returnUrl?: string;
    } = {}
  ): Promise<{ url: string }> {
    if (!this.auth && !this.apiKey && !this.identity?.email) {
      throw new PaywallError(
        'identity_required',
        'getCustomerPortalUrl requires auth, apiKey, or identity.email'
      );
    }
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;
    // Without Bearer — the legacy path: email/userMeta in the body. With Bearer —
    // the backend extracts email itself via GoTrue, the body can be sent without
    // identity fields. We pass returnUrl in both modes — the host-controlled
    // override isn't tied to the auth mode.
    const body =
      this.auth && this.auth.getCachedSession()
        ? { returnUrl: opts.returnUrl }
        : {
            email: this.identity?.email,
            userMeta: this.identity?.userId
              ? { userId: this.identity.userId }
              : undefined,
            returnUrl: opts.returnUrl
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
   * The list of the user's purchases with rich fields (price, currency,
   * interval, discount, cancel metadata). Suitable for a customer-portal UI:
   * cards with Cancel/Renew/Manage buttons. Less cache-friendly than `getUser` —
   * it hits `/api/v1/paywall/[id]/user` without unstable_cache, because the list
   * for the UI must be fresh after a cancel.
   *
   * Auth (two paths):
   *  - Bearer (via AuthClient) — user.id is resolved from the session, identity
   *    in the query is ignored.
   *  - `apiKey` + `identity.email`/`identity.userId` — the server-SDK path for
   *    integrations with their own authorization. The backend checks that the
   *    identity is linked to this paywall (protection against a cross-paywall lookup).
   * Without auth and without apiKey+identity — `identity_required`.
   */
  async listPurchases(
    opts: { signal?: AbortSignal } = {}
  ): Promise<PaywallPurchaseDetailed[]> {
    const hasIdentity = !!(this.identity?.email || this.identity?.userId);
    if (!this.auth && !(this.apiKey && hasIdentity)) {
      throw new PaywallError(
        'identity_required',
        'listPurchases requires AuthClient (Bearer) or apiKey + identity.email/userId'
      );
    }
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;

    // identity in the query — only on the apiKey path, where the backend expects
    // it. With Bearer, identity is taken from the session and isn't needed in the query.
    const search = new URLSearchParams();
    if (this.apiKey && this.identity?.email) {
      search.set('email', this.identity.email);
    }
    if (this.apiKey && this.identity?.userId) {
      search.set('user_id', this.identity.userId);
    }
    const qs = search.toString();
    const path = qs
      ? `/api/v1/paywall/${this.paywallId}/user?${qs}`
      : `/api/v1/paywall/${this.paywallId}/user`;

    const resp = await this.api.request<{
      purchases: PaywallPurchaseDetailed[];
    }>(path, {
      method: 'GET',
      headers,
      signal: opts.signal
    });
    return resp.purchases ?? [];
  }

  /**
   * Credit tokens to a user's tokenized balance (server-SDK only).
   *
   * Adds `amount` tokens of `type` to the user's balance for this paywall
   * (creates the type if absent) and returns the new count. Server-side ONLY:
   * requires `apiKey` + identity (email/userId). Token grants must never be
   * callable from the browser — a user could top up their own balance — so this
   * throws `apikey_required` without an apiKey (and the constructor already
   * forbids apiKey in a browser context).
   *
   * The backend mutation is atomic (no lost updates vs concurrent api-gateway
   * debits), and a credit above the daily-trial limit is NOT clawed back by the
   * daily trial top-up (it only tops balances UP to the limit, never down).
   */
  async creditTokens(params: {
    type: string;
    amount: number;
    signal?: AbortSignal;
  }): Promise<{ type: string; count: number }> {
    return this.adjustTokens('credit', params);
  }

  /**
   * Debit tokens from a user's tokenized balance (server-SDK only). Subtracts
   * `amount` of `type` and returns the new count. Throws
   * `PaywallError('insufficient')` if the balance would drop below zero — no
   * partial debit. Same server-only constraints as {@link creditTokens}.
   */
  async debitTokens(params: {
    type: string;
    amount: number;
    signal?: AbortSignal;
  }): Promise<{ type: string; count: number }> {
    return this.adjustTokens('debit', params);
  }

  private async adjustTokens(
    op: 'credit' | 'debit',
    params: { type: string; amount: number; signal?: AbortSignal }
  ): Promise<{ type: string; count: number }> {
    if (!this.apiKey) {
      throw new PaywallError(
        'apikey_required',
        'creditTokens/debitTokens are server-SDK only — set apiKey + identity. Token balance changes must not be callable from the browser.'
      );
    }
    if (!this.identity?.email && !this.identity?.userId) {
      throw new PaywallError(
        'identity_required',
        'creditTokens/debitTokens require identity.email or identity.userId'
      );
    }
    if (!params.type || !Number.isInteger(params.amount) || params.amount <= 0) {
      throw new PaywallError(
        'invalid_argument',
        'type is required and amount must be a positive integer'
      );
    }

    const resp = await this.api.request<{
      success: true;
      user_id: string;
      type: string;
      count: number;
      balances?: Balance[];
    }>(`/api/v1/paywall/${this.paywallId}/balances`, {
      method: 'POST',
      headers: { 'X-Api-Key': this.apiKey },
      body: JSON.stringify({
        email: this.identity?.email,
        user_id: this.identity?.userId,
        type: params.type,
        amount: params.amount,
        op
      }),
      signal: params.signal
    });
    return { type: resp.type, count: resp.count };
  }

  /**
   * Cancel a subscription. The backend checks that the subscription belongs to
   * the user (Bearer path — from the session; apiKey path — from identity) and
   * cancels it at the acquirer (Stripe/Paddle/Chargebee/Overpay). By default the
   * cancel happens at the end of the current period — the user keeps access until
   * the renewal date.
   *
   * `reason` is required (validated on the backend).
   *
   * Auth (two paths):
   *  - Bearer (via AuthClient) — the standard path for a customer-portal UI.
   *  - `apiKey` + `identity.email`/`identity.userId` — for a self-service UI on
   *    the client's backend with its own authorization. The backend additionally
   *    filters the subscription by paywall_id so that the owner of paywall A
   *    can't cancel a subscription of paywall B.
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
    const hasIdentity = !!(this.identity?.email || this.identity?.userId);
    if (!this.auth && !(this.apiKey && hasIdentity)) {
      throw new PaywallError(
        'identity_required',
        'cancelSubscription requires AuthClient (Bearer) or apiKey + identity.email/userId'
      );
    }
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;

    const body: Record<string, unknown> = {
      subscriptionId: params.subscriptionId,
      paywallId: this.paywallId,
      cancellationReason: params.reason
    };
    if (this.apiKey && this.identity?.email) body.email = this.identity.email;
    if (this.apiKey && this.identity?.userId) body.userId = this.identity.userId;

    return this.api.request<{
      subscription: {
        status: string | null;
        canceled_at: string | null;
        cancel_at: string | null;
        cancel_at_period_end: boolean | null;
      };
    }>(`/api/paywall/cancel-subscription`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: params.signal
    });
  }

  /**
   * Creates a support ticket. If `files` are present — multipart/form-data,
   * otherwise JSON. Email is taken (1) from the explicit payload.email field;
   * (2) from identity if present. If neither exists — the backend rejects the
   * ticket (`email_required`).
   *
   * The Bearer token (if an AuthClient is wired up) is added automatically — the
   * backend overrides customer_email with the email from the session (protection
   * against spoofing).
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

// Normalization: `URL(...)`.origin reduces "pay.example.com" / "https://pay.example.com/"
// / "https://pay.example.com:443" to the canonical "https://pay.example.com".
// Without a scheme — we prepend https (the pattern matches the server-side
// `normalizeOrigin` in online/utils/urls.ts so the comparison is symmetric).
// Non-URL → null (defensive — the validation forms in the platform should cut this off in advance).
function normalizeOrigin(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).origin;
  } catch {
    return null;
  }
}

// Check bootstrap.settings.custom_domain ↔ init.apiOrigin. An empty custom_domain
// (a legacy v2 paywall not connected to the new SDK) — skip: it means the
// configuration doesn't imply a strict binding. A mismatch is fatal: the
// integrator passed the wrong origin and all further traffic would bypass the merchant's custom_domain.
function assertApiOriginMatchesCustomDomain(
  customDomain: string | null | undefined,
  apiOrigin: string
): void {
  const expected = normalizeOrigin(customDomain);
  if (!expected) return;
  const actual = normalizeOrigin(apiOrigin);
  if (actual === expected) return;
  throw new PaywallError(
    'invalid_config',
    `apiOrigin mismatch: SDK initialized with "${apiOrigin}" but paywall is configured with custom_domain "${customDomain}". Use the custom_domain from the platform paywall settings.`
  );
}

function buildDefaultLayout(settings: PaywallSettings, prices: PaywallPrice[]): Layout {
  return {
    type: 'modal',
    blocks: [
      // offer_banner is NOT in the default layout — PaywallRoot renders it as a
      // top-tab above the dialog (rounded-top, negative margin), outside the
      // scrollable area. The block stays in the registry for the opt-in inline variant.
      { type: 'heading', text: settings.name || 'Upgrade', level: 1 },
      { type: 'price_grid', priceIds: prices.map((p) => p.id) },
      { type: 'cta_button', action: 'checkout' },
      { type: 'guarantee_badge' },
      { type: 'current_session' }
    ]
  };
}

/** Picks overrides by `navigator.language` (with a fallback to the base tag and
 *  to `settings.locale_default`). Returns the first existing key from the map —
 *  without case normalization: the keys in the bootstrap come from the backend
 *  in a uniform format anyway. */
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
      // We selectively overwrite only the passed fields, leaving the rest as-is.
      // null in overrides — an explicit reset (e.g. hide description in this locale).
      const next: PaywallPrice = { ...p };
      if ('label' in o) next.label = o.label ?? null;
      if ('description' in o) next.description = o.description ?? null;
      return next;
    });
  }
}
