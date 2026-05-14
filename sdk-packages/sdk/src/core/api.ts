import { PaywallError } from './types';

export const SDK_VERSION = '3.0.0-alpha.0';

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

    // FormData/Blob/URLSearchParams требуют, чтобы браузер сам назначил
    // Content-Type (multipart с boundary, x-www-form-urlencoded). Дефолт
    // application/json применяем только для обычных body (JSON-строки).
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
      // AbortError — отдельный код, чтобы host мог отличить «юзер закрыл
      // модалку» от реальной сетевой проблемы. DOMException не всегда
      // instanceof Error в edge runtimes (Cloudflare Workers); проверяем
      // через duck-typed `.name`.
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
      // payload в cause — выше по стеку (BillingClient/AuthClient) могут читать
      // структурные поля из тела ошибки (например `hasActivePurchase: true`
      // от /start-checkout 409) и менять обработку.
      throw new PaywallError(code, message, { status: response.status, cause: payload });
    }

    return payload as T;
  }
}
