import { SDK_VERSION } from './api';
import type { AuthClient } from './auth';
import {
  type Balance,
  PaywallError,
  QuotaExceededError
} from './types';

// ApiGatewayClient — клиент SDK 3.0 для метированного AI-прокси
// `/api/v1/api-gateway/<provider_id>[/<path>]?paywall_id=<id>`.
//
// Ответственность узкая:
//   - проксировать запрос с правильными хедерами (Bearer, X-Paywall-Id);
//   - на 402 распарсить детали и бросить QuotaExceededError;
//   - на success триггернуть колбек (BillingClient декрементит локальный балланс);
//   - вернуть СЫРОЙ Response, чтобы caller сам решал — JSON, SSE, multipart.
//
// SSE-парсера и JSON-обёрток сознательно нет — они тащат байты в bundle.
// Caller использует `res.body.getReader()` или `for await (const c of res.body)`
// для стрима, `res.json()`/`res.text()` для остального. Это совпадает с тем,
// как работает fetch — никакого кастомного API учить не надо.

const DEFAULT_API_ORIGIN = 'https://appbox.space';

export interface ApiGatewayClientOptions {
  paywallId: string;
  apiOrigin?: string;
  /** AuthClient — Bearer добавляется автоматически. На 401 от gateway клиент
   *  не делает refresh: AuthClient уже сделал lazy-refresh в getAccessToken. */
  auth?: AuthClient;
  /** Headless-сценарий или legacy-флоу: явный userId вместо Bearer.
   *  Передаётся как `X-User-ID`. Если задан и `auth` — Bearer выигрывает. */
  userId?: string;
  capabilities?: string[];
  fetch?: typeof fetch;
  /** Хук для оптимистичного декремента балансов в BillingClient.
   *  ApiGatewayClient его дёргает на 200 (success), передавая queryType из
   *  ответа (если бэк его прислал в `X-Query-Type`) или undefined.
   *  Парсить body для извлечения queryType ApiGatewayClient НЕ умеет — это
   *  было бы лишним чтением body, а главное — body может быть стримом. */
  onChargeSuccess?: (queryType: string | undefined) => void;
  /** Хук для рефетча балансов после 402. BillingClient ходит к /balances
   *  и обновляет state, чтобы UI показал актуальный счётчик. */
  onQuotaExceeded?: (err: QuotaExceededError) => void;
}

export interface ApiGatewayCallParams {
  /** UUID api-провайдера из платформы (`paywall_internal_api_providers.id`). */
  providerId: string;
  /** Путь после провайдера: `v1/chat/completions`, `messages`, и т.д.
   *  Конкатенируется через `/`. Пустая строка/undefined = root провайдера. */
  path?: string;
  method?: 'GET' | 'POST';
  /** JSON-сериализуемый объект → application/json. FormData → multipart с
   *  авто-boundary. ReadableStream/Blob/string — пробрасываются как есть.
   *  Если undefined и method='POST' — отправляется пустое тело. */
  body?: unknown;
  /** Дополнительные хедеры. Перетирают наши, кроме Authorization (его всегда
   *  ставим из auth) и X-Paywall-Id. */
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
    this.paywallId = opts.paywallId;
    this.apiOrigin = opts.apiOrigin ?? DEFAULT_API_ORIGIN;
    this.auth = opts.auth;
    this.userId = opts.userId;
    this.capabilities = opts.capabilities;
    this.customFetch = opts.fetch;
    this.onChargeSuccess = opts.onChargeSuccess;
    this.onQuotaExceeded = opts.onQuotaExceeded;
    // Безопасность: в браузере userId должен приходить из Bearer (бэк
    // резолвит через GoTrue), а не передаваться явно — иначе host может
    // подсунуть чужой ID. `auth` без `userId` — норма; `userId` без `auth`
    // в браузере — потенциальная уязвимость, предупреждаем.
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
    // paywall_id шлём и в query (legacy v2 контракт), и в X-Paywall-Id хедере
    // (SDK 3.0 контракт). Бэк-route после патча принимает оба.
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

    // Content-Type: тот же подход, что в ApiClient. FormData — браузер сам.
    // unknown body, не строка/FormData/Blob — JSON.stringify.
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

    // Локальная переменная вместо `this.fetchImpl(...)` — нативный fetch
    // требует this=globalThis, а вызов через поле объекта связывает this с
    // ApiGatewayClient и Chrome бросает 'Illegal invocation'.
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
      // Не дренируем body — caller может попытаться `res.text()` сам, либо
      // мы клонируем для парсинга. Парсим клон, чтобы вернуть оригинал нетронутым
      // (важно для стримовых ответов; для JSON ошибок — clone() дешёвый).
      const code = await tryReadErrorCode(response.clone());
      throw new PaywallError(
        code ?? `http_${response.status}`,
        response.statusText || 'Gateway request failed',
        { status: response.status }
      );
    }

    // Charge произошёл на бэке (см. /api-gateway/route.ts: `if (queryType !== 'free')`).
    // Бэк не возвращает обновлённый баланс в хедерах — оптимистично декрементим
    // на клиенте. queryType приходит из X-Query-Type, если бэк его проставил;
    // иначе хук получит undefined, и BillingClient уйдёт в re-fetch /balances.
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
    /* malformed — отдадим пустые поля */
  }

  // Бэк отдаёт `details.balances` как массив строк paywall_balances:
  // [{ balances: Balance[] }] (см. supabase select). Извлекаем плоский массив.
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
