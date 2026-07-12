import { PaywallError } from './types';
import { version } from '../../package.json';

// Версия читается из package.json (resolveJsonModule), а не хардкодится литералом —
// иначе протухает (раньше торчал '3.0.0-alpha.0' через все релизы и засорял
// аналитику в ClickHouse одной версией). Обычный import, а не build-time define:
// sdk-extension/sdk-react бандлят ИСХОДНИК sdk (alias @sdk → ../sdk/src), а define
// пер-пакетный и до них не доходит. Import же резолвит любой tsc/бандлер.
export const SDK_VERSION: string = version;

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
}

export class ApiClient {
  private opts: ApiClientOptions;

  constructor(opts: ApiClientOptions) {
    this.opts = opts;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(path, this.opts.apiOrigin).toString();
    const fetchImpl = this.opts.fetch ?? fetch;

    // The whole send is a closure over (init, url) so the 401-recovery below can
    // replay it with a fresh Bearer. Safe to replay: the SDK only sends string
    // bodies and FormData, both re-serializable (no one-shot streams).
    const send = async (token: string | null): Promise<Response> => {
      const headers = new Headers(init.headers);
      headers.set('Accept', 'application/json');
      headers.set('X-SDK-Version', SDK_VERSION);
      headers.set('X-Paywall-Id', this.opts.paywallId);

      if (this.opts.capabilities?.length) {
        headers.set('X-SDK-Capabilities', this.opts.capabilities.join(','));
      }

      if (token) headers.set('Authorization', `Bearer ${token}`);

      // FormData/Blob/URLSearchParams require the browser to set the Content-Type
      // itself (multipart with a boundary, x-www-form-urlencoded). We apply the
      // default application/json only for ordinary bodies (JSON strings).
      const isFormBody =
        typeof FormData !== 'undefined' && init.body instanceof FormData;
      if (init.body && !headers.has('Content-Type') && !isFormBody) {
        headers.set('Content-Type', 'application/json');
      }

      try {
        return await fetchImpl(url, {
          ...init,
          headers,
          credentials: 'omit'
        });
      } catch (cause) {
        // AbortError — a separate code so the host can distinguish "the user closed
        // the modal" from a real network problem. DOMException isn't always
        // instanceof Error in edge runtimes (Cloudflare Workers); we check via the
        // duck-typed `.name`.
        const name =
          cause && typeof cause === 'object' && 'name' in cause
            ? (cause as { name: unknown }).name
            : undefined;
        if (name === 'AbortError') {
          throw new PaywallError('aborted', 'Request aborted', { cause });
        }
        throw new PaywallError('network_error', 'Network request failed', { cause });
      }
    };

    const token = (await this.opts.getAuthToken?.()) ?? null;
    let response = await send(token);

    // 401 with a Bearer attached = the server rejected a session the client
    // still considered fresh (isFresh passes by local expires_at, but the token
    // was revoked server-side). onUnauthorized forces one rotation attempt and
    // the request is retried with the new token. Exactly one retry: a second
    // 401 means the fresh token is also rejected — retrying can't fix that.
    // onUnauthorized returning null (refresh 401 → session already cleared) or
    // throwing (network) → fall through and surface the original 401.
    if (response.status === 401 && token && this.opts.onUnauthorized) {
      const fresh = await this.opts.onUnauthorized().catch((): null => null);
      if (fresh && fresh !== token) {
        response = await send(fresh);
      }
    }

    const ct = response.headers.get('content-type') ?? '';
    const isJson = ct.includes('application/json');
    const payload: unknown = isJson ? await response.json().catch((): null => null) : null;

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
      const errorField = body && typeof body.error === 'string' ? body.error : null;
      const errorIsSlug = !!errorField && /^[a-z0-9_.-]{1,64}$/i.test(errorField);
      const code =
        (body && 'code' in body && body.code != null && String(body.code)) ||
        (errorIsSlug ? errorField : null) ||
        `http_${response.status}`;
      const message =
        (body && 'message' in body && body.message != null && String(body.message)) ||
        (errorField && !errorIsSlug ? errorField : null) ||
        response.statusText ||
        'Request failed';
      // payload in cause — higher up the stack (BillingClient/AuthClient) can
      // read structural fields from the error body (e.g. `hasActivePurchase: true`
      // from /start-checkout 409) and change handling.
      throw new PaywallError(code, message, { status: response.status, cause: payload });
    }

    return payload as T;
  }
}
