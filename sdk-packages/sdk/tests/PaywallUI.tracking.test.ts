// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaywallUI } from '../src/ui/PaywallUI';

// Тесты интеграции EventTracker внутрь PaywallUI:
// - системные emit'ы автоматически пробрасываются как track-события;
// - public track() работает;
// - analytics: false полностью отключает.

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

  it('forwards open/close/ready/price_selected/checkout_started/purchase_completed/purchase_failed', async () => {
    const { ui, calls } = makeUI();

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
      'paywall_opened',
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
    // даём destroy() сделать flush
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    const beforeCount = calls.length;
    ui.track('paywall_closed');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.length).toBe(beforeCount);
  });
});
