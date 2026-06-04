// Wire protocol for communication between content-script ↔ service worker ↔
// offscreen.
//
// Design goals:
//  1. Typed request/response — each BillingClient/AuthClient method has its own
//     `kind` with JSON-serializable params and result.
//  2. Push events (broadcast) — onUserChange/onAuthChange/track results fly from
//     offscreen to all connected content-scripts without a request.
//  3. Reconnection-friendly — every message is self-contained (no shared state
//     in the port that breaks when the SW dies). Only request_id for matching.
//  4. Errors as data — PaywallError is serialized to flat JSON, content
//     reconstructs it on its side (instanceof works).
//
// The transport under the hood is chrome.runtime.connect (a long-lived port).
// Route: content_script → SW (forwarder) → offscreen. The SW holds no state, it
// only maps the content↔offscreen ports and spins up offscreen if it's dead.

/** Protocol version — bumped on breaking changes to the wire format. The SW
 *  compares versions during the handshake and refuses to route if they diverge
 *  (the extension and SDK weren't updated at the same time). */
export const PROTOCOL_VERSION = 1 as const;

// === Request/Response ===

/** Cancel message: the client sent cancel(id), the server looks up the matching
 *  AbortController among the active requests and aborts it. Has no response —
 *  fire-and-forget. */
export interface CancelEnvelope {
  type: 'cancel';
  id: string;
}

export type RequestKind =
  // BillingClient
  | 'billing.bootstrap'
  | 'billing.getCachedBootstrap'
  | 'billing.getUser'
  | 'billing.getCachedUser'
  | 'billing.getBalances'
  | 'billing.getCachedBalances'
  | 'billing.createCheckout'
  | 'billing.listPurchases'
  | 'billing.cancelSubscription'
  | 'billing.getIdentity'
  | 'billing.setIdentity'
  | 'billing.getVisitorId'
  | 'billing.createSupportTicket'
  // AuthClient
  | 'auth.signInWithEmail'
  | 'auth.signUp'
  | 'auth.signOut'
  | 'auth.getCachedSession'
  | 'auth.refresh'
  | 'auth.requestPasswordReset'
  | 'auth.updatePassword'
  | 'auth.sendOtp'
  | 'auth.verifyOtp'
  | 'auth.resendConfirmation'
  | 'auth.revokeAllSessions'
  | 'auth.oauthStart'
  | 'auth.oauthExchange'
  | 'auth.getAccessToken'
  | 'auth.signInAnonymously'
  | 'auth.getLastLogin'
  // EventTracker
  | 'tracker.track'
  // Storage proxy — for consumers that want single-source-of-truth storage
  // through `billing.getStorage()`. The offscreen localStorage is shared across
  // all content-scripts.
  | 'storage.get'
  | 'storage.set'
  | 'storage.remove'
  // Trial-store — atomic read-modify-write in offscreen (via navigator.locks).
  // An alternative path to the storage-proxy: instead of two independent get+set
  // operations, recordBlock does them atomically in a single RPC.
  | 'trial.check'
  | 'trial.recordBlock'
  | 'trial.reset'
  // Internal
  | 'handshake'
  | 'subscribe'
  | 'unsubscribe';

export interface RequestEnvelope<P = unknown> {
  type: 'request';
  id: string;
  kind: RequestKind;
  params: P;
}

export interface ResponseOk<R = unknown> {
  type: 'response';
  id: string;
  ok: true;
  result: R;
}

export interface ResponseErr {
  type: 'response';
  id: string;
  ok: false;
  error: SerializedError;
}

export type ResponseEnvelope<R = unknown> = ResponseOk<R> | ResponseErr;

// === Events (broadcast) ===

export type EventKind =
  | 'userChange'      // billing.onUserChange tick
  | 'authChange'      // auth.onAuthChange tick
  | 'balancesChange'; // balance refresh broadcast

export interface EventEnvelope<P = unknown> {
  type: 'event';
  kind: EventKind;
  payload: P;
}

// === Errors as data ===

/** A flat snapshot of PaywallError that survives structured cloning. The
 *  reconstruct happens in RemoteBillingClient via `new PaywallError(...)` — so
 *  that the host's `error instanceof PaywallError` works as usual. */
export interface SerializedError {
  name: string;
  code: string;
  message: string;
  status?: number;
  /** Stack from offscreen — for debugging in the content-script's DevTools. */
  stack?: string;
}

// === Discriminated union ===

export type Envelope =
  | RequestEnvelope
  | ResponseEnvelope
  | EventEnvelope
  | CancelEnvelope;

// === Type helpers ===

export type RequestParams<K extends RequestKind> =
  K extends keyof RequestParamsMap ? RequestParamsMap[K] : unknown;

export type RequestResult<K extends RequestKind> =
  K extends keyof RequestResultMap ? RequestResultMap[K] : unknown;

export type EventPayload<K extends EventKind> =
  K extends keyof EventPayloadMap ? EventPayloadMap[K] : unknown;

// The params/result/payload maps for each RequestKind/EventKind are filled in
// in messages.ts — there they're bound to concrete types from @sdk/core/types
// (PaywallBootstrap, etc.). Here is only the generic skeleton, without an
// import-cycle on the UI package.
export interface RequestParamsMap {}
export interface RequestResultMap {}
export interface EventPayloadMap {}
