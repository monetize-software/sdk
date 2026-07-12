import { describe, expect, it, vi } from 'vitest';
import { ApiClient, SDK_VERSION } from '../src/core/api';
import { PaywallError } from '../src/core/types';

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { 'content-type': 'application/json' }
  });
}

function makeClient(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}) {
  return new ApiClient({
    apiOrigin: 'https://api.example.com',
    paywallId: 'pw_123',
    fetch: fetchImpl,
    ...extra
  });
}

describe('ApiClient', () => {
  it('builds url from origin + path and sets default headers', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const api = makeClient(fetchMock);

    await api.request('/api/v1/paywall/pw_123/settings');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/api/v1/paywall/pw_123/settings');
    const headers = new Headers(init?.headers);
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('X-SDK-Version')).toBe(SDK_VERSION);
    expect(headers.get('X-Paywall-Id')).toBe('pw_123');
    expect(init?.credentials).toBe('omit');
  });

  it('adds X-SDK-Capabilities when provided', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const api = makeClient(fetchMock, { capabilities: ['native-checkout', 'offers-v2'] });

    await api.request('/x');

    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get('X-SDK-Capabilities')).toBe('native-checkout,offers-v2');
  });

  it('omits X-SDK-Capabilities when empty', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const api = makeClient(fetchMock, { capabilities: [] });

    await api.request('/x');

    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.has('X-SDK-Capabilities')).toBe(false);
  });

  it('attaches Authorization when getAuthToken returns a token', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const api = makeClient(fetchMock, { getAuthToken: async () => 'tok_abc' });

    await api.request('/x');

    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok_abc');
  });

  it('skips Authorization when getAuthToken returns null', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const api = makeClient(fetchMock, { getAuthToken: () => null });

    await api.request('/x');

    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.has('Authorization')).toBe(false);
  });

  it('sets Content-Type: application/json when body is present and header missing', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const api = makeClient(fetchMock);

    await api.request('/x', { method: 'POST', body: JSON.stringify({ a: 1 }) });

    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('preserves caller-provided Content-Type', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const api = makeClient(fetchMock);

    await api.request('/x', {
      method: 'POST',
      body: 'raw',
      headers: { 'Content-Type': 'text/plain' }
    });

    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get('Content-Type')).toBe('text/plain');
  });

  it('parses JSON responses', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ hello: 'world' }));
    const api = makeClient(fetchMock);

    const result = await api.request<{ hello: string }>('/x');
    expect(result).toEqual({ hello: 'world' });
  });

  it('returns null for non-JSON successful responses', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response('plain', { status: 200, headers: { 'content-type': 'text/plain' } })
    );
    const api = makeClient(fetchMock);

    const result = await api.request('/x');
    expect(result).toBeNull();
  });

  it('wraps fetch failures into PaywallError(network_error)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error('boom');
    });
    const api = makeClient(fetchMock);

    await expect(api.request('/x')).rejects.toMatchObject({
      name: 'PaywallError',
      code: 'network_error'
    });
  });

  it('throws PaywallError with server-provided code/message on non-2xx JSON', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ code: 'invalid_price', message: 'Unknown price id' }, { status: 400 })
    );
    const api = makeClient(fetchMock);

    await expect(api.request('/x')).rejects.toMatchObject({
      name: 'PaywallError',
      code: 'invalid_price',
      message: 'Unknown price id',
      status: 400
    });
  });

  it('falls back to http_<status> code when body has no code', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response('', { status: 503, statusText: 'Service Unavailable' })
    );
    const api = makeClient(fetchMock);

    await expect(api.request('/x')).rejects.toMatchObject({
      code: 'http_503',
      message: 'Service Unavailable',
      status: 503
    });
  });

  it('survives malformed JSON on non-2xx responses', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response('not-json{', {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'content-type': 'application/json' }
      })
    );
    const api = makeClient(fetchMock);

    await expect(api.request('/x')).rejects.toBeInstanceOf(PaywallError);
  });

  // Several backend routes reply {error: 'invalid_token'} instead of the
  // {code, message} contract — before this fallback the SDK reported an opaque
  // http_401/"Request failed" to the events analytics.
  it('maps a slug-shaped `error` field to the code when `code` is absent', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: 'invalid_token' }, { status: 401 })
    );
    const api = makeClient(fetchMock);

    await expect(api.request('/x')).rejects.toMatchObject({
      code: 'invalid_token',
      status: 401
    });
  });

  it('uses a sentence-shaped `error` field as the message, keeps http_<status> code', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        { error: 'Invalid successUrl format. Must be a valid HTTP/HTTPS URL' },
        { status: 400 }
      )
    );
    const api = makeClient(fetchMock);

    await expect(api.request('/x')).rejects.toMatchObject({
      code: 'http_400',
      message: 'Invalid successUrl format. Must be a valid HTTP/HTTPS URL'
    });
  });

  it('prefers explicit `code` over the `error` field', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: 'unauthorized', code: 'invalid_refresh_token' }, { status: 401 })
    );
    const api = makeClient(fetchMock);

    await expect(api.request('/x')).rejects.toMatchObject({
      code: 'invalid_refresh_token'
    });
  });

  describe('401 retry via onUnauthorized', () => {
    it('forces one refresh and replays the request with the fresh token', async () => {
      const fetchMock = vi.fn<typeof fetch>();
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: 'invalid_token' }, { status: 401 }))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      const onUnauthorized = vi.fn(async () => 'tok_new');
      const api = makeClient(fetchMock, {
        getAuthToken: async () => 'tok_old',
        onUnauthorized
      });

      const result = await api.request('/x');

      expect(result).toEqual({ ok: true });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const retryHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers);
      expect(retryHeaders.get('Authorization')).toBe('Bearer tok_new');
    });

    it('throws the original 401 when onUnauthorized returns null (session cleared)', async () => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        jsonResponse({ error: 'invalid_token' }, { status: 401 })
      );
      const api = makeClient(fetchMock, {
        getAuthToken: async () => 'tok_old',
        onUnauthorized: async () => null
      });

      await expect(api.request('/x')).rejects.toMatchObject({
        code: 'invalid_token',
        status: 401
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws the original 401 when onUnauthorized itself rejects (network)', async () => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        jsonResponse({ error: 'invalid_token' }, { status: 401 })
      );
      const api = makeClient(fetchMock, {
        getAuthToken: async () => 'tok_old',
        onUnauthorized: async () => {
          throw new Error('offline');
        }
      });

      await expect(api.request('/x')).rejects.toMatchObject({ status: 401 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not call onUnauthorized when no Bearer was attached', async () => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        jsonResponse({ error: 'authorization_required' }, { status: 401 })
      );
      const onUnauthorized = vi.fn(async () => 'tok_new');
      const api = makeClient(fetchMock, {
        getAuthToken: () => null,
        onUnauthorized
      });

      await expect(api.request('/x')).rejects.toMatchObject({ status: 401 });
      expect(onUnauthorized).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries exactly once: a second 401 surfaces to the caller', async () => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        jsonResponse({ error: 'invalid_token' }, { status: 401 })
      );
      const onUnauthorized = vi.fn(async () => 'tok_new');
      const api = makeClient(fetchMock, {
        getAuthToken: async () => 'tok_old',
        onUnauthorized
      });

      await expect(api.request('/x')).rejects.toMatchObject({
        code: 'invalid_token',
        status: 401
      });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('skips the retry when the "fresh" token equals the rejected one', async () => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        jsonResponse({ error: 'invalid_token' }, { status: 401 })
      );
      const api = makeClient(fetchMock, {
        getAuthToken: async () => 'tok_same',
        onUnauthorized: async () => 'tok_same'
      });

      await expect(api.request('/x')).rejects.toMatchObject({ status: 401 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
