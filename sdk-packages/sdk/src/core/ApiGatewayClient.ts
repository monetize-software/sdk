import { SDK_VERSION } from './api';
import type { AuthClient } from './auth';
import {
  createDeadline,
  errorName,
  OriginResolver,
  runWithFailover
} from './edge';
import { type Balance, PaywallError, QuotaExceededError } from './types';

// ApiGatewayClient — the SDK 3.0 client for the metered AI proxy
// `/api/v1/api-gateway/<provider_id>[/<path>]?paywall_id=<id>`.
//
// Its responsibility is narrow:
//   - proxy the request with the correct headers (Bearer, X-Paywall-Id);
//   - on 402, parse the details and throw QuotaExceededError;
//   - on success, trigger the callback (BillingClient decrements the local balance);
//   - return the RAW Response so the caller decides — JSON, SSE, multipart.
//
// There is deliberately no SSE parser or JSON wrappers — they would drag bytes
// into the bundle. The caller uses `res.body.getReader()` or
// `for await (const c of res.body)` for streaming, `res.json()`/`res.text()`
// for the rest. This matches how fetch works — no custom API to learn.

export interface ApiGatewayClientOptions {
  paywallId: string;
  /** Origin of the SDK server API — required, the same `custom_domain` as in
   *  BillingClient/AuthClient. See {@link BillingClientOptions.apiOrigin}. */
  apiOrigin: string;
  /** AuthClient — Bearer is added automatically. On a 401 from the gateway the
   *  client forces one token rotation via auth.refresh() and replays the
   *  request once (the lazy refresh in getAccessToken can't see a session
   *  revoked server-side). Stream bodies can't be replayed — they skip the
   *  retry and the 401 surfaces to the caller. */
  auth?: AuthClient;
  /** Headless scenario or legacy flow: explicit userId instead of Bearer.
   *  Sent as `X-User-ID`. If both this and `auth` are set, Bearer wins. */
  userId?: string;
  capabilities?: string[];
  fetch?: typeof fetch;
  /** Mirror-origin failover, same contract as
   *  {@link BillingClientOptions.edgeFallback}. The discovered sticky state is
   *  shared in-memory with BillingClient/AuthClient of the same apiOrigin (no
   *  storage here — this client is stateless). */
  edgeFallback?: false | string;
  /** Hook for the optimistic balance decrement in BillingClient.
   *  ApiGatewayClient calls it on 200 (success), passing the queryType from the
   *  response (if the backend sent it in `X-Query-Type`) or undefined.
   *  ApiGatewayClient can NOT parse the body to extract queryType — that would
   *  be an extra read of the body, and crucially the body may be a stream. */
  onChargeSuccess?: (queryType: string | undefined) => void;
  /** Hook for refetching balances after a 402. BillingClient hits /balances
   *  and updates state so the UI shows the current counter. */
  onQuotaExceeded?: (err: QuotaExceededError) => void;
}

export interface ApiGatewayCallParams {
  /** UUID of the api provider from the platform (`paywall_internal_api_providers.id`). */
  providerId: string;
  /** Path after the provider: `v1/chat/completions`, `messages`, etc.
   *  Concatenated with `/`. Empty string/undefined = provider root. */
  path?: string;
  method?: 'GET' | 'POST';
  /** A JSON-serializable object → application/json. FormData → multipart with
   *  an auto-boundary. ReadableStream/Blob/string — passed through as-is.
   *  If undefined and method='POST' — an empty body is sent. */
  body?: unknown;
  /** Additional headers. They override ours, except Authorization (always set
   *  from auth) and X-Paywall-Id. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export class ApiGatewayClient {
  readonly paywallId: string;
  readonly apiOrigin: string;
  private auth: AuthClient | undefined;
  private userId: string | undefined;
  private capabilities: string[] | undefined;
  private customFetch: typeof fetch | undefined;
  private onChargeSuccess:
    ((queryType: string | undefined) => void) | undefined;
  private onQuotaExceeded: ((err: QuotaExceededError) => void) | undefined;
  private resolver: OriginResolver;

  constructor(opts: ApiGatewayClientOptions) {
    if (!opts.paywallId) {
      throw new PaywallError('invalid_config', 'paywallId is required');
    }
    if (!opts.apiOrigin) {
      throw new PaywallError(
        'invalid_config',
        'apiOrigin is required. Pass the paywall custom_domain configured in the platform.'
      );
    }
    this.paywallId = opts.paywallId;
    this.apiOrigin = opts.apiOrigin;
    this.auth = opts.auth;
    this.userId = opts.userId;
    this.capabilities = opts.capabilities;
    this.customFetch = opts.fetch;
    this.onChargeSuccess = opts.onChargeSuccess;
    this.onQuotaExceeded = opts.onQuotaExceeded;
    this.resolver = new OriginResolver({
      apiOrigin: this.apiOrigin,
      edgeFallback: opts.edgeFallback
    });
    // Security: in the browser userId must come from Bearer (the backend
    // resolves it via GoTrue), not be passed explicitly — otherwise the host
    // could slip in someone else's ID. `auth` without `userId` is normal;
    // `userId` without `auth` in the browser is a potential vulnerability, so we warn.
    if (
      opts.userId &&
      !opts.auth &&
      typeof window !== 'undefined' &&
      typeof (window as { document?: unknown }).document !== 'undefined'
    ) {
      console.warn(
        '[paywall] WARNING: ApiGatewayClient.userId set without auth in browser. ' +
          'Client can spoof userId. Use AuthClient + Bearer for trusted user.id.'
      );
    }
  }

  async call(params: ApiGatewayCallParams): Promise<Response> {
    const path = params.path ? params.path.replace(/^\/+/, '') : '';
    const buildUrl = (origin: string): string => {
      const url = new URL(
        `/api/v1/api-gateway/${encodeURIComponent(params.providerId)}${path ? `/${path}` : ''}`,
        origin
      );
      // We send paywall_id both in the query (legacy v2 contract) and in the
      // X-Paywall-Id header (SDK 3.0 contract). The backend route accepts both after the patch.
      url.searchParams.set('paywall_id', this.paywallId);
      return url.toString();
    };

    const headers = new Headers(params.headers);
    headers.set('X-SDK-Version', SDK_VERSION);
    headers.set('X-Paywall-Id', this.paywallId);
    if (this.capabilities?.length) {
      headers.set('X-SDK-Capabilities', this.capabilities.join(','));
    }

    const token = await this.auth?.getAccessToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    } else if (this.userId) {
      headers.set('X-User-ID', this.userId);
    }

    // Content-Type: same approach as in ApiClient. FormData — the browser sets it.
    // unknown body, not string/FormData/Blob — JSON.stringify.
    const isFormData =
      typeof FormData !== 'undefined' && params.body instanceof FormData;
    const isBlob = typeof Blob !== 'undefined' && params.body instanceof Blob;
    const isStream =
      typeof ReadableStream !== 'undefined' &&
      params.body instanceof ReadableStream;
    const isString = typeof params.body === 'string';

    let body: BodyInit | undefined;
    if (params.body === undefined || params.body === null) {
      body = undefined;
    } else if (isFormData || isBlob || isStream || isString) {
      body = params.body as BodyInit;
    } else {
      body = JSON.stringify(params.body);
      if (!headers.has('Content-Type'))
        headers.set('Content-Type', 'application/json');
    }

    // Local variable instead of `this.fetchImpl(...)` — native fetch requires
    // this=globalThis, and calling through an object field binds this to
    // ApiGatewayClient, making Chrome throw 'Illegal invocation'.
    const fetchImpl = this.customFetch ?? fetch;

    // No artificial deadline for the gateway — unlike ApiClient (paywall API)
    // this is the metered AI proxy: time-to-first-byte is legitimately long and
    // unbounded (provider selection/fallbacks, reasoning, tool loops), so ANY
    // finite hedge would falsely abort real streaming calls. The only deadline
    // is the caller's own AbortSignal, which keeps the dedicated 'aborted' code
    // (never retried — replaying an intentionally cancelled AI call would
    // double-charge). Failover therefore happens only on hard connect-level
    // errors (fetch rejects before any response); blocked-network users still
    // reach the mirror because the sticky state discovered by BillingClient's
    // lightweight requests routes gateway calls edge-first.
    const doFetch = async (target: string): Promise<Response> => {
      const deadline = createDeadline(params.signal);
      try {
        return await fetchImpl(target, {
          method: params.method ?? 'POST',
          headers,
          body,
          signal: deadline.signal,
          credentials: 'omit'
        });
      } catch (cause) {
        if (errorName(cause) === 'AbortError') {
          throw new PaywallError('aborted', 'Request aborted', { cause });
        }
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new PaywallError(
          'network_error',
          `Network request failed: ${detail}`,
          { cause }
        );
      } finally {
        deadline.dispose();
      }
    };

    // Mirror-origin failover (see core/edge.ts): try candidates in sticky
    // order, move on only on connect-level failures. A stream body is consumed
    // by the first send and can't be replayed — it gets a single attempt at
    // the preferred origin, exactly like the pre-edge behavior.
    const response = await runWithFailover(
      this.resolver,
      async (origin) => {
        const target = buildUrl(origin);
        let res = await doFetch(target);

        // Dead-session recovery, mirrors ApiClient: a 401 with a Bearer
        // attached means the server rejected a token the client still
        // considered fresh (revoked in another context / GoTrue family
        // revocation). Force one rotation and replay ON THE SAME ORIGIN (it
        // is reachable — it just answered). refresh() dedupes in-flight
        // calls, on its own 401 clears the session and returns null (no
        // retry), on network/5xx throws — swallowed, the original 401
        // surfaces. Stream bodies are consumed by the first send and can't
        // be replayed — no retry for them.
        if (res.status === 401 && token && this.auth && !isStream) {
          const fresh = await this.auth
            .refresh()
            .then((s) => s?.access_token ?? null)
            .catch((): null => null);
          if (fresh && fresh !== token) {
            headers.set('Authorization', `Bearer ${fresh}`);
            res = await doFetch(target);
          }
        }
        return res;
      },
      { firstOnly: isStream }
    );

    if (response.status === 402) {
      const err = await parseQuotaError(response);
      this.onQuotaExceeded?.(err);
      throw err;
    }

    if (!response.ok) {
      // We don't drain the body — the caller may try `res.text()` itself, or
      // we clone for parsing. We parse the clone to return the original untouched
      // (important for streaming responses; for JSON errors clone() is cheap).
      const code = await tryReadErrorCode(response.clone());
      throw new PaywallError(
        code ?? `http_${response.status}`,
        response.statusText || 'Gateway request failed',
        { status: response.status }
      );
    }

    // The charge happened on the backend (see /api-gateway/route.ts: `if (queryType !== 'free')`).
    // The backend doesn't return an updated balance in the headers — we decrement
    // optimistically on the client. queryType comes from X-Query-Type if the backend set it;
    // otherwise the hook gets undefined and BillingClient re-fetches /balances.
    const queryType = response.headers.get('X-Query-Type') ?? undefined;
    this.onChargeSuccess?.(queryType);

    return response;
  }
}

interface QuotaErrorBody {
  error?: string;
  details?: {
    balances?: Array<{ balances?: Balance[] } | Balance[] | unknown>;
    queryType?: string;
    currentBalance?: Balance | null;
  };
}

async function parseQuotaError(
  response: Response
): Promise<QuotaExceededError> {
  let body: QuotaErrorBody = {};
  try {
    body = (await response.json()) as QuotaErrorBody;
  } catch {
    /* malformed — we'll return empty fields */
  }

  // The backend returns `details.balances` as an array of paywall_balances rows:
  // [{ balances: Balance[] }] (see the supabase select). We extract the flat array.
  const rawBalances = body.details?.balances;
  let balances: Balance[] = [];
  if (Array.isArray(rawBalances)) {
    const first = rawBalances[0] as
      { balances?: Balance[] } | Balance[] | undefined;
    if (Array.isArray(first)) {
      balances = first as Balance[];
    } else if (
      first &&
      Array.isArray((first as { balances?: Balance[] }).balances)
    ) {
      balances = (first as { balances: Balance[] }).balances;
    }
  }

  return new QuotaExceededError({
    balances,
    queryType: body.details?.queryType ?? '',
    currentBalance: body.details?.currentBalance ?? null
  });
}

async function tryReadErrorCode(response: Response): Promise<string | null> {
  const ct = response.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) return null;
  try {
    const data = (await response.json()) as { error?: string; code?: string };
    return data.code || data.error || null;
  } catch {
    return null;
  }
}
