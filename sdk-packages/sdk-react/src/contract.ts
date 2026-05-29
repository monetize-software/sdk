/**
 * Type-level контракт между sdk-react и @monetize.software/sdk.
 *
 * Этот файл компилируется в TS-сборке (`pnpm typecheck`), но не экспортируется
 * наружу — это «assertion'ы», а не runtime-код. Каждая проверка фиксирует
 * конкретное ожидание относительно публичной поверхности SDK, на которое
 * полагаются Provider / hooks / components.
 *
 * Если в SDK кто-то:
 *   - переименует/удалит публичный метод PaywallUI,
 *   - поменяет сигнатуру конструктора `new PaywallUI(opts)`,
 *   - выкинет поле из `PaywallStateSnapshot` / `PaywallAccessResult`,
 *   - изменит payload-тип события (например, `purchase_completed`),
 *
 * — `tsc --noEmit` в sdk-react падает на этом файле раньше, чем кто-то
 * заметит расхождение в проде. Это и есть «контракт»: эксплицитно
 * перечисленные точки опоры.
 *
 * Дисциплина: при добавлении нового хука/компонента, который тянет что-то
 * новое из SDK, добавлять проверку сюда. Контракт должен быть проверяем
 * сам по себе, а не косвенно через успешный typecheck бизнес-кода (бизнес-
 * код может незаметно переехать на другую API-точку, и контракт по
 * фактическому использованию потеряет смысл).
 *
 * Тип-имена с префиксом `_` намеренно — сигнализирует, что это assertion'ы
 * для компилятора, а не общедоступные алиасы.
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
// 1. Конструктор и публичные методы PaywallUI
// -----------------------------------------------------------------------------

// new PaywallUI(opts: PaywallUIOptions) — Provider создаёт инстанс именно так.
type _AssertConstructor = ConstructorParameters<typeof PaywallUI> extends [PaywallUIOptions]
  ? true
  : false;

// Методы, которые тянут хуки и компоненты. Если какой-то исчезнет — `keyof PaywallUI`
// перестанет содержать этот ключ, и `_AssertMethods` станет `never`.
type RequiredMethods =
  | 'open'
  | 'openSupport'
  | 'openAuth'
  | 'openSignin'
  | 'openSignup'
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
  | 'billing'; // не метод, но публичное поле — нужно для billing.getCachedUser()

// `[X] extends [Y]` — отключаем distributive-conditional, иначе TS
// раздробит union RequiredMethods и засчитает проверку true, даже если хотя бы
// один из членов выпадет из `keyof PaywallUI`.
type _AssertMethods = [RequiredMethods] extends [keyof PaywallUI] ? true : false;

// `paywall.billing.getCachedUser()` — usePaywallUser читает через эту цепочку.
type _AssertBillingGetCachedUser = PaywallUI['billing']['getCachedUser'] extends () => PaywallUser | null
  ? true
  : false;

// usePaywallUser также читает `paywall.auth?.getCachedSession()` чтобы
// различить guest vs loading-after-signin. `auth` опционален (hybrid mode
// не создаёт AuthClient), поэтому проверяем через NonNullable.
type _AssertAuthGetCachedSession = NonNullable<PaywallUI['auth']>['getCachedSession'] extends () => unknown | null
  ? true
  : false;

// -----------------------------------------------------------------------------
// 2. Сигнатуры открытия и опций
// -----------------------------------------------------------------------------

// open(opts?: OpenOptions) — `<PaywallButton>` пробрасывает в `paywall.open(openOpts)`.
type _AssertOpenSignature = Parameters<PaywallUI['open']> extends [(OpenOptions | undefined)?]
  ? true
  : false;

// openSupport/openAuth/openSignin/openSignup имеют ту же сигнатуру — компонент
// PaywallButton переключается между ними через `mode` prop.
type _AssertOpenSupportSignature = Parameters<PaywallUI['openSupport']> extends [(OpenOptions | undefined)?]
  ? true
  : false;

// -----------------------------------------------------------------------------
// 3. Shape PaywallStateSnapshot — usePaywallState возвращает этот тип
// -----------------------------------------------------------------------------

// Поля, на которые опирается usePaywallState и наш SSR_SNAPSHOT placeholder.
type _AssertStateShape = PaywallStateSnapshot extends {
  open: boolean;
  view: unknown;
  error: unknown;
}
  ? true
  : false;

// getState() возвращает PaywallStateSnapshot (не другой shape).
type _AssertGetState = ReturnType<PaywallUI['getState']> extends PaywallStateSnapshot
  ? true
  : false;

// onStateChange возвращает функцию-unsubscribe (использует useSyncExternalStore subscribe).
type _AssertOnStateChange = ReturnType<PaywallUI['onStateChange']> extends () => void
  ? true
  : false;

// -----------------------------------------------------------------------------
// 4. PaywallAccessResult — usePaywallAccess и <PaywallGate> деструктурируют это
// -----------------------------------------------------------------------------

// Discriminator на `access`.
type _AssertAccessGranted = [Extract<PaywallAccessResult, { access: 'granted' }>] extends [never]
  ? false
  : true;
type _AssertAccessBlocked = [Extract<PaywallAccessResult, { access: 'blocked' }>] extends [never]
  ? false
  : true;

// getAccess() возвращает Promise<PaywallAccessResult> — usePaywallAccess await'ит.
type _AssertGetAccess = ReturnType<PaywallUI['getAccess']> extends Promise<PaywallAccessResult>
  ? true
  : false;

// GetAccessOptions содержит skipTrial / skipVisibility / signal — мы их читаем.
type _AssertGetAccessOptions = GetAccessOptions extends {
  skipTrial?: boolean | undefined;
  skipVisibility?: boolean | undefined;
  signal?: AbortSignal | undefined;
}
  ? true
  : false;

// -----------------------------------------------------------------------------
// 5. Event-система — usePaywallEvent типизирует payload через PaywallEventHandler
// -----------------------------------------------------------------------------

// События, на которые подписываются наши хуки. Если SDK переименует событие —
// PaywallEvent перестанет содержать этот литерал, и `_AssertEvents` станет never.
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

// on(event, handler) возвращает unsubscribe — usePaywallEvent на этом
// строит useEffect-cleanup.
type _AssertOnReturn = ReturnType<PaywallUI['on']> extends () => void ? true : false;

// PaywallEventHandler<'userChange'> принимает PaywallUser (без union с другими payload'ами
// при сужении). Это критично для типов событий в usePaywallEvent.
type _AssertUserChangePayload = Parameters<PaywallEventHandler<'userChange'>>[0] extends PaywallUser
  ? true
  : false;

// -----------------------------------------------------------------------------
// 6. Прайсы и trial/visibility snapshot'ы
// -----------------------------------------------------------------------------

type _AssertGetPrices = ReturnType<PaywallUI['getPrices']> extends Promise<PaywallPrice[]>
  ? true
  : false;
type _AssertGetCachedPrices = ReturnType<PaywallUI['getCachedPrices']> extends PaywallPrice[] | null
  ? true
  : false;
// usePaywallOffers / usePaywallOffer строятся на этих двух геттерах.
type _AssertGetCachedOffers = ReturnType<PaywallUI['getCachedOffers']> extends unknown[] | null
  ? true
  : false;
type _AssertGetOfferForPrice = Parameters<PaywallUI['getOfferForPrice']> extends [string]
  ? true
  : false;

// getTrialStatus / getVisibility возвращают T|null — наши хуки читают именно эту форму.
type _AssertTrialNullable = null extends ReturnType<PaywallUI['getTrialStatus']> ? true : false;
type _AssertVisibilityNullable = null extends ReturnType<PaywallUI['getVisibility']> ? true : false;

// -----------------------------------------------------------------------------
// Enforcer — `Assert<T extends true>` ловит ситуацию, когда любая проверка
// выше резолвится не в `true`. Без этого враппера TS пропустил бы тип `never`
// (тоже легитимный, просто плохо документирующий поломку); с ним такой
// случай — compile error на конкретной строке-проверке.
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

// Никакого `export` — модуль только для TS-side-effect компиляции. Файл
// автоматически захвачен через tsconfig.include = ["src", ...].
