// Wire-protocol для коммуникации content-script ↔ service worker ↔ offscreen.
//
// Дизайн-цели:
//  1. Типизированный request/response — каждый метод BillingClient/AuthClient
//     имеет свой `kind` с JSON-сериализуемыми params и result.
//  2. Push-события (broadcast) — onUserChange/onAuthChange/track-результаты
//     летят от offscreen ко всем подключённым content-script'ам без request'а.
//  3. Reconnection-friendly — каждое сообщение самодостаточно (нет shared state
//     в port'е, который ломается при смерти SW). Только request_id для match'а.
//  4. Errors как данные — PaywallError сериализуется в плоский JSON, content
//     reconstruct'ит на своей стороне (instanceof работает).
//
// Транспорт под капотом — chrome.runtime.connect (long-lived port). Маршрут:
// content_script → SW (forwarder) → offscreen. SW не хранит state, только
// мапит port'ы content↔offscreen и поднимает offscreen если тот мёртв.

/** Версия протокола — bump'аем при breaking changes wire-формата. SW сравнивает
 *  версии при handshake'е и отказывается маршрутить, если версии разъехались
 *  (extension и SDK обновлены не одновременно). */
export const PROTOCOL_VERSION = 1 as const;

// === Request/Response ===

/** Сообщение отмены: клиент послал cancel(id), сервер ищет соответствующий
 *  AbortController в активных запросах и abort'ит его. Не имеет ответа —
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
  // Storage proxy — для consumer'ов, которые через `billing.getStorage()`
  // хотят single-source-of-truth storage. Offscreen'овский localStorage
  // шарится между всеми content-script'ами.
  | 'storage.get'
  | 'storage.set'
  | 'storage.remove'
  // Trial-store — read-modify-write атомарно в offscreen (через navigator.locks).
  // Альтернативный путь к storage-proxy: вместо двух независимых операций
  // get+set, recordBlock делает их атомарно за один RPC.
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

/** Плоский снепшот PaywallError, который переживает structured cloning.
 *  Reconstruct происходит в RemoteBillingClient'е через `new PaywallError(...)` —
 *  чтобы у host'а `error instanceof PaywallError` работал как обычно. */
export interface SerializedError {
  name: string;
  code: string;
  message: string;
  status?: number;
  /** Stack из offscreen'а — для отладки в DevTools content-script'а. */
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

// Карты params/result/payload для каждого RequestKind/EventKind заполняются
// в messages.ts — там они привязаны к конкретным типам из @sdk/core/types
// (PaywallBootstrap и т.д.). Здесь только generic-каркас, без import-cycle
// на UI-пакет.
export interface RequestParamsMap {}
export interface RequestResultMap {}
export interface EventPayloadMap {}
