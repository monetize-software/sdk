// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaywallUI } from '../src/ui/PaywallUI';

const TEST_API_ORIGIN = 'https://test.example.com';

// Tests for integrating EventTracker into PaywallUI:
// - system emits are automatically forwarded as track events;
// - public track() works;
// - analytics: false disables it entirely.

const noopFetch: typeof fetch = async () =>
  new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeUI(opts: { analytics?: boolean | Record<string, unknown> } = {}) {
  const calls: FetchCall[] = [];
  const fetchSpy: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url.endsWith('/events')) {
      calls.push({ url, init: init ?? {} });
      return new Response(null, { status: 204 });
    }
    return noopFetch(input as RequestInfo, init);
  };

  const baseAnalytics = { flushIntervalMs: 30, maxBufferSize: 100, fetch: fetchSpy };
  let analytics: false | Record<string, unknown> = baseAnalytics;
  if (opts.analytics === false) {
    analytics = false;
  } else if (opts.analytics && typeof opts.analytics === 'object') {
    analytics = { ...baseAnalytics, ...opts.analytics };
  }

  const ui = new PaywallUI({
    apiOrigin: TEST_API_ORIGIN,
    paywallId: 'pw_1',
    fetch: fetchSpy,
    autoDetectReturn: false,
    analytics
  });

  return { ui, calls };
}

function emit(ui: PaywallUI, event: string, payload?: unknown) {
  (ui as unknown as { emit: (e: string, p?: unknown) => void }).emit(event, payload);
}

// paywall_viewed/paywall_closed are gated on lastMountedView ===
// 'layout' — in normal operation it is set by mountAndShow. In unit tests that
// emit events directly, we set it by hand.
function setMountedView(ui: PaywallUI, view: string | null) {
  (ui as unknown as { lastMountedView: string | null }).lastMountedView = view;
}

describe('PaywallUI tracking integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('public track() pushes to tracker', async () => {
    const { ui, calls } = makeUI();
    ui.track('app_opened', { source: 'main' });
    await vi.advanceTimersByTimeAsync(50);

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.events[0]).toMatchObject({
      type: 'app_opened',
      props: { source: 'main' }
    });
  });

  it('forwards ready/price_selected/checkout_started/purchase_completed/purchase_failed/close', async () => {
    const { ui, calls } = makeUI();
    setMountedView(ui, 'layout');

    // 'open' is no longer tracked separately — showing the paywall records 'viewed'.
    emit(ui, 'open');
    emit(ui, 'ready', {
      settings: { id: 'pw_1', name: 'X', is_test_mode: false },
      prices: [{ id: '1' }, { id: '2' }],
      offers: []
    });
    emit(ui, 'price_selected', { priceId: '1', price: {} });
    emit(ui, 'checkout_started', { priceId: '1', url: 'https://x' });
    emit(ui, 'purchase_completed', { priceId: '1', sessionId: 's1' });
    emit(ui, 'purchase_failed', { reason: 'cancelled' });
    emit(ui, 'close');

    await vi.advanceTimersByTimeAsync(50);

    expect(calls).toHaveLength(1);
    const types = JSON.parse(calls[0].init.body as string).events.map(
      (e: { type: string }) => e.type
    );
    expect(types).toEqual([
      'paywall_viewed',
      'price_selected',
      'checkout_started',
      'purchase_completed',
      'purchase_failed',
      'paywall_closed'
    ]);
  });

  it('paywall_viewed payload carries bootstrap counts and test-mode flag', async () => {
    const { ui, calls } = makeUI();
    setMountedView(ui, 'layout');
    emit(ui, 'ready', {
      settings: { id: 'pw_1', name: 'X', is_test_mode: true },
      prices: [{ id: '1' }, { id: '2' }, { id: '3' }],
      offers: [{ id: 'o1' }]
    });
    await vi.advanceTimersByTimeAsync(50);

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.events[0]).toMatchObject({
      type: 'paywall_viewed',
      props: { is_test_mode: true, prices_count: 3, offers_count: 1 }
    });
  });

  it('non-layout view (support/auth) does NOT emit paywall_viewed/closed', async () => {
    const { ui, calls } = makeUI();
    // Support is open — public open/ready/close are emitted, but this is not a "paywall".
    setMountedView(ui, 'support');

    emit(ui, 'open');
    emit(ui, 'ready', {
      settings: { id: 'pw_1', name: 'X', is_test_mode: false },
      prices: [{ id: '1' }],
      offers: []
    });
    // checkout inside the support flow (e.g. after restore) is still forwarded —
    // the gate applies only to paywall-lifecycle events, not the rest.
    emit(ui, 'price_selected', { priceId: '1', price: {} });
    emit(ui, 'close');

    await vi.advanceTimersByTimeAsync(50);

    const types = calls.length
      ? JSON.parse(calls[0].init.body as string).events.map((e: { type: string }) => e.type)
      : [];
    expect(types).not.toContain('paywall_viewed');
    expect(types).not.toContain('paywall_closed');
    expect(types).toContain('price_selected');
  });

  it('analytics: false disables tracker entirely', async () => {
    const { ui, calls } = makeUI({ analytics: false });
    ui.track('app_opened');
    emit(ui, 'open');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(0);
  });

  it('destroy() stops further tracking', async () => {
    const { ui, calls } = makeUI();
    ui.track('app_opened');
    ui.destroy();
    // let destroy() perform its flush
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    const beforeCount = calls.length;
    ui.track('paywall_closed');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.length).toBe(beforeCount);
  });

  it('purchase_completed with restored:true is NOT tracked (not a purchase)', async () => {
    const { ui, calls } = makeUI();
    setMountedView(ui, 'layout');

    emit(ui, 'purchase_completed', { priceId: null, sessionId: null, restored: true });
    emit(ui, 'purchase_completed', { priceId: '1', sessionId: 's1' });
    await vi.advanceTimersByTimeAsync(50);

    const types = JSON.parse(calls[0].init.body as string).events.map(
      (e: { type: string }) => e.type
    );
    expect(types).toEqual(['purchase_completed']);
    expect(JSON.parse(calls[0].init.body as string).events[0].props).toMatchObject({
      price_id: '1',
      session_id: 's1'
    });
  });
});

// Delayed-gate flash opens: mount-then-load mounts the spinner, the gate
// (visibility / trial / subscription) closes it before any paywall is seen.
// Only the gate's own event may reach analytics — no paywall_viewed and no
// paywall_closed (closed pairs strictly with a tracked viewed), and no
// purchase_completed for the suppressed-subscriber open (restored ≠ purchase).
// Real timers: the flow crosses network microtasks and preact effects.
describe('PaywallUI tracking on delayed-gate flash opens', () => {
  function flowHarness(bootstrapBody: unknown) {
    const tracked: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString();
      if (url.includes('/events')) {
        const body = JSON.parse((init?.body as string) ?? '{}');
        for (const e of body.events ?? []) tracked.push(e.type);
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify(bootstrapBody), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: fetchImpl,
      autoDetectReturn: false,
      analytics: { flushIntervalMs: 20, fetch: fetchImpl }
    });
    return { ui, tracked };
  }

  const base = {
    prices: [{ id: '1' }] as unknown[],
    offers: [] as unknown[],
    layout: { type: 'modal', blocks: [] as unknown[] }
  };
  const settle = () => new Promise((r) => setTimeout(r, 300));

  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    window.localStorage.clear();
  });

  it('trial-blocked flash: only trial_blocked is tracked', async () => {
    const { ui, tracked } = flowHarness({
      ...base,
      settings: {
        name: 'T',
        is_test_mode: false,
        trial: { mode: 'opens', payload: 3, storage: 'client' }
      },
      user: null
    });
    ui.open();
    await settle();
    expect(tracked).toEqual(['trial_blocked']);
  });

  it('visibility-blocked flash: only visibility_blocked is tracked', async () => {
    const { ui, tracked } = flowHarness({
      ...base,
      settings: {
        name: 'T',
        is_test_mode: false,
        visibility: { visible: false, reason: 'country_not_match', country: 'RU', tier: 3 }
      },
      user: null
    });
    ui.open();
    await settle();
    expect(tracked).toEqual(['visibility_blocked']);
  });

  it('subscription-suppressed flash: nothing is tracked', async () => {
    const { ui, tracked } = flowHarness({
      ...base,
      settings: { name: 'T', is_test_mode: false },
      user: { has_active_subscription: true, purchases: [] as unknown[], trial: null as unknown }
    });
    ui.open();
    await settle();
    expect(tracked).toEqual([]);
  });

  it('real layout show still tracks the viewed/closed pair', async () => {
    const { ui, tracked } = flowHarness({
      ...base,
      settings: { name: 'T', is_test_mode: false },
      user: null
    });
    ui.open();
    await settle();
    ui.close();
    await settle();
    expect(tracked).toEqual(['paywall_viewed', 'paywall_closed']);
  });
});
