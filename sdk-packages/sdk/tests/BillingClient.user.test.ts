import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingClient } from '../src/core/BillingClient';
import type { PaywallUser } from '../src/core/types';

// Каждый тест получает свежий storage — иначе module-level memoryMap из
// storage.ts протекает между тестами и persistent fallback hydrate'ит чужой
// user.
function freshStorage() {
  return {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {})
  };
}

const EMPTY: PaywallUser = {
  has_active_subscription: false,
  purchases: [],
  trial: null
};

const ACTIVE: PaywallUser = {
  has_active_subscription: true,
  purchases: [
    {
      id: 'sub_1',
      status: 'active',
      current_period_end: '2099-01-01T00:00:00Z',
      cancel_at_period_end: false
    }
  ],
  trial: null
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

// fetch-мок, который различает /bootstrap и /user-state. Для тестов user-state
// /bootstrap не вызывается — возвращаем 404, чтобы было видно, если случайно
// дёрнут.
function makeFetch(userResponses: PaywallUser[]): { fn: typeof fetch; calls: () => number } {
  let i = 0;
  const fn = vi.fn<typeof fetch>(async (input) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/user-state')) {
      const next = userResponses[i] ?? userResponses[userResponses.length - 1];
      i += 1;
      return jsonResponse(next);
    }
    return jsonResponse({ error: 'unexpected' }, 404);
  });
  return { fn, calls: () => (fn as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => String(u).includes('/user-state')).length };
}

describe('BillingClient.getUser', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns EMPTY without identity and does not hit network', async () => {
    const { fn, calls } = makeFetch([]);
    const client = new BillingClient({ paywallId: 'pw_1', fetch: fn });

    const u = await client.getUser();
    expect(u).toEqual(EMPTY);
    expect(calls()).toBe(0);
  });

  it('fetches /user-state and caches within TTL', async () => {
    const { fn, calls } = makeFetch([EMPTY]);
    const client = new BillingClient({
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: fn,
      storage: freshStorage()
    });

    await client.getUser();
    await client.getUser();
    await client.getUser();

    expect(calls()).toBe(1);
  });

  it('refetches after TTL window expires', async () => {
    const { fn, calls } = makeFetch([EMPTY, EMPTY]);
    const client = new BillingClient({
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: fn,
      storage: freshStorage()
    });

    await client.getUser();
    expect(calls()).toBe(1);

    vi.advanceTimersByTime(6_000);
    await client.getUser();
    expect(calls()).toBe(2);
  });

  it('force=true bypasses cache', async () => {
    const { fn, calls } = makeFetch([EMPTY, ACTIVE]);
    const client = new BillingClient({
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: fn,
      storage: freshStorage()
    });

    await client.getUser();
    expect(calls()).toBe(1);

    const fresh = await client.getUser({ force: true });
    expect(calls()).toBe(2);
    expect(fresh.has_active_subscription).toBe(true);
  });

  it('dedupes parallel in-flight requests into one fetch', async () => {
    let resolveFirst!: (r: Response) => void;
    const fetchFn = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        })
    );
    const client = new BillingClient({
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: fetchFn,
      storage: freshStorage()
    });

    const a = client.getUser();
    const b = client.getUser();
    const c = client.getUser();

    // Прокручиваем microtask-цепочку async IIFE → ApiClient.request → fetchImpl.
    await vi.advanceTimersByTimeAsync(0);
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    resolveFirst(jsonResponse(ACTIVE));
    await Promise.all([a, b, c]);

    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('setIdentity clears user cache', async () => {
    const { fn, calls } = makeFetch([EMPTY, ACTIVE]);
    const client = new BillingClient({
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: fn,
      storage: freshStorage()
    });

    await client.getUser();
    client.setIdentity({ email: 'other@b.c' });
    await client.getUser();

    expect(calls()).toBe(2);
  });
});

describe('BillingClient.onUserChange', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('emits to listener when user changes', async () => {
    const { fn } = makeFetch([EMPTY, ACTIVE]);
    const client = new BillingClient({
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: fn,
      storage: freshStorage()
    });

    const calls: PaywallUser[] = [];
    client.onUserChange((u) => calls.push(u));

    await client.getUser();
    await client.getUser({ force: true });

    expect(calls.length).toBe(2);
    expect(calls[0]).toEqual(EMPTY);
    expect(calls[1]).toEqual(ACTIVE);
  });

  it('does not re-emit when same shape returns', async () => {
    const { fn } = makeFetch([EMPTY, EMPTY]);
    const client = new BillingClient({
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: fn,
      storage: freshStorage()
    });

    const calls: PaywallUser[] = [];
    client.onUserChange((u) => calls.push(u));

    await client.getUser();
    await client.getUser({ force: true });

    expect(calls.length).toBe(1);
  });

  it('replays last-known user to a fresh subscriber via microtask', async () => {
    const { fn } = makeFetch([ACTIVE]);
    const client = new BillingClient({
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: fn,
      storage: freshStorage()
    });

    await client.getUser();

    const seen: PaywallUser[] = [];
    client.onUserChange((u) => seen.push(u));

    expect(seen.length).toBe(0); // не синхронно
    await Promise.resolve(); // прокручиваем микротаски
    expect(seen).toEqual([ACTIVE]);
  });

  it('off() prevents further notifications', async () => {
    const { fn } = makeFetch([EMPTY, ACTIVE]);
    const client = new BillingClient({
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: fn,
      storage: freshStorage()
    });

    const calls: PaywallUser[] = [];
    const off = client.onUserChange((u) => calls.push(u));

    await client.getUser();
    off();
    await client.getUser({ force: true });

    expect(calls).toEqual([EMPTY]);
  });
});
