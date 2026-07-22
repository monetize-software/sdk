import { PaywallError } from './types';
import { version } from '../../package.json';
import {
  EDGE_BODY_TIMEOUT_MS,
  EDGE_FINAL_TIMEOUT_MS,
  EDGE_HEDGE_TIMEOUT_MS,
  createDeadline,
  errorName,
  OriginResolver,
  runWithFailover
} from './edge';
import type { StorageAdapter } from './storage';

// Версия читается из package.json (resolveJsonModule), а не хардкодится литералом —
// иначе протухает (раньше торчал '3.0.0-alpha.0' через все релизы и засорял
// аналитику в ClickHouse одной версией). Обычный import, а не build-time define:
// sdk-extension/sdk-react бандлят ИСХОДНИК sdk (alias @sdk → ../sdk/src), а define
// пер-пакетный и до них не доходит. Import же резолвит любой tsc/бандлер.
export const SDK_VERSION: string = version;

export interface ApiRequestInit extends RequestInit {
  /**
   * May the edge failover REPLAY this request on the mirror after the primary
   * origin already answered (headers received, then the body died)? At that
   * point the server has processed the request — a replay re-executes it, so
   * only idempotent requests may opt in. Default: true for GET/HEAD
   * (idempotent by contract), false for everything else. Idempotent POST
   * reads (bootstrap, user-state, balances) set this explicitly.
   *
   * Connect-level failures (nothing reached the server) always fail over
   * regardless of this flag.
   */
  replayable?: boolean;
}

export interface ApiClientOptions {
  apiOrigin: string;
  paywallId: string;
  getAuthToken?: () => string | null | Promise<string | null>;
  /**
   * One-shot recovery for a Bearer the server no longer accepts. Called when a
   * request that carried an Authorization header got a 401: the session looked
   * fresh locally (getAuthToken returned a token) but was revoked server-side
   * (refresh-rotation race in another context, GoTrue family revocation, clock
   * skew). Must force a token refresh and return the new access_token — the
   * request is then retried once — or null when recovery is impossible (the
   * refresh itself got a 401 and the session was cleared); the original 401
   * error is thrown to the caller in that case.
   */
  onUnauthorized?: () => Promise<string | null>;
  capabilities?: string[];
  fetch?: typeof fetch;
  /** Mirror-origin failover for blocked networks (see core/edge.ts). Default:
   *  `edge.<host>` derived from apiOrigin. Pass an origin to override the
   *  convention, false to disable. */
  edgeFallback?: false | string;
  /** Persists the sticky failover choice across sessions (optional). */
  storage?: StorageAdapter;
}

export class ApiClient {
  private opts: ApiClientOptions;
  private resolver: OriginResolver;

  constructor(opts: ApiClientOptions) {
    this.opts = opts;
    this.resolver = new OriginResolver({
      apiOrigin: opts.apiOrigin,
      edgeFallback: opts.edgeFallback,
      storage: opts.storage
    });
  }

  /** Origin the client currently talks to: apiOrigin, or the edge mirror
   *  after a network-level failover. For building sibling URLs off the same
   *  reachable host (the analytics endpoint). */
  activeOrigin(): string {
    return this.resolver.candidates()[0];
  }

  async request<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
    return runWithFailover(this.resolver, (origin, isLast, candidateCount) =>
      this.attempt<T>(origin, path, init, isLast, candidateCount)
    );
  }

  private async attempt<T>(
    origin: string,
    path: string,
    init: ApiRequestInit,
    isLast: boolean,
    candidateCount: number
  ): Promise<T> {
    const url = new URL(path, origin).toString();
    const fetchImpl = this.opts.fetch ?? fetch;
    const failoverActive = candidateCount > 1;

    const method = (init.method ?? 'GET').toUpperCase();
    // FormData/Blob/URLSearchParams require the browser to set the Content-Type
    // itself (multipart with a boundary, x-www-form-urlencoded).
    const isFormBody =
      typeof FormData !== 'undefined' && init.body instanceof FormData;
    // Post-headers replay eligibility — see ApiRequestInit.replayable.
    const replayable =
      init.replayable ?? (method === 'GET' || method === 'HEAD');

    // Phased deadlines, failover-only (single-candidate setups keep the
    // pre-edge unbounded behavior):
    //  - connect+headers: the hedge. fetch resolves only after the request
    //    body is uploaded, so the hedge also bounds uploads — which is why
    //    FormData (files on slow links) is exempt and relies on connect-level
    //    errors plus the sticky state for its failover.
    //  - body read: its own generous deadline, armed once headers arrive.
    //    Bounds the DPI mid-body stall without killing a legitimately slow
    //    response at the 5s hedge.
    const headersTimeoutMs =
      failoverActive && !isFormBody
        ? isLast
          ? EDGE_FINAL_TIMEOUT_MS
          : EDGE_HEDGE_TIMEOUT_MS
        : null;
    const bodyTimeoutMs = failoverActive ? EDGE_BODY_TIMEOUT_MS : null;

    // eager: the body deadline is armed AFTER fetch started — the controller
    // must already be the signal fetch received (see createDeadline).
    const deadline = createDeadline(init.signal, {
      eager: headersTimeoutMs != null || bodyTimeoutMs != null
    });

    // The line between "safe to replay on the mirror" (the request never
    // produced a response — it did not reach the server, or died mid-upload
    // and cannot have been parsed) and "the origin has processed it" (any
    // headers came back). Reset before the 401 replay: a 401 response means
    // the operation was rejected, not executed.
    let headersReceived = false;

    // Our own deadline is a retryable network failure; a caller abort keeps
    // the dedicated code so the host can distinguish "the user closed the
    // modal" from a real network problem.
    const mapAbort = (cause: unknown): PaywallError =>
      deadline.timedOut()
        ? networkError('Request deadline exceeded', cause)
        : new PaywallError('aborted', 'Request aborted', { cause });

    const networkError = (message: string, cause: unknown): PaywallError =>
      new PaywallError('network_error', message, {
        cause,
        // Post-headers failure of a non-idempotent request must NOT move to
        // the mirror: the origin already executed it, a replay would run the
        // side effect twice (duplicate ticket / double token adjustment).
        originRetryable: headersReceived ? replayable : true
      });

    try {
      // The whole send is a closure over (init, url) so the 401-recovery below
      // can replay it with a fresh Bearer. Each send re-arms a fresh headers
      // deadline — the recovery (refresh + replay) is not squeezed into the
      // remainder of the first send's hedge budget.
      const send = async (bearer: string | null): Promise<Response> => {
        const headers = new Headers(init.headers);
        headers.set('Accept', 'application/json');
        headers.set('X-SDK-Version', SDK_VERSION);
        headers.set('X-Paywall-Id', this.opts.paywallId);

        if (this.opts.capabilities?.length) {
          headers.set('X-SDK-Capabilities', this.opts.capabilities.join(','));
        }

        if (bearer) headers.set('Authorization', `Bearer ${bearer}`);

        // Default application/json only for ordinary bodies (JSON strings) —
        // the browser owns the Content-Type for form bodies.
        if (init.body && !headers.has('Content-Type') && !isFormBody) {
          headers.set('Content-Type', 'application/json');
        }

        deadline.arm(headersTimeoutMs);
        try {
          const response = await fetchImpl(url, {
            ...init,
            headers,
            signal: deadline.signal,
            credentials: 'omit'
          });
          headersReceived = true;
          return response;
        } catch (cause) {
          if (errorName(cause) === 'AbortError') throw mapAbort(cause);
          throw networkError('Network request failed', cause);
        } finally {
          deadline.disarm();
        }
      };

      // Token is resolved PER ATTEMPT, not once per request: after a failover
      // the previous origin's 401-recovery may have rotated the session — the
      // mirror attempt must pick up the fresh Bearer, not replay the stale one.
      const token = (await this.opts.getAuthToken?.()) ?? null;
      let response = await send(token);

      // 401 with a Bearer attached = the server rejected a session the client
      // still considered fresh (isFresh passes by local expires_at, but the token
      // was revoked server-side). onUnauthorized forces one rotation attempt and
      // the request is retried with the new token. Exactly one retry: a second
      // 401 means the fresh token is also rejected — retrying can't fix that.
      // onUnauthorized returning null (refresh 401 → session already cleared) or
      // throwing (network) → fall through and surface the original 401.
      // The refresh round-trip runs on AuthClient's own ApiClient (its own
      // deadline); our timer is disarmed for its duration by send()'s finally.
      if (response.status === 401 && token && this.opts.onUnauthorized) {
        const fresh = await this.opts.onUnauthorized().catch((): null => null);
        if (fresh && fresh !== token) {
          // The 401 rejected the operation without executing it — a replay
          // (even on another origin later) starts from a clean slate.
          headersReceived = false;
          response = await send(fresh);
        }
      }

      // Headers are in — swap the hedge for the body-read deadline.
      deadline.arm(bodyTimeoutMs);

      const ct = response.headers.get('content-type') ?? '';
      const isJson = ct.includes('application/json');
      let payload: unknown = null;
      if (isJson) {
        try {
          payload = await response.json();
        } catch (cause) {
          // A rejected body read is NOT "invalid JSON". A connection killed
          // mid-body (the DPI ~16KB cut, a dropped link) rejects with
          // TypeError/AbortError, while real malformed JSON rejects with
          // SyntaxError. Only the latter keeps the legacy null-payload
          // tolerance — the former must surface as a network failure,
          // otherwise a truncated 200 becomes a silent null success.
          const isSyntax =
            cause instanceof SyntaxError || errorName(cause) === 'SyntaxError';
          if (!isSyntax) {
            if (errorName(cause) === 'AbortError') throw mapAbort(cause);
            throw networkError('Response body read failed', cause);
          }
        }
      }

      if (!response.ok) {
        const body =
          payload && typeof payload === 'object'
            ? (payload as Record<string, unknown>)
            : null;
        // Error contract is {code, message}, but several backend routes reply
        // with {error: 'invalid_token'} — accept a slug-shaped `error` as the
        // code, so analytics records `invalid_token` instead of an opaque
        // `http_401`. A human sentence in `error` ("Invalid successUrl format…")
        // is a message, not a code — it goes into the message fallback chain.
        const errorField =
          body && typeof body.error === 'string' ? body.error : null;
        const errorIsSlug =
          !!errorField && /^[a-z0-9_.-]{1,64}$/i.test(errorField);
        const code =
          (body && 'code' in body && body.code != null && String(body.code)) ||
          (errorIsSlug ? errorField : null) ||
          `http_${response.status}`;
        const message =
          (body &&
            'message' in body &&
            body.message != null &&
            String(body.message)) ||
          (errorField && !errorIsSlug ? errorField : null) ||
          response.statusText ||
          'Request failed';
        // payload in cause — higher up the stack (BillingClient/AuthClient) can
        // read structural fields from the error body (e.g. `hasActivePurchase: true`
        // from /start-checkout 409) and change handling.
        throw new PaywallError(code, message, {
          status: response.status,
          cause: payload
        });
      }

      return payload as T;
    } finally {
      deadline.dispose();
    }
  }
}
