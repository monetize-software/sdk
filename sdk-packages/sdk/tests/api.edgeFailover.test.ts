import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/core/api';
import {
  __resetEdgeStateForTests,
  deriveEdgeOrigin,
  EDGE_HEDGE_TIMEOUT_MS,
  EDGE_STICKY_TTL_MS
} from '../src/core/edge';
import { PaywallError } from '../src/core/types';
import type { StorageAdapter } from '../src/core/storage';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' }
  });
}

// A fetch failure the way undici/browsers report a dead connection.
function networkError(): TypeError {
  return new TypeError('fetch failed');
}

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/** fetch that routes by origin: primary handler vs edge handler. */
function routedFetch(
  handlers: Record<
    string,
    (url: string, init?: RequestInit) => Promise<Response>
  >
) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (url.startsWith(prefix)) return handler(url, init);
    }
    throw new Error(`no handler for ${url}`);
  });
}

/** fetch attempt that hangs until its abort signal fires (like real fetch,
 *  an already-aborted signal rejects immediately). */
function hangUntilAborted(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (init?.signal?.aborted) return reject(abortError());
    init?.signal?.addEventListener('abort', () => reject(abortError()));
  });
}

function memoryStorage(
  seed: Record<string, string> = {}
): StorageAdapter & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    async getItem(key) {
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      data.set(key, value);
    },
    async removeItem(key) {
      data.delete(key);
    }
  };
}

// Unique per-test primary origins where sticky state matters — the resolver's
// shared map is module-level and keyed by primary origin.
function makeClient(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof ApiClient>[0]> = {},
  origin = 'https://api.example.com'
) {
  return new ApiClient({
    apiOrigin: origin,
    paywallId: 'pw_123',
    fetch: fetchImpl,
    ...extra
  });
}

beforeEach(() => {
  __resetEdgeStateForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('deriveEdgeOrigin', () => {
  it('prefixes the host with edge.', () => {
    expect(deriveEdgeOrigin('https://app.vendor.com')).toBe(
      'https://edge.app.vendor.com'
    );
  });

  it('keeps a non-default port', () => {
    expect(deriveEdgeOrigin('https://app.vendor.com:8443')).toBe(
      'https://edge.app.vendor.com:8443'
    );
  });

  it('returns null for http, localhost, IPs and existing edge hosts', () => {
    expect(deriveEdgeOrigin('http://app.vendor.com')).toBeNull();
    expect(deriveEdgeOrigin('https://localhost:3000')).toBeNull();
    expect(deriveEdgeOrigin('https://127.0.0.1')).toBeNull();
    expect(deriveEdgeOrigin('https://[::1]:8443')).toBeNull();
    expect(deriveEdgeOrigin('https://edge.app.vendor.com')).toBeNull();
    expect(deriveEdgeOrigin('not a url')).toBeNull();
  });
});

describe('ApiClient edge failover', () => {
  it('fails over to edge.<host> on a network error and succeeds', async () => {
    const fetchMock = routedFetch({
      'https://api.example.com': async () => {
        throw networkError();
      },
      'https://edge.api.example.com': async () => jsonResponse({ ok: true })
    });
    const api = makeClient(fetchMock);

    const result = await api.request<{ ok: boolean }>('/x');

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'https://api.example.com'
    );
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      'https://edge.api.example.com'
    );
  });

  it('does NOT fail over on HTTP errors — any status proves reachability', async () => {
    const fetchMock = routedFetch({
      'https://api.example.com': async () =>
        jsonResponse({ error: 'boom' }, { status: 500 })
    });
    const api = makeClient(fetchMock);

    await expect(api.request('/x')).rejects.toMatchObject({ code: 'boom' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT fail over on a caller abort', async () => {
    const fetchMock = routedFetch({
      'https://api.example.com': hangUntilAborted
    });
    const api = makeClient(fetchMock);
    const controller = new AbortController();

    const pending = api.request('/x', { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'aborted'
    });
    controller.abort();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a hung primary as a network failure after the hedge timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = routedFetch({
      'https://api.example.com': hangUntilAborted,
      'https://edge.api.example.com': async () => jsonResponse({ ok: true })
    });
    const api = makeClient(fetchMock);

    const pending = api.request<{ ok: boolean }>('/x');
    await vi.advanceTimersByTimeAsync(EDGE_HEDGE_TIMEOUT_MS + 1);

    await expect(pending).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps a body killed mid-read on a 200 to a failover, not a silent null', async () => {
    // The DPI ~16KB cut: headers arrive (status 200, content-type json), the
    // body read then rejects with a network-flavored TypeError.
    const deadBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'));
        controller.error(networkError());
      }
    });
    const fetchMock = routedFetch({
      'https://api.example.com': async () =>
        new Response(deadBody, {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }),
      'https://edge.api.example.com': async () => jsonResponse({ ok: true })
    });
    const api = makeClient(fetchMock);

    await expect(api.request('/x')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the legacy null-payload tolerance for genuinely malformed JSON', async () => {
    const fetchMock = routedFetch({
      'https://api.example.com': async () =>
        new Response('{oops', {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    });
    const api = makeClient(fetchMock);

    await expect(api.request('/x')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sticks to edge after a failover and heals back to primary when it answers', async () => {
    const origin = 'https://sticky.example.com';
    let primaryUp = false;
    const fetchMock = routedFetch({
      [origin]: async () => {
        if (!primaryUp) throw networkError();
        return jsonResponse({ from: 'primary' });
      },
      'https://edge.sticky.example.com': async () =>
        jsonResponse({ from: 'edge' })
    });
    const api = makeClient(fetchMock, {}, origin);

    await api.request('/first'); // primary fails → edge wins, sticky recorded
    fetchMock.mockClear();

    await expect(api.request<{ from: string }>('/second')).resolves.toEqual({
      from: 'edge'
    });
    // Sticky: the second request goes straight to edge, no primary attempt.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'https://edge.sticky.example.com'
    );

    // TTL expiry → primary is probed first again and heals the preference.
    primaryUp = true;
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + EDGE_STICKY_TTL_MS + 1);
    fetchMock.mockClear();
    await expect(api.request<{ from: string }>('/third')).resolves.toEqual({
      from: 'primary'
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain(origin);
  });

  it('disables failover with edgeFallback: false', async () => {
    const fetchMock = routedFetch({
      'https://api.example.com': async () => {
        throw networkError();
      }
    });
    const api = makeClient(fetchMock, { edgeFallback: false });

    await expect(api.request('/x')).rejects.toMatchObject({
      code: 'network_error'
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honors an explicit edgeFallback origin override', async () => {
    const fetchMock = routedFetch({
      'https://api.example.com': async () => {
        throw networkError();
      },
      'https://mirror.other.net': async () => jsonResponse({ ok: true })
    });
    const api = makeClient(fetchMock, {
      edgeFallback: 'https://mirror.other.net'
    });

    await expect(api.request('/x')).resolves.toEqual({ ok: true });
  });

  it('persists the sticky choice and hydrates it on a fresh client', async () => {
    const origin = 'https://persist.example.com';
    const storage = memoryStorage();
    const failingThenEdge = routedFetch({
      [origin]: async () => {
        throw networkError();
      },
      'https://edge.persist.example.com': async () => jsonResponse({ ok: true })
    });
    await makeClient(failingThenEdge, { storage }, origin).request('/x');

    const persisted = storage.data.get('pw-edge-persist.example.com-v1');
    expect(persisted).toBeTruthy();
    expect(JSON.parse(persisted!)).toMatchObject({ active: 'edge' });

    // A "new session": module state cleared, a fresh client with the same
    // storage must go straight to edge without touching the primary.
    __resetEdgeStateForTests();
    const edgeOnly = routedFetch({
      'https://edge.persist.example.com': async () => jsonResponse({ ok: true })
    });
    await expect(
      makeClient(edgeOnly, { storage }, origin).request('/y')
    ).resolves.toEqual({
      ok: true
    });
    expect(edgeOnly).toHaveBeenCalledTimes(1);
  });

  it('shares the discovered edge across client instances of the same origin', async () => {
    const origin = 'https://shared.example.com';
    const failing = routedFetch({
      [origin]: async () => {
        throw networkError();
      },
      'https://edge.shared.example.com': async () => jsonResponse({ ok: true })
    });
    await makeClient(failing, {}, origin).request('/x');

    // A second, storage-less client (the ApiGatewayClient case) benefits from
    // the module-level shared state.
    const edgeOnly = routedFetch({
      'https://edge.shared.example.com': async () => jsonResponse({ ok: true })
    });
    await expect(
      makeClient(edgeOnly, {}, origin).request('/y')
    ).resolves.toEqual({ ok: true });
    expect(edgeOnly).toHaveBeenCalledTimes(1);
  });

  it('reports activeOrigin() following the sticky state', async () => {
    const origin = 'https://active.example.com';
    const fetchMock = routedFetch({
      [origin]: async () => {
        throw networkError();
      },
      'https://edge.active.example.com': async () => jsonResponse({ ok: true })
    });
    const api = makeClient(fetchMock, {}, origin);

    expect(api.activeOrigin()).toBe(origin);
    await api.request('/x');
    expect(api.activeOrigin()).toBe('https://edge.active.example.com');
  });

  it('throws invalid_config on a malformed edgeFallback override', () => {
    expect(() =>
      makeClient(vi.fn<typeof fetch>(), { edgeFallback: 'not a url' })
    ).toThrowError(PaywallError);
  });
});

describe('replay gating (non-idempotent requests)', () => {
  function cutBodyResponse(): Response {
    const deadBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'));
        controller.error(networkError());
      }
    });
    return new Response(deadBody, {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }

  it('does NOT replay a POST whose body died after a 200 (server processed it)', async () => {
    const fetchMock = routedFetch({
      'https://api.example.com': async () => cutBodyResponse(),
      'https://edge.api.example.com': async () => jsonResponse({ ok: true })
    });
    const api = makeClient(fetchMock);

    await expect(
      api.request('/support/ticket', { method: 'POST', body: '{}' })
    ).rejects.toMatchObject({ code: 'network_error' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('replays a POST body-cut when explicitly marked replayable', async () => {
    const fetchMock = routedFetch({
      'https://api.example.com': async () => cutBodyResponse(),
      'https://edge.api.example.com': async () => jsonResponse({ ok: true })
    });
    const api = makeClient(fetchMock);

    await expect(
      api.request('/read-like', {
        method: 'POST',
        body: '{}',
        replayable: true
      })
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still fails over a POST on a connect-level failure (request never landed)', async () => {
    const fetchMock = routedFetch({
      'https://api.example.com': async () => {
        throw networkError();
      },
      'https://edge.api.example.com': async () => jsonResponse({ ok: true })
    });
    const api = makeClient(fetchMock);

    await expect(
      api.request('/support/ticket', { method: 'POST', body: '{}' })
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('phased deadlines', () => {
  it('does not kill a slow body at the hedge — the timer is swapped after headers', async () => {
    vi.useFakeTimers();
    let resolveBody: (v: unknown) => void = () => {};
    // Object-mock: a Response whose json() we control (a real Response body
    // can't be held open from the test).
    const slowBodyResponse = {
      status: 200,
      ok: true,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => new Promise((res) => (resolveBody = res))
    } as unknown as Response;
    const fetchMock = routedFetch({
      'https://api.example.com': async () => slowBodyResponse
    });
    const api = makeClient(fetchMock);

    const pending = api.request<{ ok: boolean }>('/x');
    // Well past the 5s hedge: under the old single-timer scheme this aborted
    // the body and failed over; now the hedge is disarmed at headers and only
    // the 30s body deadline is armed.
    await vi.advanceTimersByTimeAsync(EDGE_HEDGE_TIMEOUT_MS + 2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveBody({ ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('exempts FormData uploads from artificial deadlines', async () => {
    vi.useFakeTimers();
    let resolvePrimary: (r: Response) => void = () => {};
    const fetchMock = routedFetch({
      'https://api.example.com': (_url, init) =>
        new Promise<Response>((res, rej) => {
          resolvePrimary = res;
          init?.signal?.addEventListener('abort', () => rej(abortError()));
        })
    });
    const api = makeClient(fetchMock);

    const form = new FormData();
    form.set('field', 'value');
    const pending = api.request<{ ok: boolean }>('/support/ticket', {
      method: 'POST',
      body: form
    });
    // Way past both the hedge and the final deadline — the upload must not be
    // aborted (files on slow links are legitimately slow; pre-edge behavior).
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolvePrimary(jsonResponse({ ok: true }));
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('gives the 401-recovery replay its own headers deadline', async () => {
    vi.useFakeTimers();
    let sends = 0;
    const fetchMock = routedFetch({
      'https://api.example.com': async () => {
        sends += 1;
        if (sends === 1) {
          return jsonResponse({ error: 'invalid_token' }, { status: 401 });
        }
        return jsonResponse({ ok: true });
      }
    });
    // A slow refresh: longer than the 5s hedge. Under the shared-timer scheme
    // the deadline fired mid-recovery and forced a spurious failover.
    const onUnauthorized = vi.fn(
      () =>
        new Promise<string | null>((res) =>
          setTimeout(() => res('tok_fresh'), EDGE_HEDGE_TIMEOUT_MS + 1_000)
        )
    );
    const api = makeClient(fetchMock, {
      getAuthToken: () => 'tok_stale',
      onUnauthorized
    });

    const pending = api.request<{ ok: boolean }>('/x');
    await vi.advanceTimersByTimeAsync(EDGE_HEDGE_TIMEOUT_MS + 2_000);

    await expect(pending).resolves.toEqual({ ok: true });
    // Both sends went to the primary — no failover happened mid-recovery.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain('https://api.example.com');
    }
  });

  it('re-reads the auth token for the failover attempt', async () => {
    const tokens = ['tok_first', 'tok_second'];
    const getAuthToken = vi.fn(() => tokens.shift() ?? 'tok_last');
    const fetchMock = routedFetch({
      'https://api.example.com': async () => {
        throw networkError();
      },
      'https://edge.api.example.com': async () => jsonResponse({ ok: true })
    });
    const api = makeClient(fetchMock, { getAuthToken });

    await api.request('/x');

    expect(getAuthToken).toHaveBeenCalledTimes(2);
    const edgeHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(edgeHeaders.get('Authorization')).toBe('Bearer tok_second');
  });
});
