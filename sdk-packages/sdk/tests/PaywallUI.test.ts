// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaywallUI } from '../src/ui/PaywallUI';

const TEST_API_ORIGIN = 'https://test.example.com';

// Minimal fetch stub — PaywallUI does not hit the network without open(), but
// the BillingClient constructor still sets up an ApiClient internally.
const noopFetch: typeof fetch = async () =>
  new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

function makeUI(autoDetectReturn = false) {
  return new PaywallUI({
    apiOrigin: TEST_API_ORIGIN,
    paywallId: 'pw_1',
    fetch: noopFetch,
    autoDetectReturn
  });
}

describe('PaywallUI events', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('delivers typed payload to handler', () => {
    const ui = makeUI();
    const handler = vi.fn<(p: { priceId: string | null; sessionId: string | null }) => void>();
    ui.on('purchase_completed', handler);
    (ui as unknown as { emit: Function }).emit('purchase_completed', {
      priceId: 'p1',
      sessionId: 's1'
    });
    expect(handler).toHaveBeenCalledWith({ priceId: 'p1', sessionId: 's1' });
  });

  it('unsubscribe via returned function', () => {
    const ui = makeUI();
    const handler = vi.fn();
    const unsub = ui.on('open', handler);
    unsub();
    (ui as unknown as { emit: Function }).emit('open');
    expect(handler).not.toHaveBeenCalled();
  });

  it('off() removes a handler', () => {
    const ui = makeUI();
    const handler = vi.fn();
    ui.on('close', handler);
    ui.off('close', handler);
    (ui as unknown as { emit: Function }).emit('close');
    expect(handler).not.toHaveBeenCalled();
  });

  it('listener exceptions are isolated', () => {
    const ui = makeUI();
    const good = vi.fn();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ui.on('open', bad);
    ui.on('open', good);
    (ui as unknown as { emit: Function }).emit('open');
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('PaywallUI.checkReturn (URL sniffer)', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('emits purchase_completed from ?paywall_status=paid query', () => {
    window.history.replaceState(
      null,
      '',
      '/?paywall_status=paid&paywall_price_id=8365&paywall_session_id=sess_1&keep=me'
    );
    const ui = makeUI();
    const handler = vi.fn();
    ui.on('purchase_completed', handler);

    ui.checkReturn();

    expect(handler).toHaveBeenCalledWith({ priceId: '8365', sessionId: 'sess_1' });
    // Markers removed, client-specific query preserved.
    expect(window.location.search).toBe('?keep=me');
  });

  it('emits purchase_completed from #paywall_status=paid hash', () => {
    window.history.replaceState(null, '', '/#paywall_status=paid&paywall_price_id=8365');
    const ui = makeUI();
    const handler = vi.fn();
    ui.on('purchase_completed', handler);

    ui.checkReturn();

    expect(handler).toHaveBeenCalledWith({ priceId: '8365', sessionId: null });
    expect(window.location.hash).toBe('');
  });

  it('hash takes precedence over query if both present', () => {
    window.history.replaceState(
      null,
      '',
      '/?paywall_status=failed#paywall_status=paid&paywall_price_id=hashed'
    );
    const ui = makeUI();
    const completed = vi.fn();
    const failed = vi.fn();
    ui.on('purchase_completed', completed);
    ui.on('purchase_failed', failed);

    ui.checkReturn();

    expect(completed).toHaveBeenCalledWith({ priceId: 'hashed', sessionId: null });
    expect(failed).not.toHaveBeenCalled();
  });

  it('emits purchase_failed for ?paywall_status=failed', () => {
    window.history.replaceState(null, '', '/?paywall_status=failed');
    const ui = makeUI();
    const handler = vi.fn();
    ui.on('purchase_failed', handler);

    ui.checkReturn();

    expect(handler).toHaveBeenCalledWith({ reason: 'failed' });
  });

  it('emits purchase_failed with reason=cancelled for ?paywall_status=cancelled', () => {
    window.history.replaceState(null, '', '/?paywall_status=cancelled');
    const ui = makeUI();
    const handler = vi.fn();
    ui.on('purchase_failed', handler);

    ui.checkReturn();

    expect(handler).toHaveBeenCalledWith({ reason: 'cancelled' });
  });

  it('does nothing when no markers present', () => {
    window.history.replaceState(null, '', '/?foo=bar');
    const ui = makeUI();
    const completed = vi.fn();
    const failed = vi.fn();
    ui.on('purchase_completed', completed);
    ui.on('purchase_failed', failed);

    ui.checkReturn();

    expect(completed).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?foo=bar');
  });

  it('autoDetectReturn runs checkReturn asynchronously (microtask)', async () => {
    window.history.replaceState(null, '', '/?paywall_status=paid');
    const ui = new PaywallUI({ apiOrigin: TEST_API_ORIGIN, paywallId: 'pw_1', fetch: noopFetch });
    const handler = vi.fn();
    // Subscribing synchronously right after the constructor — makes it in before the microtask.
    ui.on('purchase_completed', handler);

    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('PaywallUI.getAccess', () => {
  function makeBootstrap(settingsOverrides: Record<string, unknown> = {}, user: unknown = null) {
    return {
      settings: {
        name: 'Test',
        is_test_mode: false,
        ...settingsOverrides
      },
      prices: [] as unknown[],
      offers: [] as unknown[],
      layout: { type: 'modal', blocks: [] as unknown[] },
      user
    };
  }

  function fetchReturning(body: unknown): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch;
  }

  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    window.localStorage.clear();
  });

  it('blocks (no_subscription) when no gates configured and user has no subscription', async () => {
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: fetchReturning(makeBootstrap()),
      autoDetectReturn: false
    });
    const result = await ui.getAccess();
    expect(result.access).toBe('blocked');
    expect(result.reason).toBe('no_subscription');
  });

  it('grants (has_subscription) — overrides visibility and trial gates', async () => {
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: fetchReturning(
        makeBootstrap(
          {
            visibility: { visible: false, reason: 'country_not_match', country: 'RU', tier: 3 },
            trial: { mode: 'opens', payload: 3, storage: 'client' }
          },
          { has_active_subscription: true, purchases: [], trial: null }
        )
      ),
      autoDetectReturn: false
    });
    const result = await ui.getAccess();
    expect(result.access).toBe('granted');
    expect(result.reason).toBe('has_subscription');
  });

  it('grants (visibility_blocked) for users outside monetization scope', async () => {
    const visibility = {
      visible: false,
      reason: 'country_not_match' as const,
      country: 'RU',
      tier: 3 as const
    };
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: fetchReturning(makeBootstrap({ visibility })),
      autoDetectReturn: false
    });
    const result = await ui.getAccess();
    expect(result.access).toBe('granted');
    expect(result.reason).toBe('visibility_blocked');
    expect(result.visibility).toEqual(visibility);
    expect(ui.getVisibility()).toEqual(visibility);
  });

  it('grants (trial_blocked) without recording the block (idempotent)', async () => {
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: fetchReturning(
        makeBootstrap({ trial: { mode: 'opens', payload: 3, storage: 'client' } })
      ),
      autoDetectReturn: false
    });
    const r1 = await ui.getAccess();
    const r2 = await ui.getAccess();
    expect(r1.access).toBe('granted');
    expect(r1.reason).toBe('trial_blocked');
    expect(r2.access).toBe('granted');
    if (r1.trial?.mode === 'opens' && r2.trial?.mode === 'opens') {
      expect(r1.trial.remainingActions).toBe(r2.trial.remainingActions);
    } else {
      throw new Error('expected opens-mode trial status');
    }
  });

  it('skipVisibility / skipTrial bypass those gates and fall through to blocked', async () => {
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: fetchReturning(
        makeBootstrap({
          visibility: { visible: false, reason: 'disabled', country: 'US', tier: 1 },
          trial: { mode: 'opens', payload: 3, storage: 'client' }
        })
      ),
      autoDetectReturn: false
    });
    const result = await ui.getAccess({ skipVisibility: true, skipTrial: true });
    expect(result.access).toBe('blocked');
    expect(result.reason).toBe('no_subscription');
  });

  it('offline fallback: blocked when bootstrap fails and no cached user', async () => {
    const failingFetch: typeof fetch = async () => {
      throw new Error('network down');
    };
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: failingFetch,
      autoDetectReturn: false
    });
    const result = await ui.getAccess();
    expect(result.access).toBe('blocked');
    expect(result.reason).toBe('no_subscription');
    expect(result.user).toBeNull();
  });
});

// Phase 7 — mount-then-load. Goal: on a cold bootstrap the modal should mount
// immediately (snappy UX), with gates applied async once the data arrives. If a
// gate blocks — the modal closes and *_blocked is emitted.
//
// Default `mountThenLoad: true` is the main path. `false` is legacy for cases
// where the "opened → closed" flicker is worse than perceived latency.
describe('PaywallUI mount-then-load (Phase 7)', () => {
  function makeBootstrap(settingsOverrides: Record<string, unknown> = {}) {
    return {
      settings: { name: 'Test', is_test_mode: false, ...settingsOverrides },
      prices: [] as unknown[],
      offers: [] as unknown[],
      layout: { type: 'modal', blocks: [] as unknown[] },
      user: null as unknown
    };
  }

  function deferredFetch(body: unknown): {
    fetch: typeof fetch;
    resolve: () => void;
  } {
    let resolveFetch!: () => void;
    const gate = new Promise<void>((r) => {
      resolveFetch = r;
    });
    const fetchImpl: typeof fetch = (async () => {
      await gate;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof fetch;
    return { fetch: fetchImpl, resolve: resolveFetch };
  }

  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    window.localStorage.clear();
  });

  it('default mountThenLoad=true: open() emits "open" synchronously even with cold bootstrap', async () => {
    const { fetch, resolve } = deferredFetch(makeBootstrap());
    const ui = new PaywallUI({ apiOrigin: TEST_API_ORIGIN, paywallId: 'pw_1', fetch, autoDetectReturn: false });
    const onOpen = vi.fn();
    ui.on('open', onOpen);

    ui.open();
    // Bootstrap is still in flight — but open already fired (mount happened synchronously).
    expect(onOpen).toHaveBeenCalledTimes(1);

    resolve();
    await new Promise((r) => setTimeout(r, 0));
    // After the bootstrap resolves — gates passed (no visibility/trial), the
    // modal is open, and there is no second 'open'.
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('default + visibility_blocked: modal opens, then closes + emits visibility_blocked', async () => {
    const { fetch, resolve } = deferredFetch(
      makeBootstrap({
        visibility: { visible: false, reason: 'country_not_match', country: 'RU', tier: 3 }
      })
    );
    const ui = new PaywallUI({ apiOrigin: TEST_API_ORIGIN, paywallId: 'pw_1', fetch, autoDetectReturn: false });
    const events: string[] = [];
    ui.on('open', () => events.push('open'));
    ui.on('close', () => events.push('close'));
    ui.on('visibility_blocked', () => events.push('blocked'));

    ui.open();
    expect(events).toEqual(['open']);

    resolve();
    await new Promise((r) => setTimeout(r, 0));
    // Gate ran: the modal closed + visibility_blocked was emitted.
    expect(events).toEqual(['open', 'close', 'blocked']);
  });

  it('default + trial_blocked: modal opens, then closes + emits trial_blocked', async () => {
    const { fetch, resolve } = deferredFetch(
      makeBootstrap({ trial: { mode: 'opens', payload: 3, storage: 'client' } })
    );
    const ui = new PaywallUI({ apiOrigin: TEST_API_ORIGIN, paywallId: 'pw_1', fetch, autoDetectReturn: false });
    const events: string[] = [];
    ui.on('open', () => events.push('open'));
    ui.on('close', () => events.push('close'));
    ui.on('trial_blocked', () => events.push('blocked'));

    ui.open();
    expect(events).toEqual(['open']);

    resolve();
    // Trial check is async (storage); give it a chance to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(['open', 'close', 'blocked']);
  });

  it('mountThenLoad=false (legacy): open() does NOT emit "open" until bootstrap resolves', async () => {
    const { fetch, resolve } = deferredFetch(makeBootstrap());
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch,
      autoDetectReturn: false,
      mountThenLoad: false
    });
    const onOpen = vi.fn();
    ui.on('open', onOpen);

    ui.open();
    // Bootstrap has not arrived yet — the modal did not mount.
    expect(onOpen).not.toHaveBeenCalled();

    resolve();
    await new Promise((r) => setTimeout(r, 0));
    // Bootstrap resolved, gates passed — now mountAndShow.
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('mountThenLoad=false + visibility_blocked: no flash, only visibility_blocked emit', async () => {
    const { fetch, resolve } = deferredFetch(
      makeBootstrap({
        visibility: { visible: false, reason: 'country_not_match', country: 'RU', tier: 3 }
      })
    );
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch,
      autoDetectReturn: false,
      mountThenLoad: false
    });
    const events: string[] = [];
    ui.on('open', () => events.push('open'));
    ui.on('close', () => events.push('close'));
    ui.on('visibility_blocked', () => events.push('blocked'));

    ui.open();
    expect(events).toEqual([]);

    resolve();
    await new Promise((r) => setTimeout(r, 0));
    // Legacy: the gate ran BEFORE mount, no 'open'/'close' flicker.
    expect(events).toEqual(['blocked']);
  });

  it('cached bootstrap: skips mount-then-load path entirely (sync gates)', async () => {
    // The first open() warms the cache, the second goes through the cached path.
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: (async () =>
        new Response(JSON.stringify(makeBootstrap()), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })) as typeof fetch,
      autoDetectReturn: false
    });
    await ui.billing.bootstrap();
    expect(ui.billing.getCachedBootstrap()).not.toBeNull();

    const events: string[] = [];
    ui.on('open', () => events.push('open'));
    ui.open();
    // Cached path — sync, no delays.
    expect(events).toEqual(['open']);
  });
});

// Subscription gate: a blind open() for a user with an active subscription is
// suppressed — no modal, purchase_completed{restored:true} once per instance.
// Regression guard for the "plan picker for a subscriber" bug (extension popup:
// a click on a gated feature used to open the picker). The restored
// success-view stays reserved for signin auth-resume / Restore purchases / the
// 409 already_purchased catch in checkout.
describe('PaywallUI open for an already-subscribed user', () => {
  const ACTIVE_USER = {
    has_active_subscription: true,
    purchases: [] as unknown[],
    trial: null as unknown
  };

  function makeBootstrap(user: unknown = ACTIVE_USER) {
    return {
      settings: { name: 'Test', is_test_mode: false },
      prices: [] as unknown[],
      offers: [] as unknown[],
      layout: { type: 'modal', blocks: [] as unknown[] },
      user
    };
  }

  const fetchReturning = (body: unknown): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch;

  function makeUI(user: unknown = ACTIVE_USER) {
    return new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: fetchReturning(makeBootstrap(user)),
      autoDetectReturn: false,
      analytics: false
    });
  }

  async function waitForView(ui: PaywallUI, view: string): Promise<void> {
    await vi.waitFor(
      () => {
        if (ui.getState().view !== view) {
          throw new Error(`view is ${ui.getState().view}, want ${view}`);
        }
      },
      { timeout: 3000 }
    );
  }

  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    window.localStorage.clear();
  });

  it('warm cache: open() is suppressed — no mount, restored signal emitted', async () => {
    const ui = makeUI();
    await ui.billing.bootstrap();

    const events: unknown[] = [];
    ui.on('open', () => events.push('open'));
    ui.on('purchase_completed', (p) => events.push(p));

    ui.open();

    expect(events).toEqual([{ priceId: null, sessionId: null, restored: true }]);
    expect(ui.getState().open).toBe(false);
  });

  it('repeat open() stays suppressed and does not re-emit', async () => {
    const ui = makeUI();
    await ui.billing.bootstrap();
    const completed: unknown[] = [];
    ui.on('purchase_completed', (p) => completed.push(p));

    ui.open();
    ui.open();

    expect(completed).toHaveLength(1);
    expect(ui.getState().open).toBe(false);
  });

  it('cold bootstrap (mount-then-load): the modal closes once the user arrives', async () => {
    const ui = makeUI();
    const events: unknown[] = [];
    ui.on('open', () => events.push('open'));
    ui.on('close', () => events.push('close'));
    ui.on('purchase_completed', (p) => events.push(p));

    ui.open();
    // Cold cache — mount-then-load mounts the spinner synchronously.
    expect(events).toEqual(['open']);

    await vi.waitFor(
      () => {
        if (events.length < 3) throw new Error('gate has not run yet');
      },
      { timeout: 3000 }
    );
    expect(events).toEqual([
      'open',
      'close',
      { priceId: null, sessionId: null, restored: true }
    ]);
    expect(ui.getState().open).toBe(false);
  });

  it('cold bootstrap + mountThenLoad:false — suppressed without an open/close flash', async () => {
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: fetchReturning(makeBootstrap()),
      autoDetectReturn: false,
      analytics: false,
      mountThenLoad: false
    });
    const events: unknown[] = [];
    ui.on('open', () => events.push('open'));
    ui.on('close', () => events.push('close'));
    ui.on('purchase_completed', (p) => events.push(p));

    ui.open();
    expect(events).toEqual([]);

    await vi.waitFor(
      () => {
        if (events.length === 0) throw new Error('no emit yet');
      },
      { timeout: 3000 }
    );
    expect(events).toEqual([{ priceId: null, sessionId: null, restored: true }]);
    expect(ui.getState().open).toBe(false);
  });

  it('renew: true keeps the plan picker on first open and on reopen', async () => {
    const ui = makeUI();
    ui.open({ renew: true });
    await waitForView(ui, 'layout');

    ui.close();
    ui.open({ renew: true });
    await waitForView(ui, 'layout');
    // Settle: make sure nothing asynchronously flips the view away afterwards.
    await new Promise((r) => setTimeout(r, 50));
    expect(ui.getState().view).toBe('layout');
  });

  it('non-subscribed user still gets the plan picker on reopen', async () => {
    const ui = makeUI(null);
    ui.open();
    await waitForView(ui, 'layout');

    ui.close();
    ui.open();
    await waitForView(ui, 'layout');
    // Settle: make sure nothing asynchronously flips the view away afterwards.
    await new Promise((r) => setTimeout(r, 50));
    expect(ui.getState().view).toBe('layout');
  });

  it('expired trial + no subscription: the modal opens with the plan picker', async () => {
    // Gate ordering: the subscription gate must not swallow the expired-trial
    // path — a trial user who ran out of quota still gets the paywall.
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: fetchReturning({
        ...makeBootstrap(null),
        settings: {
          name: 'Test',
          is_test_mode: false,
          trial: { mode: 'opens', payload: 1, storage: 'client' }
        }
      }),
      autoDetectReturn: false,
      analytics: false
    });
    const events: string[] = [];
    ui.on('trial_blocked', () => events.push('trial_blocked'));
    ui.on('trial_expired', () => events.push('trial_expired'));

    // First open consumes the single trial action — blocked, no modal.
    ui.open();
    await vi.waitFor(
      () => {
        if (!events.includes('trial_blocked')) throw new Error('trial gate has not run yet');
      },
      { timeout: 3000 }
    );
    expect(ui.getState().open).toBe(false);

    // Second open — the trial is exhausted → the paywall opens with plans.
    ui.open();
    await waitForView(ui, 'layout');
    expect(events).toEqual(['trial_blocked', 'trial_expired']);
  });

  it('expired trial + active subscription: still suppressed (subscription wins)', async () => {
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: fetchReturning({
        ...makeBootstrap(),
        settings: {
          name: 'Test',
          is_test_mode: false,
          trial: { mode: 'opens', payload: 1, storage: 'client' }
        }
      }),
      autoDetectReturn: false,
      analytics: false
    });
    await ui.billing.bootstrap();
    const completed: unknown[] = [];
    ui.on('purchase_completed', (p) => completed.push(p));

    ui.open();

    expect(completed).toHaveLength(1);
    expect(ui.getState().open).toBe(false);
  });

  it('cachedUser overlay: bootstrap without user + active user-state → suppressed', async () => {
    // The support-ticket scenario: getAccess() sees the subscription through
    // cachedUser while bootstrap.user is missing — open() must be suppressed,
    // not fall back to the plan picker.
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const body = url.includes('/user-state') ? ACTIVE_USER : makeBootstrap(null);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof fetch;
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      identity: { email: 'kv@example.com' },
      fetch: fetchImpl,
      autoDetectReturn: false,
      analytics: false
    });

    await ui.billing.getUser();
    expect(ui.billing.getCachedUser()?.has_active_subscription).toBe(true);

    const events: unknown[] = [];
    ui.on('open', () => events.push('open'));
    ui.on('purchase_completed', (p) => events.push(p));

    ui.open();

    expect(events).toEqual([{ priceId: null, sessionId: null, restored: true }]);
    expect(ui.getState().open).toBe(false);
  });
});

// Cold-start race (3.3.0 leak, support ticket #2): in the extension-popup
// lifecycle the subscription gate used to read the sync getCachedUser() while
// auth hydrate → INITIAL_SESSION → setIdentity → user-state were still in
// flight. With a hydrated persisted bootstrap (which carries no user) nothing
// ever re-checked, and a subscriber intermittently got the plan picker. The
// gate now resolves the settled user before continuing, getUser waits for the
// auth hydrate before stamping EMPTY_USER, and a post-mount corrective closes
// the layout if the truth arrives late.
describe('PaywallUI subscription gate on cold start (settled user)', () => {
  const ACTIVE_USER = {
    has_active_subscription: true,
    purchases: [] as unknown[],
    trial: null as unknown
  };
  const INACTIVE_USER = {
    has_active_subscription: false,
    purchases: [] as unknown[],
    trial: null as unknown
  };

  function makeBootstrap(user: unknown = null) {
    return {
      settings: { name: 'Test', is_test_mode: false },
      prices: [] as unknown[],
      offers: [] as unknown[],
      layout: { type: 'modal', blocks: [] as unknown[] },
      user
    };
  }

  type FakeSession = {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    user: { id: string; email: string; is_anonymous: boolean };
  };

  // Duck-typed AuthClient (isAuthClientLike) with a controllable hydrate: the
  // session "arrives from storage" only after hydrateNow(), mirroring the real
  // AuthClient contract — getAccessToken awaits the hydrate, INITIAL_SESSION
  // fires via hydrated.then in subscription order.
  function makeFakeAuth(email: string | null) {
    let resolveHydrated!: () => void;
    const hydrated = new Promise<void>((r) => {
      resolveHydrated = r;
    });
    const session: FakeSession | null = email
      ? {
          access_token: 'tok_1',
          refresh_token: 'ref_1',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: 'u1', email, is_anonymous: false }
        }
      : null;
    // Mirrors the real AuthClient contract: the sync getters return null until
    // the storage hydrate resolves — that's exactly what makes the popup cold
    // start a race.
    let isHydrated = false;
    return {
      hydrateNow: () => {
        isHydrated = true;
        resolveHydrated();
      },
      ready: () => hydrated,
      getCachedSession: () => (isHydrated ? session : null),
      getCachedUser: () => (isHydrated ? session?.user ?? null : null),
      getAccessToken: async () => {
        await hydrated;
        return session?.access_token ?? null;
      },
      refresh: async () => session,
      onAuthChange: (cb: (event: string, s: FakeSession | null) => void) => {
        void hydrated.then(() => cb('INITIAL_SESSION', session));
        return () => {};
      },
      signOut: async () => {}
    };
  }

  // Routes /user-state separately from /bootstrap; the user body is mutable so
  // tests can flip the server truth mid-flight.
  function makeFetch(state: { user: unknown; bootstrapUser?: unknown }): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const body = url.includes('/user-state')
        ? state.user
        : makeBootstrap(state.bootstrapUser ?? null);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof fetch;
  }

  function seedPersistedBootstrap(paywallId: string): void {
    const { user: _user, ...rest } = makeBootstrap(null);
    window.localStorage.setItem(
      `pw-${paywallId}-bootstrap-v1`,
      JSON.stringify({ at: Date.now(), bootstrap: rest })
    );
  }

  function makeUI(opts: {
    auth: ReturnType<typeof makeFakeAuth>;
    fetch: typeof fetch;
    mountThenLoad?: boolean;
  }) {
    return new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: opts.fetch,
      auth: opts.auth as never,
      autoDetectReturn: false,
      analytics: false,
      ...(opts.mountThenLoad === undefined ? {} : { mountThenLoad: opts.mountThenLoad })
    });
  }

  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    window.localStorage.clear();
  });

  it('popup race repro: hydrated bootstrap + late session → open() suppressed, no picker', async () => {
    seedPersistedBootstrap('pw_1');
    const auth = makeFakeAuth('sub@example.com');
    const ui = makeUI({ auth, fetch: makeFetch({ user: ACTIVE_USER }), mountThenLoad: false });
    // Wait for the persisted bootstrap to hydrate — the exact leak path: the
    // sync cached-bootstrap gate used to run with cachedUser=null.
    await vi.waitFor(() => {
      if (!ui.billing.getCachedBootstrap()) throw new Error('bootstrap not hydrated');
    });

    const events: unknown[] = [];
    ui.on('open', () => events.push('open'));
    ui.on('purchase_completed', (p) => events.push(p));

    ui.open(); // the session is still "loading" at this point
    expect(ui.getState().open).toBe(false);
    expect(events).toEqual([]);

    auth.hydrateNow(); // the session arrives after open()

    await vi.waitFor(() => {
      if (events.length === 0) throw new Error('gate has not settled yet');
    });
    expect(events).toEqual([{ priceId: null, sessionId: null, restored: true }]);
    expect(ui.getState().open).toBe(false);
  });

  it('same race with mountThenLoad default: still suppressed without a picker flash', async () => {
    seedPersistedBootstrap('pw_1');
    const auth = makeFakeAuth('sub@example.com');
    const ui = makeUI({ auth, fetch: makeFetch({ user: ACTIVE_USER }) });
    await vi.waitFor(() => {
      if (!ui.billing.getCachedBootstrap()) throw new Error('bootstrap not hydrated');
    });

    const events: unknown[] = [];
    ui.on('open', () => events.push('open'));
    ui.on('purchase_completed', (p) => events.push(p));

    ui.open();
    auth.hydrateNow();

    await vi.waitFor(() => {
      if (events.length === 0) throw new Error('gate has not settled yet');
    });
    expect(events).toEqual([{ priceId: null, sessionId: null, restored: true }]);
    expect(ui.getState().open).toBe(false);
  });

  it('non-subscriber with auth: settle resolves and the picker still opens', async () => {
    seedPersistedBootstrap('pw_1');
    const auth = makeFakeAuth('free@example.com');
    const ui = makeUI({ auth, fetch: makeFetch({ user: INACTIVE_USER }) });
    await vi.waitFor(() => {
      if (!ui.billing.getCachedBootstrap()) throw new Error('bootstrap not hydrated');
    });

    ui.open();
    auth.hydrateNow();

    await vi.waitFor(() => {
      if (ui.getState().view !== 'layout') {
        throw new Error(`view is ${ui.getState().view}, want layout`);
      }
    });
  });

  it('post-mount corrective: subscription truth arriving after mount closes the layout', async () => {
    seedPersistedBootstrap('pw_1');
    const auth = makeFakeAuth('sub@example.com');
    const state = { user: INACTIVE_USER as unknown };
    const ui = makeUI({ auth, fetch: makeFetch(state) });
    await vi.waitFor(() => {
      if (!ui.billing.getCachedBootstrap()) throw new Error('bootstrap not hydrated');
    });

    const completed: unknown[] = [];
    ui.on('purchase_completed', (p) => completed.push(p));

    ui.open();
    auth.hydrateNow();
    await vi.waitFor(() => {
      if (ui.getState().view !== 'layout') {
        throw new Error(`view is ${ui.getState().view}, want layout`);
      }
    });

    // The server truth flips (e.g. a cross-context broadcast / revalidate).
    state.user = ACTIVE_USER;
    await ui.billing.getUser({ force: true });

    await vi.waitFor(() => {
      if (ui.getState().open) throw new Error('corrective has not closed the modal');
    });
    expect(completed).toEqual([{ priceId: null, sessionId: null, restored: true }]);
  });

  it('getUser before hydrate waits for the session instead of stamping EMPTY_USER', async () => {
    const auth = makeFakeAuth('sub@example.com');
    const ui = makeUI({ auth, fetch: makeFetch({ user: ACTIVE_USER }) });

    const promise = ui.billing.getUser();
    auth.hydrateNow();
    const user = await promise;

    expect(user.has_active_subscription).toBe(true);
    // No EMPTY_USER persisted under the guest key — the poison that used to
    // feed the next popup's gate.
    expect(window.localStorage.getItem('pw-pw_1-guest-user-v1')).toBeNull();
  });

  it('post-purchase reopen: stale persisted false + checkout marker → no flash at all', async () => {
    // The one-time flash report: the purchase completed in the checkout tab
    // while the popup was dead, so the persisted user still says false. The
    // checkout-pending marker (written on checkout_started) makes the settle
    // distrust the negative and wait for /user-state — nothing mounts.
    seedPersistedBootstrap('pw_1');
    window.localStorage.setItem(
      'pw-pw_1-sub@example.com-user-v1',
      JSON.stringify({ at: Date.now(), user: INACTIVE_USER })
    );
    window.localStorage.setItem(
      'pw-pw_1-checkout-pending-v1',
      JSON.stringify({ at: Date.now() })
    );
    const auth = makeFakeAuth('sub@example.com');
    const ui = makeUI({ auth, fetch: makeFetch({ user: ACTIVE_USER }) });
    await vi.waitFor(() => {
      if (!ui.billing.getCachedBootstrap()) throw new Error('bootstrap not hydrated');
    });

    const events: unknown[] = [];
    ui.on('open', () => events.push('open'));
    ui.on('close', () => events.push('close'));
    ui.on('purchase_completed', (p) => events.push(p));

    ui.open();
    auth.hydrateNow();

    await vi.waitFor(() => {
      if (events.length === 0) throw new Error('gate has not settled yet');
    });
    // No open/close pair — the flash is gone. (Marker consumption is asserted
    // in the abandoned-checkout test: here the network race may resolve the
    // active user before the negative hydrate, leaving the marker untouched.)
    expect(events).toEqual([{ priceId: null, sessionId: null, restored: true }]);
    expect(ui.getState().open).toBe(false);
  });

  it('hybrid identity (no auth): stale persisted false + marker → suppressed without a flash', async () => {
    // Identity is known at construction here, so the persisted negative user
    // hydrates before open() — the gate must still distrust it via the marker
    // instead of mounting synchronously.
    seedPersistedBootstrap('pw_1');
    window.localStorage.setItem(
      'pw-pw_1-sub@example.com-user-v1',
      JSON.stringify({ at: Date.now(), user: INACTIVE_USER })
    );
    window.localStorage.setItem(
      'pw-pw_1-checkout-pending-v1',
      JSON.stringify({ at: Date.now() })
    );
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      identity: { email: 'sub@example.com' },
      fetch: makeFetch({ user: ACTIVE_USER }),
      autoDetectReturn: false,
      analytics: false
    });
    await vi.waitFor(() => {
      if (!ui.billing.getCachedBootstrap()) throw new Error('bootstrap not hydrated');
    });

    const events: unknown[] = [];
    ui.on('open', () => events.push('open'));
    ui.on('purchase_completed', (p) => events.push(p));

    ui.open();

    await vi.waitFor(() => {
      if (events.length === 0) throw new Error('gate has not settled yet');
    });
    expect(events).toEqual([{ priceId: null, sessionId: null, restored: true }]);
    expect(ui.getState().open).toBe(false);
    expect(window.localStorage.getItem('pw-pw_1-checkout-pending-v1')).toBeNull();
  });

  it('abandoned checkout: marker + network false → picker opens, marker consumed', async () => {
    seedPersistedBootstrap('pw_1');
    window.localStorage.setItem(
      'pw-pw_1-free@example.com-user-v1',
      JSON.stringify({ at: Date.now(), user: INACTIVE_USER })
    );
    window.localStorage.setItem(
      'pw-pw_1-checkout-pending-v1',
      JSON.stringify({ at: Date.now() })
    );
    const auth = makeFakeAuth('free@example.com');
    const ui = makeUI({ auth, fetch: makeFetch({ user: INACTIVE_USER }) });
    await vi.waitFor(() => {
      if (!ui.billing.getCachedBootstrap()) throw new Error('bootstrap not hydrated');
    });

    ui.open();
    auth.hydrateNow();

    await vi.waitFor(() => {
      if (ui.getState().view !== 'layout') {
        throw new Error(`view is ${ui.getState().view}, want layout`);
      }
    });
    expect(window.localStorage.getItem('pw-pw_1-checkout-pending-v1')).toBeNull();
  });

  it('stale persisted false without a marker keeps the no-network fast path', async () => {
    seedPersistedBootstrap('pw_1');
    window.localStorage.setItem(
      'pw-pw_1-free@example.com-user-v1',
      JSON.stringify({ at: Date.now(), user: INACTIVE_USER })
    );
    const auth = makeFakeAuth('free@example.com');
    const ui = makeUI({ auth, fetch: makeFetch({ user: INACTIVE_USER }) });
    await vi.waitFor(() => {
      if (!ui.billing.getCachedBootstrap()) throw new Error('bootstrap not hydrated');
    });

    ui.open();
    auth.hydrateNow();
    await vi.waitFor(() => {
      if (ui.getState().view !== 'layout') {
        throw new Error(`view is ${ui.getState().view}, want layout`);
      }
    });
  });

  it('checkout_started persists the checkout-pending marker', async () => {
    const auth = makeFakeAuth('sub@example.com');
    const ui = makeUI({ auth, fetch: makeFetch({ user: INACTIVE_USER }) });

    (ui as unknown as { emit: Function }).emit('checkout_started', {
      priceId: 'p1',
      url: 'https://pay.example.com/x'
    });

    await vi.waitFor(() => {
      if (!window.localStorage.getItem('pw-pw_1-checkout-pending-v1')) {
        throw new Error('marker not written yet');
      }
    });
    const parsed = JSON.parse(
      window.localStorage.getItem('pw-pw_1-checkout-pending-v1')!
    ) as { at: number };
    expect(typeof parsed.at).toBe('number');
  });

  it('getAccess on the same race resolves granted/has_subscription', async () => {
    seedPersistedBootstrap('pw_1');
    const auth = makeFakeAuth('sub@example.com');
    const ui = makeUI({ auth, fetch: makeFetch({ user: ACTIVE_USER }) });
    await vi.waitFor(() => {
      if (!ui.billing.getCachedBootstrap()) throw new Error('bootstrap not hydrated');
    });

    const promise = ui.getAccess();
    auth.hydrateNow();
    const result = await promise;

    expect(result.access).toBe('granted');
    expect(result.reason).toBe('has_subscription');
    expect(result.user?.has_active_subscription).toBe(true);
  });
});
