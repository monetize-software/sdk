// RemoteBillingClient — a structural twin of BillingClient that proxies all
// methods to offscreen through TransportClient. The public API is identical
// (the host writes the same code as for @monetize.software/sdk), only the
// implementation differs. Sync getCached* methods stay sync — they read from a
// local mirror that is updated by (a) responses to async methods and (b) the
// userChange/balancesChange broadcast events.

import type {
  Balance,
  CheckoutResult,
  Identity,
  PaywallBootstrap,
  PaywallOffer,
  PaywallPrice,
  PaywallPurchaseDetailed,
  PaywallUser,
  TrialConfig
} from '@sdk/core/types';
import type { StorageAdapter } from '@sdk/core/storage';
import type { TrialStore } from '@sdk/core/trial';
import { TransportClient } from '../shared/transport-client';
import { RemoteTrialStore } from './RemoteTrialStore';

export type UserListener = (user: PaywallUser) => void;
export type BalanceListener = (balances: Balance[]) => void;
export type BootstrapListener = (bootstrap: PaywallBootstrap) => void;

export interface RemoteBillingClientOptions {
  paywallId: string;
  apiOrigin?: string;
}

export class RemoteBillingClient {
  readonly paywallId: string;
  readonly apiOrigin: string | undefined;

  // Local mirrors. The source of truth is offscreen; the mirror exists only so
  // that getCached* methods stay sync. Updated after every async response and
  // on every broadcast event.
  private cachedBootstrap: PaywallBootstrap | null = null;
  private cachedUser: PaywallUser | null = null;
  private cachedBalances: Balance[] | null = null;
  private identity: Identity | null = null;
  /** Storage proxy over transport: get/set/remove go to the offscreen
   *  StorageAdapter (single source of truth for all tabs). PaywallUI writes
   *  trial state here — all tabs see the same counter and it doesn't drift
   *  between them.
   *
   *  A read-modify-write race window still exists (two tabs simultaneously read
   *  N → write N-1, drift of 1). Exact atomicity requires Phase 9: move the
   *  entire TrialStore into offscreen and do recordBlock as a single handler
   *  with one atomic operation. This is a rare edge case (opening the paywall
   *  in multiple tabs within milliseconds). */
  private remoteStorageAdapter: StorageAdapter;

  private userListeners = new Set<UserListener>();
  private balanceListeners = new Set<BalanceListener>();
  private bootstrapListeners = new Set<BootstrapListener>();
  private unsubUserBroadcast: (() => void) | null = null;
  private unsubBalancesBroadcast: (() => void) | null = null;

  constructor(
    private readonly transport: TransportClient,
    opts: RemoteBillingClientOptions
  ) {
    this.paywallId = opts.paywallId;
    this.apiOrigin = opts.apiOrigin;

    this.remoteStorageAdapter = {
      getItem: (key) => this.transport.request('storage.get', { key }),
      setItem: async (key, value) => {
        await this.transport.request('storage.set', { key, value });
      },
      removeItem: async (key) => {
        await this.transport.request('storage.remove', { key });
      }
      // We don't implement watch — for cross-context notifications consumers
      // (AuthClient, TrialStore) subscribe to broadcast events directly through
      // transport. If it's ever needed, we'll add a storage.watch broadcast.
    };

    this.unsubUserBroadcast = this.transport.on('userChange', (user) => {
      this.applyUser(user);
    });

    this.unsubBalancesBroadcast = this.transport.on('balancesChange', (balances) => {
      this.applyBalances([...balances]);
    });
  }

  // === Bootstrap ===

  async bootstrap(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<PaywallBootstrap> {
    const result = await this.transport.request(
      'billing.bootstrap',
      { force: opts.force },
      { signal: opts.signal }
    );
    this.applyBootstrap(result);
    if (result.user) this.applyUser(result.user);
    return result;
  }

  getCachedBootstrap(): PaywallBootstrap | null {
    return this.cachedBootstrap;
  }

  /** Subscribe to bootstrap state. Structurally compatible with
   *  `BillingClient.onBootstrapChange` — same microtask semantics for the
   *  initial snapshot. In extension mode offscreen does not yet broadcast
   *  bootstrapChange, so the listener fires only on self-initiated `bootstrap()`
   *  calls within this RemoteBillingClient (popup re-fetches bootstrap → mirror
   *  updates → listener fires). A cross-surface revalidate (another tab updated
   *  bootstrap) does not reach the popup — that would require a separate
   *  bootstrapChange broadcast in protocol.ts/server.ts. */
  onBootstrapChange(
    cb: BootstrapListener,
    opts: { immediate?: 'microtask' | 'sync' | 'none' } = {}
  ): () => void {
    this.bootstrapListeners.add(cb);
    const mode = opts.immediate ?? 'microtask';
    if (this.cachedBootstrap && mode !== 'none') {
      const snapshot = this.cachedBootstrap;
      if (mode === 'sync') {
        try {
          cb(snapshot);
        } catch (e) {
          console.warn('[paywall] onBootstrapChange initial sync threw', e);
        }
      } else {
        queueMicrotask(() => {
          if (this.bootstrapListeners.has(cb)) cb(snapshot);
        });
      }
    }
    return () => {
      this.bootstrapListeners.delete(cb);
    };
  }

  /** Shortcut over `bootstrap()` — returns the paywall prices (locale overrides
   *  already applied in offscreen). Same caching semantics as `bootstrap()`. */
  async getPrices(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<PaywallPrice[]> {
    const b = await this.bootstrap(opts);
    return b.prices;
  }

  /** Sync snapshot of prices from the local bootstrap mirror. null = not loaded yet. */
  getCachedPrices(): PaywallPrice[] | null {
    return this.cachedBootstrap?.prices ?? null;
  }

  /** Sync snapshot of offers. null = bootstrap not loaded, [] = paywall has no
   *  offers. Server-side targeting (countries/email/mode) is already applied by
   *  the backend — only what's applicable to the current user is exposed. */
  getCachedOffers(): PaywallOffer[] | null {
    return this.cachedBootstrap?.offers ?? null;
  }

  // === Visitor ===

  async getVisitorId(): Promise<string> {
    return this.transport.request('billing.getVisitorId', undefined);
  }

  // === User ===

  async getUser(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<PaywallUser> {
    const result = await this.transport.request(
      'billing.getUser',
      { force: opts.force },
      { signal: opts.signal }
    );
    this.applyUser(result);
    return result;
  }

  getCachedUser(): PaywallUser | null {
    return this.cachedUser;
  }

  /** Subscribe to user state. We mirror the offscreen broadcasts; the initial
   *  snapshot is delivered via microtask from the local cache (if present) —
   *  exactly like in BillingClient.onUserChange. Returns an unsubscribe function. */
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

  // === Balances ===

  async getBalances(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<Balance[]> {
    const result = await this.transport.request(
      'billing.getBalances',
      { force: opts.force },
      { signal: opts.signal }
    );
    const arr = [...result];
    this.applyBalances(arr);
    return arr;
  }

  getCachedBalances(): Balance[] | null {
    return this.cachedBalances;
  }

  onBalanceChange(
    cb: BalanceListener,
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

  // === Checkout ===

  async createCheckout(params: {
    priceId: string;
    successUrl?: string;
    errorUrl?: string;
    shopUrl?: string;
    trialDays?: number;
    idempotencyKey?: string;
    ignoreActivePurchase?: boolean;
    signal?: AbortSignal;
  }): Promise<CheckoutResult> {
    const { signal, ...payload } = params;
    return this.transport.request('billing.createCheckout', payload, { signal });
  }

  // === Customer portal: list/cancel purchases ===

  /** Rich-shape list of the user's purchases (with price, currency, interval,
   *  discount, cancel metadata). Through offscreen — there the real BillingClient
   *  hits `/api/v1/paywall/[id]/user` with a Bearer token. Useful for the
   *  customer-portal UI: cards + Cancel/Renew buttons. */
  async listPurchases(opts: { signal?: AbortSignal } = {}): Promise<PaywallPurchaseDetailed[]> {
    const result = await this.transport.request('billing.listPurchases', undefined, {
      signal: opts.signal
    });
    return [...result];
  }

  /** Support ticket through the offscreen BillingClient. File objects survive
   *  chrome.runtime structured-clone (the port forwards them as-is) — the
   *  Bearer token / email substitution is done by offscreen, as in the regular
   *  BillingClient. */
  async createSupportTicket(payload: {
    subject: string;
    content: string;
    email?: string;
    files?: File[];
  }): Promise<{ ticket: { id: number; status: string } }> {
    return this.transport.request('billing.createSupportTicket', payload);
  }

  /** Cancel a subscription through the backend. By default cancels at the end
   *  of the current period (the user keeps access until the renewal date).
   *  reason is required (validated by the backend) — collected via a reason
   *  selector in the host UI. */
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
    const { signal, ...payload } = params;
    return this.transport.request('billing.cancelSubscription', payload, { signal });
  }

  // === Storage ===

  /** PaywallUI asks the billing client for storage for TrialStore and other
   *  consumers. Returns a proxy: get/set/remove go through transport to the
   *  offscreen storage = single source of truth for all tabs. */
  getStorage(): StorageAdapter {
    return this.remoteStorageAdapter;
  }

  /** Factory method for PaywallUI: instead of a local createTrialStore over the
   *  storage proxy, we return a RemoteTrialStore — it sends each operation as
   *  one atomic RPC to offscreen, where navigator.locks serializes the
   *  read-modify-write. PaywallUI duck-types this method and prefers it over the
   *  local factory when present. */
  createTrialStore(config: TrialConfig): TrialStore {
    return new RemoteTrialStore(this.transport, this.paywallId, config);
  }

  // === Identity ===

  getIdentity(): Identity | null {
    return this.identity;
  }

  async setIdentity(identity: Identity | null): Promise<void> {
    this.identity = identity;
    await this.transport.request('billing.setIdentity', { identity });
  }

  /** Load identity from offscreen. Used on the first connection of a
   *  content-script — if another tab has already logged the user in, the current
   *  one immediately picks up the identity without waiting for authChange. */
  async syncIdentity(): Promise<Identity | null> {
    const result = await this.transport.request('billing.getIdentity', undefined);
    this.identity = result;
    return result;
  }

  destroy(): void {
    this.unsubUserBroadcast?.();
    this.unsubBalancesBroadcast?.();
    this.unsubUserBroadcast = null;
    this.unsubBalancesBroadcast = null;
    this.userListeners.clear();
    this.balanceListeners.clear();
    this.bootstrapListeners.clear();
    this.cachedBootstrap = null;
    this.cachedUser = null;
    this.cachedBalances = null;
    this.identity = null;
  }

  private applyBootstrap(bootstrap: PaywallBootstrap): void {
    this.cachedBootstrap = bootstrap;
    for (const cb of [...this.bootstrapListeners]) {
      try {
        cb(bootstrap);
      } catch (e) {
        console.warn('[paywall] onBootstrapChange listener threw', e);
      }
    }
  }

  /** Update the user mirror and emit to listeners if it actually changed. Used
   *  both for self-initiated RPCs (bootstrap/getUser) and for broadcasts from
   *  offscreen — so the host's onUserChange handler gets a signal regardless of
   *  who triggered the update. */
  private applyUser(user: PaywallUser): void {
    if (sameUser(this.cachedUser, user)) return;
    this.cachedUser = user;
    this.fireUserListeners(user);
  }

  private applyBalances(balances: Balance[]): void {
    if (sameBalances(this.cachedBalances, balances)) return;
    this.cachedBalances = balances;
    this.fireBalanceListeners(balances);
  }

  private fireUserListeners(user: PaywallUser): void {
    for (const cb of [...this.userListeners]) {
      try {
        cb(user);
      } catch (e) {
        console.warn('[paywall] onUserChange listener threw', e);
      }
    }
  }

  private fireBalanceListeners(balances: Balance[]): void {
    for (const cb of [...this.balanceListeners]) {
      try {
        cb(balances);
      } catch (e) {
        console.warn('[paywall] onBalanceChange listener threw', e);
      }
    }
  }
}

function sameUser(a: PaywallUser | null, b: PaywallUser | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.has_active_subscription === b.has_active_subscription &&
    (a.purchases?.length ?? 0) === (b.purchases?.length ?? 0)
  );
}

function sameBalances(a: Balance[] | null, b: Balance[] | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].type !== b[i].type || a[i].count !== b[i].count) return false;
  }
  return true;
}
