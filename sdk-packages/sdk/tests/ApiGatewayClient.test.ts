import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiGatewayClient } from '../src/core/ApiGatewayClient';
import { BillingClient } from '../src/core/BillingClient';
import { QuotaExceededError, type Balance } from '../src/core/types';

const TEST_API_ORIGIN = 'https://test.example.com';

function freshStorage() {
  return {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {})
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function streamResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

describe('ApiGatewayClient.call', () => {
  afterEach(() => vi.restoreAllMocks());

  it('builds URL with provider id, path, paywall_id query and X-Paywall-Id header', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const gw = new ApiGatewayClient({
      paywallId: 'pw_1',
      apiOrigin: 'https://example.test',
      userId: 'usr_1',
      fetch: fetchMock
    });

    await gw.call({ providerId: 'prov_a', path: '', body: { x: 1 } });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      'https://example.test/api/v1/api-gateway/prov_a?paywall_id=pw_1'
    );
    const headers = new Headers(init!.headers);
    expect(headers.get('X-Paywall-Id')).toBe('pw_1');
    expect(headers.get('X-User-ID')).toBe('usr_1');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(init!.body).toBe(JSON.stringify({ x: 1 }));
  });

  it('strips leading slashes in path', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const gw = new ApiGatewayClient({
      paywallId: 'pw_1',
      apiOrigin: 'https://example.test',
      userId: 'u',
      fetch: fetchMock
    });
    await gw.call({ providerId: 'p', path: '///v1/foo', body: {} });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://example.test/api/v1/api-gateway/p/v1/foo?paywall_id=pw_1'
    );
  });

  it('returns raw Response without consuming body for SSE', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      streamResponse(['data: a\n\n', 'data: b\n\n'])
    );
    const gw = new ApiGatewayClient({
      paywallId: 'pw_1',
      apiOrigin: 'https://example.test',
      userId: 'u',
      fetch: fetchMock
    });

    const res = await gw.call({ providerId: 'p', body: {} });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toBe('data: a\n\ndata: b\n\n');
  });

  it('throws QuotaExceededError on 402 with parsed details', async () => {
    const errorBody = {
      error: 'not-enough-queries',
      details: {
        balances: [{ balances: [{ type: 'standard', count: 0 }] }],
        queryType: 'standard',
        currentBalance: { type: 'standard', count: 0 }
      }
    };
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(errorBody, 402));
    const gw = new ApiGatewayClient({
      paywallId: 'pw_1',
      apiOrigin: 'https://example.test',
      userId: 'u',
      fetch: fetchMock
    });

    await expect(gw.call({ providerId: 'p', body: {} })).rejects.toMatchObject({
      name: 'QuotaExceededError',
      code: 'not_enough_queries',
      status: 402,
      queryType: 'standard',
      currentBalance: { type: 'standard', count: 0 },
      balances: [{ type: 'standard', count: 0 }]
    });
  });

  it('does not send Content-Type for FormData', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const gw = new ApiGatewayClient({
      paywallId: 'pw_1',
      apiOrigin: 'https://example.test',
      userId: 'u',
      fetch: fetchMock
    });
    const fd = new FormData();
    fd.set('a', '1');
    await gw.call({ providerId: 'p', body: fd });
    const headers = new Headers(fetchMock.mock.calls[0][1]!.headers);
    // FormData → the browser sets multipart/form-data with a boundary itself; the SDK
    // must not slip in application/json.
    expect(headers.get('Content-Type')).toBe(null);
    expect(fetchMock.mock.calls[0][1]!.body).toBe(fd);
  });

  it('calls onChargeSuccess with X-Query-Type from response on 200', async () => {
    const onCharge = vi.fn();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ ok: true }, 200, { 'X-Query-Type': 'advanced' })
    );
    const gw = new ApiGatewayClient({
      paywallId: 'pw_1',
      apiOrigin: 'https://example.test',
      userId: 'u',
      fetch: fetchMock,
      onChargeSuccess: onCharge
    });
    await gw.call({ providerId: 'p', body: {} });
    expect(onCharge).toHaveBeenCalledWith('advanced');
  });

  it('calls onQuotaExceeded with parsed error before throwing', async () => {
    const onQuota = vi.fn();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        {
          error: 'not-enough-queries',
          details: {
            balances: [{ balances: [{ type: 'free', count: 0 }] }],
            queryType: 'free',
            currentBalance: { type: 'free', count: 0 }
          }
        },
        402
      )
    );
    const gw = new ApiGatewayClient({
      paywallId: 'pw_1',
      apiOrigin: 'https://example.test',
      userId: 'u',
      fetch: fetchMock,
      onQuotaExceeded: onQuota
    });
    await expect(gw.call({ providerId: 'p', body: {} })).rejects.toBeInstanceOf(
      QuotaExceededError
    );
    expect(onQuota).toHaveBeenCalledOnce();
    expect(onQuota.mock.calls[0][0]).toBeInstanceOf(QuotaExceededError);
  });
});

describe('BillingClient.balances', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeBalancesFetch(payloads: Array<Balance[] | { error: string; status: number }>) {
    let i = 0;
    return vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/balances')) {
        const next = payloads[i] ?? payloads[payloads.length - 1];
        i += 1;
        if (Array.isArray(next)) {
          return jsonResponse({ balances: next, tokenization: true });
        }
        return jsonResponse({ error: next.error }, next.status);
      }
      return jsonResponse({}, 404);
    });
  }

  // Minimal fake AuthClient — getAccessToken returns a string, the other
  // methods aren't needed for the balances flow.
  function fakeAuth(token: string | null = 'tok') {
    return {
      getAccessToken: vi.fn(async () => token),
      getCachedUser: vi.fn(() => null),
      onAuthChange: vi.fn(() => () => {}),
      ready: vi.fn(async () => {})
    } as unknown as ConstructorParameters<typeof BillingClient>[0]['auth'];
  }

  it('returns [] without auth without hitting network', async () => {
    const fetchMock = makeBalancesFetch([]);
    const client = new BillingClient({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: fetchMock,
      storage: freshStorage()
    });

    const b = await client.getBalances();
    expect(b).toEqual([]);
    // Without auth /balances isn't called — fetchMock could only have been hit by
    // other routes (but we're testing the balances flow specifically).
    const balanceCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/balances'));
    expect(balanceCalls.length).toBe(0);
  });

  it('caches balances within TTL and re-fetches on force', async () => {
    const fetchMock = makeBalancesFetch([
      [{ type: 'free', count: 10 }],
      [{ type: 'free', count: 9 }]
    ]);
    const client = new BillingClient({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      auth: fakeAuth(),
      fetch: fetchMock,
      storage: freshStorage()
    });

    const a = await client.getBalances();
    const b = await client.getBalances();
    expect(a).toEqual([{ type: 'free', count: 10 }]);
    expect(b).toEqual([{ type: 'free', count: 10 }]);
    const balanceCalls = () =>
      fetchMock.mock.calls.filter(([u]) => String(u).includes('/balances')).length;
    expect(balanceCalls()).toBe(1);

    const c = await client.getBalances({ force: true });
    expect(c).toEqual([{ type: 'free', count: 9 }]);
    expect(balanceCalls()).toBe(2);
  });

  it('decrementBalanceLocal reduces queryType count and emits onBalanceChange', async () => {
    const fetchMock = makeBalancesFetch([
      [
        { type: 'free', count: 10 },
        { type: 'standard', count: 5 }
      ]
    ]);
    const client = new BillingClient({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      auth: fakeAuth(),
      fetch: fetchMock,
      storage: freshStorage()
    });
    await client.getBalances();

    const events: Balance[][] = [];
    const off = client.onBalanceChange((b) => events.push(b));
    // onBalanceChange emits a snapshot via a microtask.
    await Promise.resolve();
    expect(events.length).toBe(1);

    client.decrementBalanceLocal('standard');
    expect(events.at(-1)).toEqual([
      { type: 'free', count: 10 },
      { type: 'standard', count: 4 }
    ]);

    client.decrementBalanceLocal('unknown');
    // Non-existent queryType — no-op, the listener isn't fired again.
    expect(events.length).toBe(2);
    off();
  });

  it('decrementBalanceLocal with undefined triggers refetch', async () => {
    const fetchMock = makeBalancesFetch([
      [{ type: 'free', count: 10 }],
      [{ type: 'free', count: 9 }]
    ]);
    const client = new BillingClient({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      auth: fakeAuth(),
      fetch: fetchMock,
      storage: freshStorage()
    });
    await client.getBalances();

    client.decrementBalanceLocal(undefined);
    // Let the getBalances({force}) promise play out.
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    const balanceCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/balances'));
    expect(balanceCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('createApiGatewayClient wires charge → decrement and 402 → refresh', async () => {
    let getBalancesCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/balances')) {
        getBalancesCalls += 1;
        return jsonResponse({
          balances: [{ type: 'standard', count: getBalancesCalls === 1 ? 3 : 0 }],
          tokenization: true
        });
      }
      if (url.includes('/api-gateway/prov_charge')) {
        return jsonResponse({ ok: true }, 200, { 'X-Query-Type': 'standard' });
      }
      if (url.includes('/api-gateway/prov_quota')) {
        return jsonResponse(
          {
            error: 'not-enough-queries',
            details: {
              balances: [{ balances: [{ type: 'standard', count: 0 }] }],
              queryType: 'standard',
              currentBalance: { type: 'standard', count: 0 }
            }
          },
          402
        );
      }
      return jsonResponse({}, 404);
    });

    const client = new BillingClient({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      auth: fakeAuth(),
      fetch: fetchMock,
      storage: freshStorage()
    });
    await client.getBalances();

    const gw = client.createApiGatewayClient();
    await gw.call({ providerId: 'prov_charge', body: {} });
    expect(client.getCachedBalances()).toEqual([{ type: 'standard', count: 2 }]);

    await expect(gw.call({ providerId: 'prov_quota', body: {} })).rejects.toBeInstanceOf(
      QuotaExceededError
    );
    // refresh fires via void; let it complete.
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(client.getCachedBalances()).toEqual([{ type: 'standard', count: 0 }]);
  });
});
