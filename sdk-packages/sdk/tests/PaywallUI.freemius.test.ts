// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaywallUI } from '../src/ui/PaywallUI';
import type { PaywallBootstrap, PaywallUser } from '../src/core/types';

const TEST_API_ORIGIN = 'https://test.example.com';

// Freemius hosted checkout does not support a per-checkout success URL: the
// post-payment redirect is pinned in the client's Developer Dashboard and
// ignores the query, so the SDK CANNOT rely on paywall_status markers in the
// URL for freemius. The entire post-payment signal comes only through
// UserWatcher polling /user-state, into which the freemius webhook has already
// written has_active_subscription=true.
//
// The tests below lock down the contract: createCheckout with acquiring=freemius
// works like a normal flow (window.open + awaiting_payment), and the watcher
// honestly emits purchase_completed once the user-state changes, without URL
// markers.

const SETTINGS_BOOTSTRAP: PaywallBootstrap = {
  settings: { id: 'pw_1', name: 'Pro' },
  prices: [
    {
      id: 'price_1',
      currency: 'USD',
      amount: 9.99,
      interval: 'month',
      interval_count: 1,
      trial_days: null
    }
  ],
  offers: [],
  layout: {
    type: 'modal',
    blocks: [
      { type: 'price_grid', priceIds: ['price_1'] },
      { type: 'cta_button', label: 'Continue', action: 'checkout' }
    ]
  }
};

const EMPTY_USER: PaywallUser = {
  has_active_subscription: false,
  purchases: [],
  trial: null,
  had_previous_trial: false
};

const ACTIVE_USER: PaywallUser = {
  has_active_subscription: true,
  purchases: [
    {
      id: 'sub_1',
      status: 'active',
      current_period_end: '2099-01-01T00:00:00Z',
      cancel_at_period_end: false
    }
  ],
  trial: null,
  had_previous_trial: false
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

interface RoutedFetch {
  fn: typeof fetch;
  userStateCalls: () => number;
  startCheckoutCalls: () => number;
  setActive: () => void;
}

function freshStorage() {
  return {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {})
  };
}

// Routes /bootstrap, /start-checkout and /user-state. user-state returns EMPTY
// until setActive(), then ACTIVE — simulating the freemius webhook arriving
// with a delay.
function routedFetch(): RoutedFetch {
  let active = false;
  const fn = vi.fn<typeof fetch>(async (input) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/bootstrap')) return jsonResponse(SETTINGS_BOOTSTRAP);
    if (url.includes('/start-checkout')) {
      return jsonResponse({
        checkoutUrl: 'https://checkout.freemius.com/product/123/plan/456/?billing_cycle=monthly',
        userId: 'u_42',
        acquiring: 'freemius'
      });
    }
    if (url.includes('/user-state')) {
      return jsonResponse(active ? ACTIVE_USER : EMPTY_USER);
    }
    return jsonResponse({ error: 'unexpected', url }, 404);
  });
  const countByPath = (needle: string): number =>
    (fn as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => String(u).includes(needle)).length;
  return {
    fn,
    userStateCalls: () => countByPath('/user-state'),
    startCheckoutCalls: () => countByPath('/start-checkout'),
    setActive: () => {
      active = true;
    }
  };
}

describe('PaywallUI — freemius flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Simulate "the popup opened": runCheckout treats a non-null return from
    // window.open as success and does not redirect the current tab.
    vi.stubGlobal('open', vi.fn().mockReturnValue({} as Window));
    window.history.replaceState(null, '', '/');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('createCheckout returns the freemius hosted URL via SDK contract', async () => {
    const r = routedFetch();
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: r.fn,
      storage: freshStorage(),
      autoDetectReturn: false,
      analytics: false
    });

    const res = await ui.billing.createCheckout({ priceId: 'price_1' });
    expect(res.url).toBe(
      'https://checkout.freemius.com/product/123/plan/456/?billing_cycle=monthly'
    );
    expect(r.startCheckoutCalls()).toBe(1);
  });

  it('emits purchase_completed when watcher sees active=true (no URL markers)', async () => {
    // Full scenario: start the watcher via `checkout_started`, polling hits
    // /user-state, sees EMPTY → the next tick after setActive() sees ACTIVE →
    // the SDK emits purchase_completed without touching the URL.
    const r = routedFetch();
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      identity: { email: 'a@b.c' },
      fetch: r.fn,
      storage: freshStorage(),
      autoDetectReturn: false,
      analytics: false
    });

    const completed = vi.fn();
    ui.on('purchase_completed', completed);

    // Start the watcher directly, bypassing PaywallRoot mount: we care about the
    // post-checkout flow, not UI clickability (which is covered by other tests).
    (ui as unknown as { startUserWatcher: () => void }).startUserWatcher();

    // First tick (immediate check in start()) — EMPTY, emit nothing.
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).not.toHaveBeenCalled();

    // The freemius webhook "arrived" in our DB — the next tick will see ACTIVE.
    r.setActive();
    // visibleIntervalMs default 5000 — advance one polling tick.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledWith({ priceId: null, sessionId: null });

    // Final check: the URL was never touched — no markers appeared.
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('');
    // Polling actually hit /user-state (at least the immediate check + one tick).
    expect(r.userStateCalls()).toBeGreaterThanOrEqual(2);
  });

  it('checkReturn is a no-op for freemius landing without paywall_status', () => {
    // Freemius redirects to /freemius/return — there are NO markers there, and
    // the SDK (if it somehow got loaded on this page) should not emit anything.
    window.history.replaceState(null, '', '/freemius/return');
    const r = routedFetch();
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: r.fn,
      storage: freshStorage(),
      autoDetectReturn: false,
      analytics: false
    });

    const completed = vi.fn();
    const failed = vi.fn();
    ui.on('purchase_completed', completed);
    ui.on('purchase_failed', failed);

    ui.checkReturn();

    expect(completed).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });
});
