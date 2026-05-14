import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingClient } from '../src/core/BillingClient';
import {
  PaywallError,
  type PaywallBootstrap,
  type PaywallPrice,
  type PaywallSettings
} from '../src/core/types';

const TEST_API_ORIGIN = 'https://test.example.com';

const SETTINGS: PaywallSettings = { id: 'pw_1', name: 'Upgrade to Pro', brand_color: '#000' };

const PRICES: PaywallPrice[] = [
  {
    id: 'monthly',
    currency: 'USD',
    amount: 9.99,
    interval: 'month',
    interval_count: 1,
    trial_days: 7
  },
  {
    id: 'yearly',
    currency: 'USD',
    amount: 79,
    interval: 'year',
    interval_count: 1,
    trial_days: null
  }
];

const LAYOUT = {
  type: 'modal' as const,
  blocks: [
    { type: 'heading' as const, text: 'Upgrade to Pro', level: 1 as const },
    { type: 'price_grid' as const, priceIds: ['monthly', 'yearly'] },
    { type: 'cta_button' as const, label: 'Continue', action: 'checkout' as const },
    { type: 'guarantee_badge' as const },
    { type: 'current_session' as const }
  ]
};

const BOOTSTRAP: PaywallBootstrap = {
  settings: SETTINGS,
  prices: PRICES,
  offers: [],
  layout: LAYOUT
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function bootstrapFetch(respond: () => Response | Promise<Response>): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('/bootstrap')) return respond();
    throw new Error(`Unexpected fetch for ${url}`);
  });
}

describe('BillingClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when paywallId is missing', () => {
    expect(() => new BillingClient({ apiOrigin: TEST_API_ORIGIN, paywallId: '' })).toThrow(PaywallError);
  });

  it('bootstrap fetches /bootstrap and returns the normalized payload', async () => {
    const fetchImpl = bootstrapFetch(() => json(BOOTSTRAP));
    const client = new BillingClient({ apiOrigin: TEST_API_ORIGIN, paywallId: 'pw_1', fetch: fetchImpl });

    const b = await client.bootstrap();

    expect(b).toEqual(BOOTSTRAP);
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toContain('/api/v1/paywall/pw_1/bootstrap');
  });

  it('builds a default layout if server omitted it', async () => {
    const fetchImpl = bootstrapFetch(() =>
      json({ settings: SETTINGS, prices: PRICES, offers: [] })
    );
    const client = new BillingClient({ apiOrigin: TEST_API_ORIGIN, paywallId: 'pw_1', fetch: fetchImpl });

    const b = await client.bootstrap();

    expect(b.layout).toEqual(LAYOUT);
  });

  it('default layout falls back to "Upgrade" heading when settings.name is empty', async () => {
    const fetchImpl = bootstrapFetch(() =>
      json({ settings: { ...SETTINGS, name: '' }, prices: PRICES, offers: [] })
    );
    const client = new BillingClient({ apiOrigin: TEST_API_ORIGIN, paywallId: 'pw_1', fetch: fetchImpl });

    const b = await client.bootstrap();
    expect(b.layout?.blocks[0]).toEqual({ type: 'heading', text: 'Upgrade', level: 1 });
  });

  it('propagates /bootstrap failure', async () => {
    const fetchImpl = bootstrapFetch(() =>
      json({ code: 'not_found', message: 'nope' }, 404)
    );
    const client = new BillingClient({ apiOrigin: TEST_API_ORIGIN, paywallId: 'pw_1', fetch: fetchImpl });

    await expect(client.bootstrap()).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('caches bootstrap and re-fetches on force=true', async () => {
    const fetchImpl = bootstrapFetch(() => json(BOOTSTRAP));
    const client = new BillingClient({ apiOrigin: TEST_API_ORIGIN, paywallId: 'pw_1', fetch: fetchImpl });

    await client.bootstrap();
    await client.bootstrap();
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    await client.bootstrap(true);
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('keeps bootstrap cache across identity changes (structure is identity-agnostic)', async () => {
    // bootstrap structure (settings/prices/offers/layout/locales) от identity
    // не зависит — `setIdentity` сбрасывает только cached user. Следующий
    // bootstrap() возвращает кэш без сети; свежий user приходит через
    // отдельный getUser({force:true}), который setIdentity дёргает сам.
    const fetchImpl = bootstrapFetch(() => json(BOOTSTRAP));
    const client = new BillingClient({ apiOrigin: TEST_API_ORIGIN, paywallId: 'pw_1', fetch: fetchImpl });

    await client.bootstrap();
    const before = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length;
    client.setIdentity({ email: 'a@b.c' });
    await client.bootstrap();

    // bootstrap не перезапрашивается; setIdentity мог триггернуть getUser
    // (другой endpoint) — bootstrap-endpoint остаётся на 1 вызов.
    const bootstrapCalls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => String(url).includes('/bootstrap')
    ).length;
    expect(bootstrapCalls).toBe(before);
    expect(client.getIdentity()).toEqual({ email: 'a@b.c' });
  });

  it('createCheckout requires identity', async () => {
    const fetchImpl = bootstrapFetch(() => json(BOOTSTRAP));
    const client = new BillingClient({ apiOrigin: TEST_API_ORIGIN, paywallId: 'pw_1', fetch: fetchImpl });

    await expect(client.createCheckout({ priceId: 'monthly' })).rejects.toMatchObject({
      code: 'identity_required'
    });
  });

  it('createCheckout POSTs bootstrap-contract payload and maps response', async () => {
    const checkoutFetch = vi.fn<typeof fetch>(async () =>
      json({ checkoutUrl: 'https://pay/x', userId: 'u_42', acquiring: 'stripe' })
    );
    const client = new BillingClient({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      identity: { email: 'a@b.c', userId: 'u_42' },
      apiKey: 'ak_test',
      fetch: checkoutFetch
    });

    const res = await client.createCheckout({
      priceId: '8366',
      successUrl: 'https://ok',
      errorUrl: 'https://cancel'
    });

    expect(res).toEqual({ url: 'https://pay/x', acquiring: 'stripe' });
    const [url, init] = checkoutFetch.mock.calls[0];
    expect(url).toContain('/api/v1/paywall/pw_1/start-checkout');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Headers).get('X-Api-Key')).toBe('ak_test');
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'a@b.c',
      priceId: 8366,
      successUrl: 'https://ok',
      errorUrl: 'https://cancel',
      userMeta: { userId: 'u_42' }
    });
  });

  it('createCheckout auto-generates a UUID Idempotency-Key', async () => {
    const checkoutFetch = vi.fn<typeof fetch>(async () =>
      json({ checkoutUrl: 'https://pay/x', userId: 'u_42', acquiring: 'stripe' })
    );
    const client = new BillingClient({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: checkoutFetch
    });

    await client.createCheckout({ priceId: 'monthly' });

    const init = checkoutFetch.mock.calls[0][1];
    const key = (init?.headers as Headers).get('Idempotency-Key');
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('createCheckout passes through explicit idempotencyKey', async () => {
    const checkoutFetch = vi.fn<typeof fetch>(async () =>
      json({ checkoutUrl: 'https://pay/x', userId: 'u_42', acquiring: 'stripe' })
    );
    const client = new BillingClient({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: checkoutFetch
    });

    const explicit = '11111111-2222-4333-8444-555555555555';
    await client.createCheckout({ priceId: 'monthly', idempotencyKey: explicit });

    const init = checkoutFetch.mock.calls[0][1];
    expect((init?.headers as Headers).get('Idempotency-Key')).toBe(explicit);
  });

  it('createCheckout dedupes parallel calls for the same priceId (one HTTP request)', async () => {
    let resolveResp: (r: Response) => void = () => {};
    const checkoutFetch = vi.fn<typeof fetch>(
      () => new Promise<Response>((res) => { resolveResp = res; })
    );
    const client = new BillingClient({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: checkoutFetch
    });

    const p1 = client.createCheckout({ priceId: 'monthly' });
    const p2 = client.createCheckout({ priceId: 'monthly' });
    const p3 = client.createCheckout({ priceId: 'monthly' });

    // ApiClient.request делает один await перед fetch (auth token guard) —
    // даём microtask'ам пройти, чтобы fetch успел дёрнуться.
    await Promise.resolve();
    await Promise.resolve();
    expect(checkoutFetch.mock.calls.length).toBe(1);
    resolveResp(json({ checkoutUrl: 'https://pay/x', userId: 'u_1', acquiring: 'stripe' }));

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toEqual({ url: 'https://pay/x', acquiring: 'stripe' });
    expect(r2).toBe(r1);
    expect(r3).toBe(r1);
    expect(checkoutFetch.mock.calls.length).toBe(1);
  });

  it('createCheckout does NOT dedupe across different priceId', async () => {
    const checkoutFetch = vi.fn<typeof fetch>(async (_, init) => {
      const body = JSON.parse(init!.body as string);
      return json({
        checkoutUrl: `https://pay/${body.priceId}`,
        userId: 'u_1',
        acquiring: 'stripe'
      });
    });
    const client = new BillingClient({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: checkoutFetch
    });

    // priceId уходит через Number(...) — нужен числовой id, иначе NaN→null
    // в JSON и тест мерит «https://pay/null».
    const [r1, r2] = await Promise.all([
      client.createCheckout({ priceId: '101' }),
      client.createCheckout({ priceId: '202' })
    ]);

    expect(r1.url).toBe('https://pay/101');
    expect(r2.url).toBe('https://pay/202');
    expect(checkoutFetch.mock.calls.length).toBe(2);
  });

  it('createCheckout regenerates the key after a completed call', async () => {
    const checkoutFetch = vi.fn<typeof fetch>(async () =>
      json({ checkoutUrl: 'https://pay/x', userId: 'u_1', acquiring: 'stripe' })
    );
    const client = new BillingClient({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: checkoutFetch
    });

    await client.createCheckout({ priceId: 'monthly' });
    await client.createCheckout({ priceId: 'monthly' });

    expect(checkoutFetch.mock.calls.length).toBe(2);
    const k1 = (checkoutFetch.mock.calls[0][1]?.headers as Headers).get(
      'Idempotency-Key'
    );
    const k2 = (checkoutFetch.mock.calls[1][1]?.headers as Headers).get(
      'Idempotency-Key'
    );
    expect(k1).toBeTruthy();
    expect(k2).toBeTruthy();
    expect(k1).not.toBe(k2);
  });

  it('createCheckout maps freemius response (checkoutUrl → url)', async () => {
    // Freemius hosted checkout: бэк возвращает ту же shape `{checkoutUrl, userId,
    // acquiring}` что Stripe/Paddle. SDK не ветвит логику по acquiring — просто
    // мапит checkoutUrl в url. Тест защищает от случайного добавления
    // per-acquirer ветки или сужения типа.
    const checkoutFetch = vi.fn<typeof fetch>(async () =>
      json({
        checkoutUrl: 'https://checkout.freemius.com/product/123/plan/456/?billing_cycle=annual',
        userId: 'u_42',
        acquiring: 'freemius'
      })
    );
    const client = new BillingClient({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: checkoutFetch
    });

    const res = await client.createCheckout({ priceId: 'monthly' });

    expect(res).toEqual({
      url: 'https://checkout.freemius.com/product/123/plan/456/?billing_cycle=annual',
      acquiring: 'freemius'
    });
  });

  it('createCheckout dedupes parallel freemius calls (same priceId)', async () => {
    // Дедуп — общий механизм, не зависит от acquiring. Этот тест
    // явно фиксирует, что для freemius он тоже работает: дубль-клик по CTA
    // не создаёт два checkout-URL'а у Freemius (которые потом протухнут оба).
    let resolveResp: (r: Response) => void = () => {};
    const checkoutFetch = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((res) => {
          resolveResp = res;
        })
    );
    const client = new BillingClient({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: checkoutFetch
    });

    const p1 = client.createCheckout({ priceId: 'monthly' });
    const p2 = client.createCheckout({ priceId: 'monthly' });

    await Promise.resolve();
    await Promise.resolve();
    expect(checkoutFetch.mock.calls.length).toBe(1);
    resolveResp(
      json({
        checkoutUrl: 'https://checkout.freemius.com/x',
        userId: 'u_1',
        acquiring: 'freemius'
      })
    );

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.url).toBe('https://checkout.freemius.com/x');
    expect(r2).toBe(r1);
  });

  it('createCheckout releases inflight slot after rejection', async () => {
    const checkoutFetch = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => json({ error: 'boom' }, 500))
      .mockImplementationOnce(async () =>
        json({ checkoutUrl: 'https://pay/ok', userId: 'u_1', acquiring: 'stripe' })
      );
    const client = new BillingClient({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: checkoutFetch
    });

    await expect(client.createCheckout({ priceId: 'monthly' })).rejects.toBeDefined();
    const r = await client.createCheckout({ priceId: 'monthly' });
    expect(r).toEqual({ url: 'https://pay/ok', acquiring: 'stripe' });
    expect(checkoutFetch.mock.calls.length).toBe(2);
  });
});
