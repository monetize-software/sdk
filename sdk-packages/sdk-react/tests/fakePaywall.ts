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

// A drop-in compatible PaywallUI for tests. It mimics the parts of the public
// API that our hooks and components touch, without network calls or a DOM mount.
//
// Every test scenario drives state and emits events explicitly — this gives
// deterministic tests regardless of the SDK's internal reactors.

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
  /** Optional managed-auth stub. Without it, `paywall.auth` stays undefined —
   *  for hybrid-mode tests. With `initialSession` or a `setSession(...)` call,
   *  FakePaywall emulates the AuthClient API that usePaywallUser touches
   *  (`getCachedSession()` + authChange emits). */
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

  // Spy counters for assertions in tests.
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
    this.state = opts.initialState ?? {
      open: false,
      view: null,
      error: null,
      processing: false
    };
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

  // billing.getCachedUser — usePaywallUser goes through this chain.
  billing = {
    getCachedUser: (): PaywallUser | null => this.user
  };

  /** Optional managed-auth stub. Populated in the constructor based on
   *  `withAuth: true` or an explicit `initialSession`. usePaywallUser checks it
   *  to distinguish guest vs signed-in. */
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

  // ---- helpers for tests ----

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

/** Cast to `PaywallUI` for passing into the Provider. Structural compatibility
 *  is guaranteed by the surface of methods that our hooks touch —
 *  contract.ts keeps the SDK side in sync, and the tests keep the FakePaywall
 *  side in sync via TS checking. */
export function asPaywallUI(fake: FakePaywall): PaywallUI {
  return fake as unknown as PaywallUI;
}
