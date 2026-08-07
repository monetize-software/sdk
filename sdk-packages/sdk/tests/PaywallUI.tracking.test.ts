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

/** In-memory StorageAdapter shared between "instances" — stands in for
 *  chrome.storage, which popup / content-script / offscreen all see. */
function makeSharedStorage() {
  const map = new Map<string, string>();
  return {
    getItem: async (k: string) => map.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: async (k: string) => {
      map.delete(k);
    }
  };
}

function makeUI(
  opts: {
    analytics?: boolean | Record<string, unknown>;
    storage?: ReturnType<typeof makeSharedStorage>;
  } = {}
) {
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
    analytics,
    ...(opts.storage ? { storage: opts.storage } : {})
  });

  return { ui, calls };
}

/** Pretend the billing cache holds these purchases — the key source when the
 *  event carries no session id (the extension path). */
function stubPurchases(ui: PaywallUI, ids: string[]) {
  (ui as unknown as { billing: { getCachedUser: () => unknown } }).billing.getCachedUser =
    () => ({ has_active_subscription: true, purchases: ids.map((id) => ({ id })) });
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

  // handlePurchaseDetected fires on every discovery of an active subscription,
  // and `this.purchased` only dedupes within one instance — in an extension a
  // re-created popup re-reported the same purchase (up to 21 per visitor).
  // The dedupe is keyed on the purchase itself and backed by storage.
  // The hold's own contract, driven directly so no jsdom render race can make
  // the assertion pass for the wrong reason. `ready` during a pending gate must
  // be held, then replayed or dropped depending on how the gate resolves.
  function armHold(ui: PaywallUI) {
    (ui as unknown as { viewedGatePending: boolean }).viewedGatePending = true;
  }
  function releaseHold(ui: PaywallUI, passed: boolean) {
    (ui as unknown as { releaseViewedGate: (p: boolean) => void }).releaseViewedGate(passed);
  }
  const readyPayload = {
    settings: { id: 'pw_1', name: 'X', is_test_mode: false },
    prices: [{ id: '1' }] as unknown[],
    offers: [] as unknown[]
  };

  it('a held view is replayed when the gates pass, and pairs with a later close', async () => {
    const { ui, calls } = makeUI();
    setMountedView(ui, 'layout');
    armHold(ui);

    emit(ui, 'ready', readyPayload);
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toHaveLength(0); // held, not tracked yet

    releaseHold(ui, true);
    emit(ui, 'close');
    await vi.advanceTimersByTimeAsync(50);

    const types = calls.flatMap((c) =>
      (JSON.parse(c.init.body as string).events as Array<{ type: string }>).map((e) => e.type)
    );
    expect(types).toEqual(['paywall_viewed', 'paywall_closed']);
  });

  it('a held view is dropped when a gate blocks', async () => {
    const { ui, calls } = makeUI();
    setMountedView(ui, 'layout');
    armHold(ui);

    emit(ui, 'ready', readyPayload);
    releaseHold(ui, false);
    emit(ui, 'close');
    await vi.advanceTimersByTimeAsync(50);

    expect(calls).toHaveLength(0);
  });

  it('the user closing during a hold keeps the view, a late ready adds nothing', async () => {
    const { ui, calls } = makeUI();
    setMountedView(ui, 'layout');
    armHold(ui);

    emit(ui, 'ready', readyPayload);
    emit(ui, 'close'); // user-initiated: the layout had rendered
    emit(ui, 'ready', readyPayload); // arrives after the mount is over
    await vi.advanceTimersByTimeAsync(50);

    const types = calls.flatMap((c) =>
      (JSON.parse(c.init.body as string).events as Array<{ type: string }>).map((e) => e.type)
    );
    expect(types).toEqual(['paywall_viewed', 'paywall_closed']);
  });

  it('the same purchase is tracked once, a new one is tracked again', async () => {
    const { ui, calls } = makeUI();
    setMountedView(ui, 'layout');

    emit(ui, 'purchase_completed', { priceId: '1', sessionId: 'cs_a' });
    emit(ui, 'purchase_completed', { priceId: '1', sessionId: 'cs_a' });
    emit(ui, 'purchase_completed', { priceId: '2', sessionId: 'cs_b' });
    await vi.advanceTimersByTimeAsync(50);

    const events = calls.flatMap(
      (c) => JSON.parse(c.init.body as string).events as Array<{ type: string; props: Record<string, unknown> }>
    );
    expect(events.map((e) => e.type)).toEqual(['purchase_completed', 'purchase_completed']);
    expect(events.map((e) => e.props.session_id)).toEqual(['cs_a', 'cs_b']);
  });

  // Without a session id the key comes from the active purchase ids, which is
  // what the extension path actually carries (every production event so far had
  // an empty session_id).
  it('re-discovered subscription without a session id is tracked once', async () => {
    const { ui, calls } = makeUI();
    setMountedView(ui, 'layout');
    stubPurchases(ui, ['sub_01ky']);

    emit(ui, 'purchase_completed', { priceId: null, sessionId: null });
    emit(ui, 'purchase_completed', { priceId: null, sessionId: null });
    await vi.advanceTimersByTimeAsync(50);

    const events = calls.flatMap(
      (c) => JSON.parse(c.init.body as string).events as Array<{ type: string }>
    );
    expect(events.map((e) => e.type)).toEqual(['purchase_completed']);
  });

  // The actual production shape: the popup is destroyed when it loses focus, so
  // every open builds a fresh PaywallUI whose in-instance `purchased` flag is
  // useless. Only shared storage can suppress the re-report.
  it('a re-created instance does not re-report the same purchase', async () => {
    const storage = makeSharedStorage();

    const first = makeUI({ storage });
    setMountedView(first.ui, 'layout');
    stubPurchases(first.ui, ['sub_01ky']);
    emit(first.ui, 'purchase_completed', { priceId: null, sessionId: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(first.calls).toHaveLength(1);

    // The popup was re-opened: a brand-new instance over the same storage.
    const second = makeUI({ storage });
    await vi.advanceTimersByTimeAsync(10); // let the mirror warm from storage
    setMountedView(second.ui, 'layout');
    stubPurchases(second.ui, ['sub_01ky']);
    emit(second.ui, 'purchase_completed', { priceId: null, sessionId: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(second.calls).toHaveLength(0);

    // A genuinely new subscription on the same device still counts.
    const third = makeUI({ storage });
    await vi.advanceTimersByTimeAsync(10);
    setMountedView(third.ui, 'layout');
    stubPurchases(third.ui, ['sub_01ky', 'sub_02nz']);
    emit(third.ui, 'purchase_completed', { priceId: null, sessionId: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(third.calls).toHaveLength(1);
  });

  // The upgrade case, and the cardinal risk of this dedupe. A subscriber who
  // buys again keeps their existing purchase ids, so the key equals the one
  // stored when that subscription was first bought — keying alone would swallow
  // the upgrade entirely. A checkout started in this instance means the user is
  // actively buying, which must bypass the dedupe.
  it('a purchase after a checkout in this instance is never suppressed', async () => {
    const storage = makeSharedStorage();

    const first = makeUI({ storage });
    setMountedView(first.ui, 'layout');
    stubPurchases(first.ui, ['sub_01ky']);
    emit(first.ui, 'purchase_completed', { priceId: null, sessionId: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(first.calls).toHaveLength(1);

    // Same device, same (still unchanged) purchase list — but this time the
    // user actually went through checkout, e.g. a renew/upgrade.
    const upgrade = makeUI({ storage });
    await vi.advanceTimersByTimeAsync(10);
    setMountedView(upgrade.ui, 'layout');
    stubPurchases(upgrade.ui, ['sub_01ky']);
    emit(upgrade.ui, 'checkout_started', { priceId: '2', url: 'https://x' });
    emit(upgrade.ui, 'purchase_completed', { priceId: '2', sessionId: null });
    await vi.advanceTimersByTimeAsync(50);

    const types = upgrade.calls.flatMap((c) =>
      (JSON.parse(c.init.body as string).events as Array<{ type: string }>).map((e) => e.type)
    );
    expect(types).toContain('purchase_completed');
  });

  // A storage that fails must never cost a reported purchase.
  it('purchase is still reported when storage is unusable', async () => {
    const brokenStorage = {
      getItem: async () => {
        throw new Error('storage gone');
      },
      setItem: async () => {
        throw new Error('storage gone');
      },
      removeItem: async () => {
        throw new Error('storage gone');
      }
    };
    const { ui, calls } = makeUI({ storage: brokenStorage });
    setMountedView(ui, 'layout');
    stubPurchases(ui, ['sub_01ky']);

    emit(ui, 'purchase_completed', { priceId: null, sessionId: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toHaveLength(1);
  });

  it('corrupt stored keys do not break reporting', async () => {
    const garbage = {
      getItem: async (): Promise<string | null> => 'not json at all',
      setItem: async (): Promise<void> => undefined,
      removeItem: async (): Promise<void> => undefined
    };
    const { ui, calls } = makeUI({ storage: garbage });
    setMountedView(ui, 'layout');
    stubPurchases(ui, ['sub_01ky']);

    emit(ui, 'purchase_completed', { priceId: null, sessionId: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toHaveLength(1);
  });

  // Nothing stable to key on — report rather than risk swallowing a real sale.
  it('purchase with neither session id nor purchases is not suppressed', async () => {
    const { ui, calls } = makeUI();
    setMountedView(ui, 'layout');
    stubPurchases(ui, []);

    emit(ui, 'purchase_completed', { priceId: null, sessionId: null });
    emit(ui, 'purchase_completed', { priceId: null, sessionId: null });
    await vi.advanceTimersByTimeAsync(50);

    const events = calls.flatMap(
      (c) => JSON.parse(c.init.body as string).events as Array<{ type: string }>
    );
    expect(events).toHaveLength(2);
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

  // With an identity the subscription gate awaits getSettledUser (a network
  // /user-state) before the visibility gate ever runs. The layout renders and
  // emits 'ready' during that await — the production shape of paywall 837,
  // where a disabled paywall still reported ~800 views/day. The harness above
  // can't reproduce it: without an identity canResolveUser() is false, the
  // gate resolves in one tick and beats the render.
  function slowUserStateHarness(bootstrapBody: unknown, userStateDelayMs: number) {
    const tracked: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString();
      if (url.includes('/events')) {
        const body = JSON.parse((init?.body as string) ?? '{}');
        for (const e of body.events ?? []) tracked.push(e.type);
        return new Response(null, { status: 204 });
      }
      if (url.includes('/user-state')) {
        await new Promise((r) => setTimeout(r, userStateDelayMs));
        return new Response(JSON.stringify({ user: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
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

  const GATE_DELAY = 700;

  // The bug in production (paywall 837): the layout renders and emits 'ready'
  // BEFORE the delayed gate resolves — the subscription gate awaits
  // getSettledUser over the network, so the gate can trail the render by
  // hundreds of ms. The gate then blocks and closes, leaving a viewed/closed
  // pair for a paywall that was never allowed to open. jsdom won't reproduce
  // that ordering on its own (the layout there renders only once user-state
  // settles, i.e. after the gate), so the render is injected explicitly: a
  // slow bootstrap keeps the hold open while a hand-emitted 'ready' plays the
  // part of the rendered layout.
  function slowBootstrapHarness(bootstrapBody: unknown, delayMs: number) {
    const tracked: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString();
      if (url.includes('/events')) {
        const body = JSON.parse((init?.body as string) ?? '{}');
        for (const e of body.events ?? []) tracked.push(e.type);
        return new Response(null, { status: 204 });
      }
      await new Promise((r) => setTimeout(r, delayMs));
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

  const blockedBootstrap = {
    ...base,
    settings: {
      name: 'T',
      is_test_mode: false,
      visibility: { visible: false, reason: 'disabled', country: 'US', tier: 1 }
    },
    user: null as unknown
  };

  it('layout renders before the gate resolves: the block leaves no phantom view', async () => {
    const { ui, tracked } = slowBootstrapHarness(blockedBootstrap, 400);
    ui.open();
    // The layout painted while bootstrap was still in flight — the exact
    // ordering that produced ~800 phantom views/day on a disabled paywall.
    await new Promise((r) => setTimeout(r, 100));
    emit(ui, 'ready', blockedBootstrap);
    await new Promise((r) => setTimeout(r, 600));
    expect(tracked).toEqual(['visibility_blocked']);
  });

  // The subscription gate is the highest-volume one — it fires on every
  // subscriber's open. Its suppress must leave analytics completely silent.
  it('subscription-suppressed flash with a rendered layout stays silent', async () => {
    const subscriberBootstrap = {
      ...base,
      settings: { name: 'T', is_test_mode: false },
      user: {
        has_active_subscription: true,
        purchases: [] as unknown[],
        trial: null as unknown
      }
    };
    const { ui, tracked } = slowBootstrapHarness(subscriberBootstrap, 400);
    ui.open();
    await new Promise((r) => setTimeout(r, 100));
    emit(ui, 'ready', subscriberBootstrap);
    await new Promise((r) => setTimeout(r, 600));
    expect(tracked).toEqual([]);
  });

  it('visibility-blocked with a slow subscription gate: no phantom viewed/closed', async () => {
    const { ui, tracked } = slowUserStateHarness(blockedBootstrap, GATE_DELAY);
    ui.open({ identity: { email: 'u@example.com' } });
    await new Promise((r) => setTimeout(r, GATE_DELAY + 300));
    expect(tracked).toEqual(['visibility_blocked']);
  });
});
