// RemoteBillingClient — структурный совместимец BillingClient, который
// проксирует все методы в offscreen через TransportClient. Public API
// идентичен (host пишет тот же код, что для @monetize.software/sdk), реализация
// другая. Sync-getCached* остаются sync — ходят в локальный mirror, который
// обновляется (a) ответами на async-методы и (b) broadcast-событиями
// userChange/balancesChange.

import type {
  Balance,
  CheckoutResult,
  Identity,
  PaywallBootstrap,
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

  // Локальные mirror'ы. Источник правды — offscreen; mirror нужен только
  // чтобы getCached* оставались sync. Updated после каждого async-ответа +
  // на каждом broadcast-событии.
  private cachedBootstrap: PaywallBootstrap | null = null;
  private cachedUser: PaywallUser | null = null;
  private cachedBalances: Balance[] | null = null;
  private identity: Identity | null = null;
  /** Storage proxy через transport: get/set/remove идут в offscreen'овский
   *  StorageAdapter (single source of truth для всех вкладок). Trial-state
   *  PaywallUI пишет сюда — все табы видят один и тот же counter, не
   *  drift'ит между вкладками.
   *
   *  Race-окно read-modify-write всё ещё существует (две вкладки одновременно
   *  читают N → пишут N-1, drift 1). Для exact atomicity нужен Phase 9:
   *  TrialStore целиком переехать в offscreen и делать recordBlock как
   *  single-handler с одной atomic-операцией. Это редкий edge case
   *  (одновременное открытие пейвола в нескольких вкладках в рамках мс). */
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
      // watch не реализуем — для cross-context уведомлений consumer'ы (AuthClient,
      // TrialStore) подписываются на broadcast-events напрямую через transport.
      // Если когда-то понадобится — добавим storage.watch broadcast.
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

  /** Подписка на bootstrap-state. Структурно совместима с
   *  `BillingClient.onBootstrapChange` — те же микротаск-семантики для initial
   *  snapshot. В extension-режиме offscreen пока не broadcast'ит bootstrapChange,
   *  поэтому listener срабатывает только на self-инициированные `bootstrap()`
   *  внутри этого RemoteBillingClient'а (popup перезапрашивает bootstrap → mirror
   *  обновляется → listener вызывается). Cross-surface revalidate (другая вкладка
   *  обновила bootstrap) не доезжает до popup'а — для этого нужен отдельный
   *  bootstrapChange-broadcast в protocol.ts/server.ts. */
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

  /** Шорткат над `bootstrap()` — возвращает цены пейвола (locale-оверрайды
   *  уже применены в offscreen'е). Те же кэш-семантики, что у `bootstrap()`. */
  async getPrices(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<PaywallPrice[]> {
    const b = await this.bootstrap(opts);
    return b.prices;
  }

  /** Sync-снимок цен из локального mirror'а bootstrap'а. null = ещё не грузили. */
  getCachedPrices(): PaywallPrice[] | null {
    return this.cachedBootstrap?.prices ?? null;
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

  /** Подписка на user-state. Mirror'имся на broadcast'ы offscreen'а; initial
   *  snapshot отдаётся через microtask из локального cache (если есть) —
   *  ровно как в BillingClient.onUserChange. Возвращает функцию отписки. */
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

  /** Rich-shape список покупок юзера (с ценой, валютой, interval, discount,
   *  cancel-метаданными). Через offscreen — там настоящий BillingClient
   *  ходит на `/api/v1/paywall/[id]/user` с Bearer'ом. Полезно для
   *  customer-portal UI: cards + Cancel/Renew кнопки. */
  async listPurchases(opts: { signal?: AbortSignal } = {}): Promise<PaywallPurchaseDetailed[]> {
    const result = await this.transport.request('billing.listPurchases', undefined, {
      signal: opts.signal
    });
    return [...result];
  }

  /** Саппорт-тикет через offscreen'овский BillingClient. File-объекты
   *  переживают chrome.runtime structured-clone (port forward'ит as-is) —
   *  Bearer-токен/email-substitution делает offscreen, как в обычном
   *  BillingClient. */
  async createSupportTicket(payload: {
    subject: string;
    content: string;
    email?: string;
    files?: File[];
  }): Promise<{ ticket: { id: number; status: string } }> {
    return this.transport.request('billing.createSupportTicket', payload);
  }

  /** Отменить подписку через бэк. По умолчанию cancel в конце текущего
   *  периода (юзер сохраняет access до renewal date'ы). reason обязательна
   *  (валидируется бэком) — собирается через select причин в host-UI. */
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

  /** PaywallUI просит storage у billing-клиента для TrialStore и других
   *  consumer'ов. Возвращает proxy: get/set/remove идут через transport
   *  в offscreen'овский storage = single source of truth для всех вкладок. */
  getStorage(): StorageAdapter {
    return this.remoteStorageAdapter;
  }

  /** Factory-метод для PaywallUI: вместо локального createTrialStore'а на
   *  storage-proxy, возвращаем RemoteTrialStore — он шлёт каждую операцию
   *  одним атомарным RPC в offscreen, где navigator.locks сериализуют
   *  read-modify-write. PaywallUI duck-types этот метод и предпочитает его
   *  локальной фабрике, если он есть. */
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

  /** Подгрузить identity с offscreen'а. Используется при первом подключении
   *  content-script'а — если другая вкладка уже залогинила юзера, текущая
   *  тут же подхватит identity без ожидания authChange. */
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

  /** Обновить mirror user'а и эмитнуть listener'ам если он реально изменился.
   *  Используется и для self-инициированных RPC (bootstrap/getUser), и для
   *  broadcast'ов от offscreen — чтобы host'овский onUserChange handler
   *  получил signal независимо от того, кто триггернул обновление. */
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
