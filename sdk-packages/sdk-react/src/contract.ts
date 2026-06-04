/**
 * Type-level contract between sdk-react and @monetize.software/sdk.
 *
 * This file is compiled in the TS build (`pnpm typecheck`) but is not exported
 * outside — these are "assertions", not runtime code. Each check pins down a
 * concrete expectation about the SDK's public surface that the Provider /
 * hooks / components rely on.
 *
 * If someone in the SDK:
 *   - renames/removes a public PaywallUI method,
 *   - changes the constructor signature `new PaywallUI(opts)`,
 *   - drops a field from `PaywallStateSnapshot` / `PaywallAccessResult`,
 *   - changes an event's payload type (for example, `purchase_completed`),
 *
 * — `tsc --noEmit` in sdk-react fails on this file before anyone notices the
 * mismatch in prod. That's exactly the "contract": explicitly enumerated
 * points of reliance.
 *
 * Discipline: when adding a new hook/component that pulls something new from
 * the SDK, add a check here. The contract should be verifiable on its own, not
 * indirectly through a successful typecheck of business code (business code
 * can silently move to a different API point, and a contract based on actual
 * usage would lose its meaning).
 *
 * Type names prefixed with `_` are intentional — it signals that these are
 * assertions for the compiler, not publicly available aliases.
 */

import type {
  PaywallUI,
  PaywallUIOptions,
  PaywallEvent,
  PaywallEventHandler,
  PaywallStateSnapshot,
  PaywallAccessResult,
  GetAccessOptions,
  OpenOptions,
  PaywallUser,
  PaywallPrice
} from '@monetize.software/sdk';

// -----------------------------------------------------------------------------
// 1. PaywallUI constructor and public methods
// -----------------------------------------------------------------------------

// new PaywallUI(opts: PaywallUIOptions) — that's exactly how the Provider creates the instance.
type _AssertConstructor = ConstructorParameters<typeof PaywallUI> extends [PaywallUIOptions]
  ? true
  : false;

// Methods that the hooks and components pull. If one disappears — `keyof PaywallUI`
// will stop containing that key, and `_AssertMethods` becomes `never`.
type RequiredMethods =
  | 'open'
  | 'openSupport'
  | 'openAuth'
  | 'openSignin'
  | 'openSignup'
  | 'checkout'
  | 'signInAnonymously'
  | 'close'
  | 'on'
  | 'off'
  | 'getState'
  | 'onStateChange'
  | 'getAccess'
  | 'getPrices'
  | 'getCachedPrices'
  | 'getCachedOffers'
  | 'getOfferForPrice'
  | 'getTrialStatus'
  | 'getVisibility'
  | 'destroy'
  | 'billing'; // not a method, but a public field — needed for billing.getCachedUser()

// `[X] extends [Y]` — disables the distributive-conditional, otherwise TS
// would split the RequiredMethods union and count the check as true even if at
// least one member dropped out of `keyof PaywallUI`.
type _AssertMethods = [RequiredMethods] extends [keyof PaywallUI] ? true : false;

// `paywall.billing.getCachedUser()` — usePaywallUser reads through this chain.
type _AssertBillingGetCachedUser = PaywallUI['billing']['getCachedUser'] extends () => PaywallUser | null
  ? true
  : false;

// usePaywallUser also reads `paywall.auth?.getCachedSession()` to distinguish
// guest vs loading-after-signin. `auth` is optional (hybrid mode doesn't create
// an AuthClient), so we check through NonNullable.
type _AssertAuthGetCachedSession = NonNullable<PaywallUI['auth']>['getCachedSession'] extends () => unknown | null
  ? true
  : false;

// -----------------------------------------------------------------------------
// 2. Open signatures and options
// -----------------------------------------------------------------------------

// open(opts?: OpenOptions) — `<PaywallButton>` forwards into `paywall.open(openOpts)`.
type _AssertOpenSignature = Parameters<PaywallUI['open']> extends [(OpenOptions | undefined)?]
  ? true
  : false;

// openSupport/openAuth/openSignin/openSignup have the same signature — the
// PaywallButton component switches between them via the `mode` prop.
type _AssertOpenSupportSignature = Parameters<PaywallUI['openSupport']> extends [(OpenOptions | undefined)?]
  ? true
  : false;

// checkout(priceId, opts?) — `<PaywallButton priceId>` forwards into
// `paywall.checkout(priceId, openOpts)`. The signature differs from the open*
// methods by the first positional priceId argument, hence a separate assertion.
type _AssertCheckoutSignature = Parameters<PaywallUI['checkout']> extends [string, (OpenOptions | undefined)?]
  ? true
  : false;

// -----------------------------------------------------------------------------
// 3. PaywallStateSnapshot shape — usePaywallState returns this type
// -----------------------------------------------------------------------------

// The fields that usePaywallState and our SSR_SNAPSHOT placeholder rely on.
// `processing` was added in alpha.13 for late-mount direct-checkout: PaywallButton
// reads it in priceId mode to show busy without a modal flash.
type _AssertStateShape = PaywallStateSnapshot extends {
  open: boolean;
  view: unknown;
  error: unknown;
  processing: boolean;
}
  ? true
  : false;

// getState() returns PaywallStateSnapshot (not some other shape).
type _AssertGetState = ReturnType<PaywallUI['getState']> extends PaywallStateSnapshot
  ? true
  : false;

// onStateChange returns an unsubscribe function (used by useSyncExternalStore subscribe).
type _AssertOnStateChange = ReturnType<PaywallUI['onStateChange']> extends () => void
  ? true
  : false;

// -----------------------------------------------------------------------------
// 4. PaywallAccessResult — usePaywallAccess and <PaywallGate> destructure this
// -----------------------------------------------------------------------------

// Discriminator on `access`.
type _AssertAccessGranted = [Extract<PaywallAccessResult, { access: 'granted' }>] extends [never]
  ? false
  : true;
type _AssertAccessBlocked = [Extract<PaywallAccessResult, { access: 'blocked' }>] extends [never]
  ? false
  : true;

// getAccess() returns Promise<PaywallAccessResult> — usePaywallAccess awaits it.
type _AssertGetAccess = ReturnType<PaywallUI['getAccess']> extends Promise<PaywallAccessResult>
  ? true
  : false;

// GetAccessOptions contains skipTrial / skipVisibility / signal — we read them.
type _AssertGetAccessOptions = GetAccessOptions extends {
  skipTrial?: boolean | undefined;
  skipVisibility?: boolean | undefined;
  signal?: AbortSignal | undefined;
}
  ? true
  : false;

// -----------------------------------------------------------------------------
// 5. Event system — usePaywallEvent types the payload via PaywallEventHandler
// -----------------------------------------------------------------------------

// Events our hooks subscribe to. If the SDK renames an event — PaywallEvent
// will stop containing that literal, and `_AssertEvents` becomes never.
type RequiredEvents =
  | 'open'
  | 'close'
  | 'ready'
  | 'error'
  | 'purchase_completed'
  | 'purchase_failed'
  | 'userChange'
  | 'authChange'
  | 'trial_blocked'
  | 'trial_expired'
  | 'visibility_blocked';

type _AssertEvents = [RequiredEvents] extends [PaywallEvent] ? true : false;

// on(event, handler) returns unsubscribe — usePaywallEvent builds its
// useEffect cleanup on this.
type _AssertOnReturn = ReturnType<PaywallUI['on']> extends () => void ? true : false;

// PaywallEventHandler<'userChange'> accepts PaywallUser (without a union with other
// payloads when narrowed). This is critical for the event types in usePaywallEvent.
type _AssertUserChangePayload = Parameters<PaywallEventHandler<'userChange'>>[0] extends PaywallUser
  ? true
  : false;

// -----------------------------------------------------------------------------
// 6. Prices and trial/visibility snapshots
// -----------------------------------------------------------------------------

type _AssertGetPrices = ReturnType<PaywallUI['getPrices']> extends Promise<PaywallPrice[]>
  ? true
  : false;
type _AssertGetCachedPrices = ReturnType<PaywallUI['getCachedPrices']> extends PaywallPrice[] | null
  ? true
  : false;
// usePaywallOffers / usePaywallOffer are built on these two getters.
type _AssertGetCachedOffers = ReturnType<PaywallUI['getCachedOffers']> extends unknown[] | null
  ? true
  : false;
type _AssertGetOfferForPrice = Parameters<PaywallUI['getOfferForPrice']> extends [string]
  ? true
  : false;

// getTrialStatus / getVisibility return T|null — our hooks read exactly this shape.
type _AssertTrialNullable = null extends ReturnType<PaywallUI['getTrialStatus']> ? true : false;
type _AssertVisibilityNullable = null extends ReturnType<PaywallUI['getVisibility']> ? true : false;

// -----------------------------------------------------------------------------
// Enforcer — `Assert<T extends true>` catches the situation when any check
// above resolves to something other than `true`. Without this wrapper TS would
// let the `never` type through (also legitimate, just poorly documenting the
// breakage); with it, such a case is a compile error on the specific check line.
// -----------------------------------------------------------------------------

type Assert<T extends true> = T;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ContractChecks = [
  Assert<_AssertConstructor>,
  Assert<_AssertMethods>,
  Assert<_AssertBillingGetCachedUser>,
  Assert<_AssertAuthGetCachedSession>,
  Assert<_AssertOpenSignature>,
  Assert<_AssertOpenSupportSignature>,
  Assert<_AssertCheckoutSignature>,
  Assert<_AssertStateShape>,
  Assert<_AssertGetState>,
  Assert<_AssertOnStateChange>,
  Assert<_AssertAccessGranted>,
  Assert<_AssertAccessBlocked>,
  Assert<_AssertGetAccess>,
  Assert<_AssertGetAccessOptions>,
  Assert<_AssertEvents>,
  Assert<_AssertOnReturn>,
  Assert<_AssertUserChangePayload>,
  Assert<_AssertGetPrices>,
  Assert<_AssertGetCachedPrices>,
  Assert<_AssertGetCachedOffers>,
  Assert<_AssertGetOfferForPrice>,
  Assert<_AssertTrialNullable>,
  Assert<_AssertVisibilityNullable>
];

// No `export` — the module is only for TS-side-effect compilation. The file is
// automatically captured via tsconfig.include = ["src", ...].
