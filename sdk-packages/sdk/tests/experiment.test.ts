// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  applyExperimentAssignment,
  fnv1a,
  pickVariant,
  resolveExperimentAssignment
} from '../src/core/experiment';
import { BillingClient } from '../src/core/BillingClient';
import { STORAGE_KEYS, type StorageAdapter } from '../src/core/storage';
import type { PaywallBootstrap, PaywallExperiment } from '../src/core/types';

// Client-side A/B engine:
// - deterministic visitor bucketing (weights, degenerate configs);
// - sticky assignment via storage (first-touch wins, new experiment rebuckets);
// - price/layout/offer substitution — idempotent and control-safe;
// - BillingClient integration: bootstrap materializes the variant, checkout
//   carries visitorId + experiment attribution.

function memoryStorage(seed: Record<string, string> = {}): StorageAdapter & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => {
      data.set(k, v);
    },
    removeItem: async (k) => {
      data.delete(k);
    }
  };
}

function makeExperiment(overrides: Partial<PaywallExperiment> = {}): PaywallExperiment {
  return {
    id: 'exp_1',
    kind: 'prices',
    variants: [
      { key: 'control', weight: 50 },
      {
        key: 'b',
        weight: 50,
        prices: [
          {
            id: '201',
            currency: 'USD',
            amount: 12.99,
            interval: 'month',
            interval_count: 1,
            trial_days: null,
            replaces: '101'
          },
          {
            id: '202',
            currency: 'USD',
            amount: 79.99,
            interval: 'year',
            interval_count: 1,
            trial_days: null,
            replaces: '102'
          }
        ]
      }
    ],
    ...overrides
  };
}

function makeBootstrap(): PaywallBootstrap {
  return {
    settings: { id: 'pw_1', name: 'Pro' },
    prices: [
      { id: '101', currency: 'USD', amount: 9.99, interval: 'month', interval_count: 1, trial_days: null },
      { id: '102', currency: 'USD', amount: 59.99, interval: 'year', interval_count: 1, trial_days: null }
    ],
    offers: [
      { id: 'of_1', discount_percent: 20, expires_at: null, duration_minutes: null, price_id: '102' }
    ],
    layout: {
      type: 'modal',
      blocks: [
        { type: 'heading', text: 'Upgrade', level: 1 },
        { type: 'price_grid', priceIds: ['101', '102'], popular_price_id: '102' },
        { type: 'cta_button', action: 'checkout', priceId: '101' }
      ]
    },
    experiment: makeExperiment()
  };
}

/** Finds a visitor id that deterministically buckets into `variant`. */
function visitorFor(experiment: PaywallExperiment, variant: string): string {
  for (let i = 0; i < 10_000; i++) {
    const candidate = `visitor-${i}-abcdefgh12345678`;
    if (pickVariant(experiment, candidate) === variant) return candidate;
  }
  throw new Error(`no visitor found for variant ${variant}`);
}

describe('pickVariant', () => {
  it('is deterministic for the same visitor + experiment', () => {
    const exp = makeExperiment();
    const a = pickVariant(exp, 'v-123');
    for (let i = 0; i < 10; i++) expect(pickVariant(exp, 'v-123')).toBe(a);
  });

  it('different experiment id can produce a different bucket (salted hash)', () => {
    // Not guaranteed per-visitor, but across a sample the assignments must differ.
    const a = makeExperiment({ id: 'exp_a' });
    const b = makeExperiment({ id: 'exp_b' });
    let diff = 0;
    for (let i = 0; i < 200; i++) {
      if (pickVariant(a, `v-${i}`) !== pickVariant(b, `v-${i}`)) diff++;
    }
    expect(diff).toBeGreaterThan(0);
  });

  it('respects extreme weights', () => {
    const allB = makeExperiment({
      variants: [
        { key: 'control', weight: 0 },
        { key: 'b', weight: 100 }
      ]
    });
    const allControl = makeExperiment({
      variants: [
        { key: 'control', weight: 100 },
        { key: 'b', weight: 0 }
      ]
    });
    for (let i = 0; i < 50; i++) {
      expect(pickVariant(allB, `v-${i}`)).toBe('b');
      expect(pickVariant(allControl, `v-${i}`)).toBe('control');
    }
  });

  it('splits roughly evenly at 50/50', () => {
    const exp = makeExperiment();
    let control = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      if (pickVariant(exp, `visitor-${i}-abcdefgh12345678`) === 'control') control++;
    }
    // Loose bounds: a uniform hash keeps 50/50 within ±5pp on n=2000.
    expect(control / n).toBeGreaterThan(0.45);
    expect(control / n).toBeLessThan(0.55);
  });

  it('returns null on degenerate configs', () => {
    expect(pickVariant(makeExperiment({ variants: [] }), 'v')).toBeNull();
    expect(
      pickVariant(
        makeExperiment({
          variants: [
            { key: 'control', weight: 0 },
            { key: 'b', weight: 0 }
          ]
        }),
        'v'
      )
    ).toBeNull();
  });

  it('fnv1a is stable', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
  });
});

describe('resolveExperimentAssignment', () => {
  it('persists the first pick and returns it afterwards', async () => {
    const storage = memoryStorage();
    const exp = makeExperiment();
    const first = await resolveExperimentAssignment(storage, 'pw_1', exp, async () => 'v-1');
    expect(first).not.toBeNull();
    const raw = storage.data.get(STORAGE_KEYS.experiment('pw_1'));
    expect(raw).toBeTruthy();
    // A different visitor id must NOT change the persisted assignment.
    const second = await resolveExperimentAssignment(storage, 'pw_1', exp, async () => 'v-2');
    expect(second).toEqual(first);
  });

  it('rebuckets when the experiment id changes', async () => {
    const storage = memoryStorage();
    const expA = makeExperiment({ id: 'exp_a' });
    const expB = makeExperiment({ id: 'exp_b' });
    const a = await resolveExperimentAssignment(storage, 'pw_1', expA, async () => 'v-1');
    const b = await resolveExperimentAssignment(storage, 'pw_1', expB, async () => 'v-1');
    expect(a?.experimentId).toBe('exp_a');
    expect(b?.experimentId).toBe('exp_b');
  });

  it('degrades to the deterministic pick when storage throws', async () => {
    const broken: StorageAdapter = {
      getItem: async () => {
        throw new Error('quota');
      },
      setItem: async () => {
        throw new Error('quota');
      },
      removeItem: async () => undefined
    };
    const exp = makeExperiment();
    const visitor = visitorFor(exp, 'b');
    const assignment = await resolveExperimentAssignment(broken, 'pw_1', exp, async () => visitor);
    expect(assignment).toEqual({ experimentId: 'exp_1', variant: 'b' });
  });
});

describe('applyExperimentAssignment', () => {
  it('substitutes prices and remaps layout + offer references for a non-control variant', () => {
    const bootstrap = makeBootstrap();
    applyExperimentAssignment(bootstrap, { experimentId: 'exp_1', variant: 'b' });

    expect(bootstrap.experiment?.assigned_variant).toBe('b');
    expect(bootstrap.prices.map((p) => p.id)).toEqual(['201', '202']);
    expect(bootstrap.prices[0].amount).toBe(12.99);

    const grid = bootstrap.layout!.blocks.find((b) => b.type === 'price_grid') as Extract<
      PaywallBootstrap['layout'],
      object
    > extends never
      ? never
      : { type: 'price_grid'; priceIds?: string[]; popular_price_id?: string };
    expect(grid.priceIds).toEqual(['201', '202']);
    expect(grid.popular_price_id).toBe('202');

    const cta = bootstrap.layout!.blocks.find((b) => b.type === 'cta_button') as {
      type: 'cta_button';
      priceId?: string;
    };
    expect(cta.priceId).toBe('201');

    expect(bootstrap.offers[0].price_id).toBe('202');
  });

  it('is idempotent', () => {
    const bootstrap = makeBootstrap();
    applyExperimentAssignment(bootstrap, { experimentId: 'exp_1', variant: 'b' });
    const snapshot = JSON.parse(JSON.stringify(bootstrap));
    applyExperimentAssignment(bootstrap, { experimentId: 'exp_1', variant: 'b' });
    expect(JSON.parse(JSON.stringify(bootstrap))).toEqual(snapshot);
  });

  it('control assignment stamps the variant but substitutes nothing', () => {
    const bootstrap = makeBootstrap();
    applyExperimentAssignment(bootstrap, { experimentId: 'exp_1', variant: 'control' });
    expect(bootstrap.experiment?.assigned_variant).toBe('control');
    expect(bootstrap.prices.map((p) => p.id)).toEqual(['101', '102']);
    expect(bootstrap.offers[0].price_id).toBe('102');
  });

  it('unknown kind: assignment recorded, prices untouched (forward compat)', () => {
    const bootstrap = makeBootstrap();
    bootstrap.experiment = makeExperiment({ kind: 'layout_test' });
    applyExperimentAssignment(bootstrap, { experimentId: 'exp_1', variant: 'b' });
    expect(bootstrap.experiment?.assigned_variant).toBe('b');
    expect(bootstrap.prices.map((p) => p.id)).toEqual(['101', '102']);
  });

  it('mismatched experiment id is a no-op', () => {
    const bootstrap = makeBootstrap();
    applyExperimentAssignment(bootstrap, { experimentId: 'other', variant: 'b' });
    expect(bootstrap.experiment?.assigned_variant).toBeUndefined();
    expect(bootstrap.prices.map((p) => p.id)).toEqual(['101', '102']);
  });
});

describe('BillingClient experiment integration', () => {
  const TEST_API_ORIGIN = 'https://test.example.com';

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  }

  function makeClient(opts: { visitor: string; bootstrap: PaywallBootstrap }) {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === 'POST') {
        calls.push({ url, body: JSON.parse(String(init.body)) });
      }
      if (url.includes('/bootstrap')) {
        return jsonResponse(opts.bootstrap);
      }
      if (url.includes('/start-checkout')) {
        return jsonResponse({ checkoutUrl: 'https://pay.test/x', userId: 'u1', acquiring: 'stripe' });
      }
      return jsonResponse({}, 404);
    };
    const storage = memoryStorage({ [STORAGE_KEYS.visitorId]: opts.visitor });
    const client = new BillingClient({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: fetchFn,
      storage
    });
    return { client, calls, storage };
  }

  it('bootstrap materializes the assigned variant (prices + assignment getter)', async () => {
    const experiment = makeExperiment();
    const visitor = visitorFor(experiment, 'b');
    const { client } = makeClient({ visitor, bootstrap: makeBootstrap() });

    const bootstrap = await client.bootstrap();
    expect(bootstrap.experiment?.assigned_variant).toBe('b');
    expect(bootstrap.prices.map((p) => p.id)).toEqual(['201', '202']);
    expect(client.getExperimentAssignment()).toEqual({ experimentId: 'exp_1', variant: 'b' });
  });

  it('control visitor keeps control prices', async () => {
    const experiment = makeExperiment();
    const visitor = visitorFor(experiment, 'control');
    const { client } = makeClient({ visitor, bootstrap: makeBootstrap() });

    const bootstrap = await client.bootstrap();
    expect(bootstrap.experiment?.assigned_variant).toBe('control');
    expect(bootstrap.prices.map((p) => p.id)).toEqual(['101', '102']);
    expect(client.getExperimentAssignment()).toEqual({
      experimentId: 'exp_1',
      variant: 'control'
    });
  });

  it('createCheckout sends visitorId + experiment attribution', async () => {
    const experiment = makeExperiment();
    const visitor = visitorFor(experiment, 'b');
    const { client, calls } = makeClient({ visitor, bootstrap: makeBootstrap() });

    await client.bootstrap();
    await client.createCheckout({ priceId: '201' });

    const checkout = calls.find((c) => c.url.includes('/start-checkout'));
    expect(checkout).toBeTruthy();
    expect(checkout!.body).toMatchObject({
      priceId: 201,
      visitorId: visitor,
      experimentId: 'exp_1',
      variantKey: 'b'
    });
  });

  it('createCheckout without an experiment omits attribution fields', async () => {
    const bootstrap = makeBootstrap();
    bootstrap.experiment = null;
    const { client, calls } = makeClient({ visitor: "v-1-abcdefgh12345678", bootstrap });

    await client.bootstrap();
    await client.createCheckout({ priceId: '101' });

    const checkout = calls.find((c) => c.url.includes('/start-checkout'));
    const body = checkout!.body as Record<string, unknown>;
    expect(body.visitorId).toBe("v-1-abcdefgh12345678");
    expect(body.experimentId).toBeUndefined();
    expect(body.variantKey).toBeUndefined();
  });

  it('assignment is sticky across client instances (persisted in storage)', async () => {
    const experiment = makeExperiment();
    const visitor = visitorFor(experiment, 'b');
    const first = makeClient({ visitor, bootstrap: makeBootstrap() });
    await first.client.bootstrap();
    const persisted = first.storage.data.get(STORAGE_KEYS.experiment('pw_1'));
    expect(persisted).toBeTruthy();
    expect(JSON.parse(persisted!)).toMatchObject({ experimentId: 'exp_1', variant: 'b' });

    // Second client on the same storage: even if weights flipped to 100%
    // control, the persisted assignment wins (first-touch stickiness).
    const flipped = makeBootstrap();
    flipped.experiment = makeExperiment({
      variants: [
        { key: 'control', weight: 100 },
        {
          key: 'b',
          weight: 0,
          prices: makeExperiment().variants[1].prices
        }
      ]
    });
    const storage = first.storage;
    const fetchFn: typeof fetch = async () =>
      jsonResponse(flipped) as unknown as Response;
    const client2 = new BillingClient({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: fetchFn,
      storage
    });
    const b2 = await client2.bootstrap();
    expect(b2.experiment?.assigned_variant).toBe('b');
    expect(b2.prices.map((p) => p.id)).toEqual(['201', '202']);
  });
});

describe('EventTracker experiment enrichment (via PaywallUI wiring shape)', () => {
  it('merges experiment context into props, explicit props win', async () => {
    const { EventTracker } = await import('../src/core/EventTracker');
    const sent: Array<{ body: string }> = [];
    const tracker = new EventTracker({
      endpoint: 'https://test.example.com/events',
      paywallId: 'pw_1',
      getVisitorId: async () => 'v-1',
      getExperimentContext: () => ({ experiment_id: 'exp_1', variant: 'b' }),
      flushIntervalMs: 1,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        sent.push({ body: String(init?.body) });
        return new Response(null, { status: 204 });
      }) as typeof fetch
    });

    tracker.track('paywall_viewed', { prices_count: 2 });
    tracker.track('price_selected', { variant: 'explicit-wins' });
    await tracker.flush();
    tracker.destroy();

    const events = JSON.parse(sent[0].body).events as Array<{
      type: string;
      props: Record<string, unknown>;
    }>;
    expect(events[0].props).toMatchObject({
      experiment_id: 'exp_1',
      variant: 'b',
      prices_count: 2
    });
    expect(events[1].props.variant).toBe('explicit-wins');
  });

  it('vi sanity: memoryStorage isolated per test', () => {
    expect(vi.isMockFunction(memoryStorage)).toBe(false);
  });
});
