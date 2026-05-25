// Привязка RequestKind → params/result типов из @sdk/core/types.
// Module augmentation на RequestParamsMap/RequestResultMap из protocol.ts —
// чтобы wire-протокол знал, что 'billing.bootstrap' возвращает PaywallBootstrap,
// и TypeScript отлавливал расхождения на стороне content и offscreen.
//
// Если завтра в @sdk/core/types меняется shape — здесь сразу красное.

import type {
  Balance,
  CheckoutResult,
  Identity,
  PaywallBootstrap,
  PaywallPrice,
  PaywallPurchaseDetailed,
  PaywallUser,
  TrialConfig,
  TrialStatus
} from '@sdk/core/types';
import type {
  AuthChangeEvent,
  AuthSession,
  LastLogin,
  OAuthProvider,
  OtpVerifyType,
  SignUpResult
} from '@sdk/core/auth';

declare module './protocol' {
  interface RequestParamsMap {
    handshake: { protocolVersion: number; clientId: string };
    subscribe: { events: ReadonlyArray<'userChange' | 'authChange' | 'balancesChange'> };
    unsubscribe: { events: ReadonlyArray<'userChange' | 'authChange' | 'balancesChange'> };

    'billing.bootstrap': { force?: boolean };
    'billing.getCachedBootstrap': void;
    'billing.getUser': { force?: boolean };
    'billing.getCachedUser': void;
    'billing.getBalances': { force?: boolean };
    'billing.getCachedBalances': void;
    'billing.createCheckout': {
      priceId: string;
      successUrl?: string;
      errorUrl?: string;
      shopUrl?: string;
      trialDays?: number;
      idempotencyKey?: string;
      ignoreActivePurchase?: boolean;
    };
    'billing.listPurchases': void;
    'billing.cancelSubscription': { subscriptionId: string; reason: string };
    'billing.getIdentity': void;
    'billing.setIdentity': { identity: Identity | null };
    'billing.getVisitorId': void;
    /** File-объекты переживают chrome.runtime structured-clone через port'ы
     *  (SW forward'ит as-is). Лимиты на размер (10MB/файл, 5 файлов) валидирует
     *  SDK перед отправкой и backend ещё раз — оба чтобы не зашибить SW heap'ом
     *  при злоупотреблении. */
    'billing.createSupportTicket': {
      subject: string;
      content: string;
      email?: string;
      files?: File[];
    };

    'auth.signInWithEmail': { email: string; password: string };
    'auth.signUp': {
      email: string;
      password: string;
      userMeta?: Record<string, string>;
    };
    'auth.signOut': void;
    'auth.getCachedSession': void;
    'auth.refresh': void;
    'auth.requestPasswordReset': { email: string };
    'auth.updatePassword': { password: string };
    'auth.sendOtp': {
      email: string;
      createUser?: boolean;
      userMeta?: Record<string, unknown>;
    };
    'auth.verifyOtp': {
      email: string;
      token: string;
      type: OtpVerifyType;
    };
    'auth.resendConfirmation': { email: string };
    'auth.revokeAllSessions': void;
    /** OAuth split: content делает /init через offscreen, получает
     *  authorize_url и state. State (вместе с PKCE verifier'ом) живёт в
     *  offscreen'е до второго запроса. */
    'auth.oauthStart': {
      provider: OAuthProvider;
      scopes?: string;
      userMeta?: Record<string, string>;
    };
    /** Обмен code'а на session. State из oauthStart resolution идёт сюда —
     *  offscreen lookup'ит сохранённый verifier по state. */
    'auth.oauthExchange': { state: string; code: string };
    /** Текущий access token (lazy-refreshable). content/popup вызывает для
     *  передачи Bearer'а в внешние fetch'и (например, ApiGatewayClient в
     *  content-script). Возвращает null если разлогинен или refresh упал. */
    'auth.getAccessToken': void;
    /** Анонимный sign-in через offscreen AuthClient. `captchaToken`
     *  опциональный — bootloaded на будущее (когда сервер вернёт
     *  challenge_required и потребует proof-of-something). Сейчас сервер
     *  его не проверяет, поле резерв на forward-compat. `forceCaptcha`
     *  обходит idempotent + resume шаги и сразу делает /signin (создаёт
     *  нового anon-user'а — нужно при switch-account flow'е). */
    'auth.signInAnonymously': {
      captchaToken?: string;
      userMeta?: Record<string, string>;
      forceCaptcha?: boolean;
    };
    /** Last-used auth method + email per-paywall — для UI бейджа «Last used»
     *  в AuthPanel. Storage живёт в offscreen'е, читаем через transport. */
    'auth.getLastLogin': void;

    'tracker.track': { name: string; props?: Record<string, unknown> };

    'storage.get': { key: string };
    'storage.set': { key: string; value: string };
    'storage.remove': { key: string };

    'trial.check': { paywallId: string; config: TrialConfig };
    'trial.recordBlock': { paywallId: string; config: TrialConfig };
    'trial.reset': { paywallId: string; config: TrialConfig };
  }

  interface RequestResultMap {
    handshake: { protocolVersion: number; offscreenReady: boolean };
    subscribe: void;
    unsubscribe: void;

    'billing.bootstrap': PaywallBootstrap;
    'billing.getCachedBootstrap': PaywallBootstrap | null;
    'billing.getUser': PaywallUser;
    'billing.getCachedUser': PaywallUser | null;
    'billing.getBalances': ReadonlyArray<Balance>;
    'billing.getCachedBalances': ReadonlyArray<Balance> | null;
    'billing.createCheckout': CheckoutResult;
    'billing.listPurchases': ReadonlyArray<PaywallPurchaseDetailed>;
    'billing.cancelSubscription': {
      subscription: {
        status: string | null;
        canceled_at: string | null;
        cancel_at: string | null;
        cancel_at_period_end: boolean | null;
      };
    };
    'billing.getIdentity': Identity | null;
    'billing.setIdentity': void;
    'billing.getVisitorId': string;
    'billing.createSupportTicket': { ticket: { id: number; status: string } };

    'auth.signInWithEmail': AuthSession;
    'auth.signUp': SignUpResult;
    'auth.signOut': void;
    'auth.getCachedSession': AuthSession | null;
    'auth.refresh': AuthSession | null;
    'auth.requestPasswordReset': void;
    'auth.updatePassword': void;
    'auth.sendOtp': void;
    'auth.verifyOtp': AuthSession;
    'auth.resendConfirmation': void;
    'auth.revokeAllSessions': void;
    'auth.oauthStart': { authorizeUrl: string; state: string };
    'auth.oauthExchange': AuthSession;
    'auth.getAccessToken': string | null;
    'auth.signInAnonymously': AuthSession;
    'auth.getLastLogin': LastLogin | null;

    'tracker.track': void;

    'storage.get': string | null;
    'storage.set': void;
    'storage.remove': void;

    'trial.check': TrialStatus;
    'trial.recordBlock': TrialStatus;
    'trial.reset': void;
  }
}

declare module './protocol' {
  interface EventPayloadMap {
    userChange: PaywallUser;
    // INITIAL_SESSION в broadcast НЕ ходит: каждый RemoteAuthClient выдаёт
    // его сам через свой microtask поверх getCachedSession. Через wire летят
    // только реальные переходы (SIGNED_IN/SIGNED_OUT/TOKEN_REFRESHED/...).
    authChange: { event: AuthChangeEvent; session: AuthSession | null };
    balancesChange: ReadonlyArray<Balance>;
  }
}

// Suppress unused — этот тип существует чтобы зафиксировать контракт wire-протокола
// для consumer'ов из content/offscreen, не для прямого импорта здесь.
export type _PriceUnused = PaywallPrice;
