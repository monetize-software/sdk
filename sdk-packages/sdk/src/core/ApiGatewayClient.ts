import { SDK_VERSION } from './api';
import type { AuthClient } from './auth';
import {
  type Balance,
  PaywallError,
  QuotaExceededError
} from './types';

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
   *  client does not refresh: AuthClient already did a lazy refresh in getAccessToken. */
  auth?: AuthClient;
  /** Headless scenario or legacy flow: explicit userId instead of Bearer.
   *  Sent as `X-User-ID`. If both this and `auth` are set, Bearer wins. */
  userId?: string;
  capabilities?: string[];
  fetch?: typeof fetch;
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
  private onChargeSuccess: ((queryType: string | undefined) => void) | undefined;
  private onQuotaExceeded: ((err: QuotaExceededError) => void) | undefined;

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
    const url = new URL(
      `/api/v1/api-gateway/${encodeURIComponent(params.providerId)}${path ? `/${path}` : ''}`,
      this.apiOrigin
    );
    // We send paywall_id both in the query (legacy v2 contract) and in the
    // X-Paywall-Id header (SDK 3.0 contract). The backend route accepts both after the patch.
    url.searchParams.set('paywall_id', this.paywallId);

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
    const isFormData = typeof FormData !== 'undefined' && params.body instanceof FormData;
    const isBlob = typeof Blob !== 'undefined' && params.body instanceof Blob;
    const isStream =
      typeof ReadableStream !== 'undefined' && params.body instanceof ReadableStream;
    const isString = typeof params.body === 'string';

    let body: BodyInit | undefined;
    if (params.body === undefined || params.body === null) {
      body = undefined;
    } else if (isFormData || isBlob || isStream || isString) {
      body = params.body as BodyInit;
    } else {
      body = JSON.stringify(params.body);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    }

    // Local variable instead of `this.fetchImpl(...)` — native fetch requires
    // this=globalThis, and calling through an object field binds this to
    // ApiGatewayClient, making Chrome throw 'Illegal invocation'.
    const fetchImpl = this.customFetch ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: params.method ?? 'POST',
        headers,
        body,
        signal: params.signal,
        credentials: 'omit'
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new PaywallError('network_error', `Network request failed: ${detail}`, { cause });
    }

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

async function parseQuotaError(response: Response): Promise<QuotaExceededError> {
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
    const first = rawBalances[0] as { balances?: Balance[] } | Balance[] | undefined;
    if (Array.isArray(first)) {
      balances = first as Balance[];
    } else if (first && Array.isArray((first as { balances?: Balance[] }).balances)) {
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
