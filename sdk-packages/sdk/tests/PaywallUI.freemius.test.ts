// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaywallUI } from '../src/ui/PaywallUI';
import type { PaywallBootstrap, PaywallUser } from '../src/core/types';

const TEST_API_ORIGIN = 'https://test.example.com';

// Freemius hosted checkout не поддерживает per-checkout success URL: redirect
// после оплаты прибит в Developer Dashboard клиента и игнорирует query, поэтому
// SDK НЕ может полагаться на paywall_status-маркеры в URL для freemius. Весь
// post-payment сигнал идёт только через UserWatcher polling /user-state, в
// которое webhook freemius уже записал has_active_subscription=true.
//
// Тесты ниже фиксируют контракт: createCheckout с acquiring=freemius работает
// как обычный flow (window.open + awaiting_payment), и watcher честно
// эмитит purchase_completed по факту смены user-state, без URL-маркеров.

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

// Маршрутизирует /bootstrap, /start-checkout и /user-state. user-state
// возвращает EMPTY до setActive(), затем ACTIVE — имитирует webhook freemius,
// прилетевший с задержкой.
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
    // Имитируем "попап открылся": runCheckout считает не-null возврат
    // window.open за успех и не редиректит текущую вкладку.
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
    // Сценарий целиком: запускаем watcher через `checkout_started`, polling
    // ходит в /user-state, видит EMPTY → следующий тик после setActive() видит
    // ACTIVE → SDK эмитит purchase_completed без касания URL.
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

    // Запускаем watcher напрямую, минуя PaywallRoot mount: интересует именно
    // post-checkout flow, а не UI-кликабельность (которая покрыта другими тестами).
    (ui as unknown as { startUserWatcher: () => void }).startUserWatcher();

    // Первый тик (immediate check в start()) — EMPTY, ничего не эмитим.
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).not.toHaveBeenCalled();

    // Webhook freemius "прилетел" в нашу БД — следующий тик увидит ACTIVE.
    r.setActive();
    // visibleIntervalMs default 5000 — прокручиваем тик polling'а.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledWith({ priceId: null, sessionId: null });

    // Контрольный аккорд: URL не трогали — никаких маркеров не появилось.
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('');
    // Polling действительно ходил в /user-state (минимум immediate + один тик).
    expect(r.userStateCalls()).toBeGreaterThanOrEqual(2);
  });

  it('checkReturn is a no-op for freemius landing without paywall_status', () => {
    // Freemius редиректит на /freemius/return — там НЕТ маркеров, и SDK
    // (если он почему-то загружен на этой странице) не должен ничего эмитить.
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
