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

    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set('X-SDK-Version', SDK_VERSION);
    headers.set('X-Paywall-Id', this.opts.paywallId);

    if (this.opts.capabilities?.length) {
      headers.set('X-SDK-Capabilities', this.opts.capabilities.join(','));
    }

    const token = await this.opts.getAuthToken?.();
    if (token) headers.set('Authorization', `Bearer ${token}`);

    // FormData/Blob/URLSearchParams require the browser to set the Content-Type
    // itself (multipart with a boundary, x-www-form-urlencoded). We apply the
    // default application/json only for ordinary bodies (JSON strings).
    const isFormBody =
      typeof FormData !== 'undefined' && init.body instanceof FormData;
    if (init.body && !headers.has('Content-Type') && !isFormBody) {
      headers.set('Content-Type', 'application/json');
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
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

    const ct = response.headers.get('content-type') ?? '';
    const isJson = ct.includes('application/json');
    const payload: unknown = isJson ? await response.json().catch((): null => null) : null;

    if (!response.ok) {
      const code =
        (payload && typeof payload === 'object' && 'code' in payload && String(payload.code)) ||
        `http_${response.status}`;
      const message =
        (payload && typeof payload === 'object' && 'message' in payload && String(payload.message)) ||
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
