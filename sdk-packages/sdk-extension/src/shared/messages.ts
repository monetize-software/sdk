// Binding of RequestKind → params/result types from @sdk/core/types. Module
// augmentation of RequestParamsMap/RequestResultMap from protocol.ts — so the
// wire protocol knows that 'billing.bootstrap' returns a PaywallBootstrap, and
// TypeScript catches mismatches on the content and offscreen sides.
//
// If the shape in @sdk/core/types changes tomorrow — it goes red here right away.

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
    /** File objects survive chrome.runtime structured-clone through the ports
     *  (the SW forwards them as-is). Size limits (10MB/file, 5 files) are
     *  validated by the SDK before sending and by the backend again — both to
     *  avoid blowing up the SW heap under abuse. */
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
    /** OAuth split: content does /init through offscreen, gets the
     *  authorize_url and state. The state (together with the PKCE verifier)
     *  lives in offscreen until the second request. */
    'auth.oauthStart': {
      provider: OAuthProvider;
      scopes?: string;
      userMeta?: Record<string, string>;
      /** Skip the anon-upgrade linkIdentity path (no Bearer) → plain signin into
       *  the account that owns the identity. Set by the switch-account retry. */
      switchAccount?: boolean;
      /** Reuse an existing popup state for the in-place switch-account retry (the
       *  popup's window.name is pw-oauth-<state> and must keep matching). */
      reuseState?: string;
    };
    /** Exchange the code for a session. The state from the oauthStart resolution
     *  comes here — offscreen looks up the stored verifier by state. */
    'auth.oauthExchange': { state: string; code: string };
    /** The current access token (lazy-refreshable). content/popup calls this to
     *  pass the Bearer into external fetches (for example, ApiGatewayClient in
     *  the content-script). Returns null if logged out or the refresh failed. */
    'auth.getAccessToken': void;
    /** Anonymous sign-in through the offscreen AuthClient. `captchaToken` is
     *  optional — bootloaded for the future (when the server returns
     *  challenge_required and demands proof-of-something). The server doesn't
     *  check it yet, the field is reserved for forward-compat. `forceNewAnon`
     *  skips the idempotent + resume steps and goes straight to /signin (creates
     *  a new anon user — needed in the switch-account flow). */
    'auth.signInAnonymously': {
      captchaToken?: string;
      userMeta?: Record<string, string>;
      forceNewAnon?: boolean;
    };
    /** Last-used auth method + email per-paywall — for the "Last used" UI badge
     *  in AuthPanel. Storage lives in offscreen, read through transport. */
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
    // INITIAL_SESSION does NOT travel in the broadcast: each RemoteAuthClient
    // emits it itself via its own microtask on top of getCachedSession. Only
    // real transitions (SIGNED_IN/SIGNED_OUT/TOKEN_REFRESHED/...) go over the wire.
    authChange: { event: AuthChangeEvent; session: AuthSession | null };
    balancesChange: ReadonlyArray<Balance>;
  }
}

// Suppress unused — this type exists to pin down the wire-protocol contract for
// consumers from content/offscreen, not for direct import here.
export type _PriceUnused = PaywallPrice;
