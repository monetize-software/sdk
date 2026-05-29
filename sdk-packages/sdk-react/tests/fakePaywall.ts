import type {
  AuthSession,
  PaywallAccessResult,
  PaywallEvent,
  PaywallEventHandler,
  PaywallOffer,
  PaywallStateSnapshot,
  PaywallUI,
  PaywallUser,
  PaywallPrice,
  ResolvedOffer
} from '../src';

// Drop-in совместимый PaywallUI для тестов. Имитирует те части public API,
// которые трогают наши хуки и компоненты, без сетевых вызовов и DOM-mount'а.
//
// Любой тестовый сценарий двигает state и эмитит события явно — это даёт
// детерминированные тесты вне зависимости от внутренних reactor'ов SDK.

type EventMap = {
  [E in PaywallEvent]: Set<(payload: unknown) => void>;
};

type Listener<T> = (value: T) => void;

export interface FakePaywallOptions {
  initialUser?: PaywallUser | null;
  initialState?: PaywallStateSnapshot;
  initialAccess?: PaywallAccessResult;
  initialPrices?: PaywallPrice[] | null;
  initialTrial?: ReturnType<PaywallUI['getTrialStatus']>;
  initialVisibility?: ReturnType<PaywallUI['getVisibility']>;
  /** Опциональный managed-auth стаб. Без него `paywall.auth` остаётся
   *  undefined — для тестов hybrid-режима. С `initialSession` или вызовом
   *  `setSession(...)` FakePaywall эмулирует AuthClient API, который трогает
   *  usePaywallUser (`getCachedSession()` + authChange-эмиты). */
  withAuth?: boolean;
  initialSession?: AuthSession | null;
}

export class FakePaywall {
  private listeners: Partial<EventMap> = {};
  private stateListeners = new Set<Listener<PaywallStateSnapshot>>();
  private userListeners = new Set<Listener<PaywallUser>>();
  private state: PaywallStateSnapshot;
  private user: PaywallUser | null;
  private access: PaywallAccessResult;
  private prices: PaywallPrice[] | null;
  private offers: PaywallOffer[] | null;
  private offerForPrice: Map<string, ResolvedOffer | null> = new Map();
  private trial: ReturnType<PaywallUI['getTrialStatus']>;
  private visibility: ReturnType<PaywallUI['getVisibility']>;
  private session: AuthSession | null = null;

  // Spy-счётчики для assert'ов в тестах.
  openCalls = 0;
  openSupportCalls = 0;
  openAuthCalls = 0;
  openSigninCalls = 0;
  openSignupCalls = 0;
  closeCalls = 0;
  getAccessCalls = 0;
  getPricesCalls = 0;
  destroyCalls = 0;

  constructor(opts: FakePaywallOptions = {}) {
    this.state = opts.initialState ?? { open: false, view: null, error: null };
    this.user = opts.initialUser ?? null;
    this.access =
      opts.initialAccess ?? {
        access: 'blocked',
        reason: 'no_subscription',
        visibility: null,
        trial: null,
        user: null
      };
    this.prices = opts.initialPrices ?? null;
    this.offers = null;
    this.trial = opts.initialTrial ?? null;
    this.visibility = opts.initialVisibility ?? null;
    this.session = opts.initialSession ?? null;
    if (opts.withAuth || opts.initialSession !== undefined) {
      this.auth = {
        getCachedSession: (): AuthSession | null => this.session
      };
    }
  }

  // billing.getCachedUser — usePaywallUser ходит через эту цепочку.
  billing = {
    getCachedUser: (): PaywallUser | null => this.user
  };

  /** Опциональный managed-auth стаб. Заполняется в конструкторе по
   *  `withAuth: true` или явному `initialSession`. usePaywallUser проверяет
   *  его, чтобы различить guest vs signed-in. */
  auth?: { getCachedSession: () => AuthSession | null };

  open = (): void => {
    this.openCalls++;
  };
  openSupport = (): void => {
    this.openSupportCalls++;
  };
  openAuth = (): void => {
    this.openAuthCalls++;
  };
  openSignin = (): void => {
    this.openSigninCalls++;
  };
  openSignup = (): void => {
    this.openSignupCalls++;
  };
  signInAnonymouslyCalls = 0;
  signInAnonymously = async (): Promise<never> => {
    this.signInAnonymouslyCalls++;
    return Promise.reject(new Error('fakePaywall: signInAnonymously not stubbed'));
  };
  close = (): void => {
    this.closeCalls++;
  };
  destroy = (): void => {
    this.destroyCalls++;
  };

  on = <E extends PaywallEvent>(event: E, handler: PaywallEventHandler<E>): (() => void) => {
    const set = (this.listeners[event] ??= new Set());
    const wrapped = handler as (payload: unknown) => void;
    set.add(wrapped);
    return () => set.delete(wrapped);
  };
  off = <E extends PaywallEvent>(event: E, handler: PaywallEventHandler<E>): void => {
    this.listeners[event]?.delete(handler as (payload: unknown) => void);
  };

  getState = (): PaywallStateSnapshot => this.state;
  onStateChange = (cb: Listener<PaywallStateSnapshot>): (() => void) => {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  };

  getAccess = async (): Promise<PaywallAccessResult> => {
    this.getAccessCalls++;
    return this.access;
  };

  getPrices = async (): Promise<PaywallPrice[]> => {
    this.getPricesCalls++;
    return this.prices ?? [];
  };
  getCachedPrices = (): PaywallPrice[] | null => this.prices;

  getCachedOffers = (): PaywallOffer[] | null => this.offers;
  getOfferForPrice = (priceId: string): ResolvedOffer | null =>
    this.offerForPrice.get(priceId) ?? null;

  getTrialStatus = (): ReturnType<PaywallUI['getTrialStatus']> => this.trial;
  getVisibility = (): ReturnType<PaywallUI['getVisibility']> => this.visibility;

  // ---- helpers для тестов ----

  setState(snapshot: PaywallStateSnapshot): void {
    this.state = snapshot;
    for (const cb of this.stateListeners) cb(snapshot);
  }

  setUser(user: PaywallUser | null): void {
    this.user = user;
    if (user) this.emit('userChange', user as never);
  }

  setSession(session: AuthSession | null): void {
    this.session = session;
    this.emit('authChange', {
      event: session ? 'SIGNED_IN' : 'SIGNED_OUT',
      session
    } as never);
  }

  setAccess(access: PaywallAccessResult): void {
    this.access = access;
  }

  setOffers(offers: PaywallOffer[] | null): void {
    this.offers = offers;
  }

  setOfferForPrice(priceId: string, resolved: ResolvedOffer | null): void {
    this.offerForPrice.set(priceId, resolved);
  }

  setTrial(trial: ReturnType<PaywallUI['getTrialStatus']>): void {
    this.trial = trial;
  }

  setVisibility(visibility: ReturnType<PaywallUI['getVisibility']>): void {
    this.visibility = visibility;
  }

  emit<E extends PaywallEvent>(event: E, payload: unknown): void {
    for (const cb of this.listeners[event] ?? []) cb(payload);
  }
}

/** Каст в `PaywallUI` для passing'а в Provider. Структурная совместимость
 *  гарантирована поверхностью методов, которые трогают наши хуки —
 *  contract.ts держит SDK side в синхронизации, а тесты держат FakePaywall
 *  side через TS-checking. */
export function asPaywallUI(fake: FakePaywall): PaywallUI {
  return fake as unknown as PaywallUI;
}
