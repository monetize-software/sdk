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
});
