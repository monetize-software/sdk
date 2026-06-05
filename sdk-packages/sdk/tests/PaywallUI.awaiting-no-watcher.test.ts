// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaywallUI } from '../src/ui/PaywallUI';
import { shouldRunUserWatcher } from '../src/ui/UserWatcher';
import type { PaywallBootstrap, PaywallUser } from '../src/core/types';

// Regression: the awaiting→success transition must NOT be bound exclusively to
// UserWatcher. In a full extension page on chrome-extension:// the watcher used
// to be disabled for the whole protocol (shouldRunUserWatcher === false), and
// the transition funnelled only through watcher.onActive — so neither the
// background poll nor the manual "I've paid" button (which posted a window
// message to wake the watcher) could close the awaiting screen even though
// /user-state already returned has_active_subscription=true.
//
// The fix funnels the transition through billing.onUserChange: any fresh active
// user-state (manual getUser, cross-context broadcast, or the watcher) emits
// purchase_completed — guarded on the checkout views so an already-subscribed
// open doesn't false-trigger.

const TEST_API_ORIGIN = 'https://test.example.com';

const BOOTSTRAP: PaywallBootstrap = {
  settings: { id: 'pw_1', name: 'Pro' },
  prices: [
    { id: 'price_1', currency: 'USD', amount: 9.99, interval: 'month', interval_count: 1, trial_days: null }
  ],
  offers: [],
  layout: { type: 'modal', blocks: [{ type: 'price_grid', priceIds: ['price_1'] }] }
};

const EMPTY_USER: PaywallUser = {
  has_active_subscription: false,
  purchases: [],
  trial: null,
  had_previous_trial: false
};

const ACTIVE_USER: PaywallUser = {
  has_active_subscription: true,
  purchases: [{ id: 'cs_1', status: 'paid', current_period_end: null, cancel_at_period_end: null }],
  trial: null,
  had_previous_trial: false
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function freshStorage() {
  return {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {})
  };
}

function activeUserStateFetch() {
  return vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/bootstrap')) return jsonResponse(BOOTSTRAP);
    if (url.includes('/user-state')) return jsonResponse(ACTIVE_USER);
    return jsonResponse({ error: 'unexpected', url }, 404);
  });
}

function makeUI(fetchFn: typeof fetch) {
  return new PaywallUI({
    apiOrigin: TEST_API_ORIGIN,
    paywallId: 'pw_1',
    identity: { email: 'a@b.c' },
    fetch: fetchFn,
    storage: freshStorage(),
    autoDetectReturn: false,
    analytics: false
  });
}

describe('PaywallUI — awaiting transition without a watcher', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shouldRunUserWatcher runs wherever there is a DOM (no protocol gate)', () => {
    // jsdom provides document + window; the watcher is no longer gated out by
    // the chrome-extension:// protocol — a surviving extension page must poll.
    expect(shouldRunUserWatcher()).toBe(true);
  });

  it('emits purchase_completed when active user-state arrives during awaiting (manual button / no watcher)', async () => {
    const ui = makeUI(activeUserStateFetch());
    const completed = vi.fn();
    ui.on('purchase_completed', completed);

    // Simulate the awaiting_payment screen being shown post-checkout, with NO
    // watcher running (as on a chrome-extension:// extension page).
    (ui as unknown as { lastMountedView: string }).lastMountedView = 'awaiting_payment';

    // The manual "I've paid" button does exactly this: getUser({force:true}).
    // The fresh active user-state lands in onUserChange → handlePurchaseDetected.
    await ui.billing.getUser({ force: true });

    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledWith({ priceId: null, sessionId: null });
  });

  it('is idempotent — a second active user-state does not re-emit', async () => {
    const ui = makeUI(activeUserStateFetch());
    const completed = vi.fn();
    ui.on('purchase_completed', completed);
    (ui as unknown as { lastMountedView: string }).lastMountedView = 'awaiting_payment';

    await ui.billing.getUser({ force: true });
    await ui.billing.getUser({ force: true });

    expect(completed).toHaveBeenCalledTimes(1);
  });

  it('does NOT transition when active user-state arrives outside a checkout flow', async () => {
    const ui = makeUI(activeUserStateFetch());
    const completed = vi.fn();
    ui.on('purchase_completed', completed);

    // 'layout' = the paywall is just open (e.g. for an already-subscribed user);
    // getAccess handles that as granted, awaiting is never mounted.
    (ui as unknown as { lastMountedView: string }).lastMountedView = 'layout';

    await ui.billing.getUser({ force: true });

    expect(completed).not.toHaveBeenCalled();
  });
});
