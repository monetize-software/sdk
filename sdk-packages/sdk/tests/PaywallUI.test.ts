// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaywallUI } from '../src/ui/PaywallUI';

const TEST_API_ORIGIN = 'https://test.example.com';

// Минимальный stub fetch — PaywallUI не ходит в сеть без open(), но конструктор
// BillingClient внутри всё равно настраивает ApiClient.
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
    // Маркеры удалены, client-specific query сохранён.
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
    // Подписка синхронно после конструктора — успевает до microtask.
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

// Phase 7 — mount-then-load. Цель: при холодном bootstrap'е модалка должна
// mount'иться немедленно (snappy UX), gates применяться async когда придут
// данные. Если gate блокирует — модалка закрывается и эмитится *_blocked.
//
// Default `mountThenLoad: true` — основной путь. `false` — legacy для
// случаев где flicker «открылась → закрылась» хуже воспринимаемой латентности.
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
    // Bootstrap ещё в полёте — но open уже отстрелял (mount произошёл синхронно).
    expect(onOpen).toHaveBeenCalledTimes(1);

    resolve();
    await new Promise((r) => setTimeout(r, 0));
    // После резолва bootstrap'а — gates прошли (нет visibility/trial),
    // модалка открыта, повторного 'open' нет.
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
    // Gate отработал: модалка закрылась + visibility_blocked эмитнут.
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
    // Trial check async (storage); даём ему шанс пройти.
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
    // Bootstrap ещё не пришёл — модалка не mount'илась.
    expect(onOpen).not.toHaveBeenCalled();

    resolve();
    await new Promise((r) => setTimeout(r, 0));
    // Bootstrap прошёл, gates пропустили — теперь mountAndShow.
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
    // Legacy: gate отработал ДО mount'а, никакого 'open'/'close' flicker'а.
    expect(events).toEqual(['blocked']);
  });

  it('cached bootstrap: skips mount-then-load path entirely (sync gates)', async () => {
    // Первый open() прогревает кеш, второй идёт по cached-path.
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
    // Cached path — sync, никаких задержек.
    expect(events).toEqual(['open']);
  });
});
