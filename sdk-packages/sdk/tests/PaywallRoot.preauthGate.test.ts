// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { PaywallRoot } from '../src/ui/PaywallRoot';
import type { BillingClient } from '../src/core/BillingClient';
import type { AuthClient, AuthSession } from '../src/core/auth';
import type { LayoutBlock, PaywallBootstrap, PaywallSettings, CheckoutResult } from '../src/core/types';

// Render-тесты на preauth-gate flow в PaywallRoot:
// 1. checkout_mode=guest — checkout идёт без gate.
// 2. checkout_mode=preauth + есть сессия — gate пропускается.
// 3. checkout_mode=preauth + нет сессии — gate показывается, createCheckout НЕ вызывается.
// 4. После signIn (onAuthChange выдаёт session) — auto-resume исходного checkout.
// 5. Back из gate — возвращает layout, createCheckout не вызывается.
// 6. Defensive: preauth без AuthClient → fallback на guest-flow (createCheckout вызывается).

function makeSession(): AuthSession {
  return {
    access_token: 'a1',
    refresh_token: 'r1',
    expires_at: Date.now() + 3600_000,
    user: { id: 'u_1', email: 'a@b.c' }
  };
}

interface AuthHarness {
  auth: AuthClient;
  emit: (s: AuthSession | null) => void;
  setCached: (s: AuthSession | null) => void;
  signOut: ReturnType<typeof vi.fn>;
}

function makeAuthHarness(initialSession: AuthSession | null = null): AuthHarness {
  let cached = initialSession;
  type Listener = (event: string, s: AuthSession | null) => void;
  const listeners = new Set<Listener>();
  const signOut = vi.fn(async (): Promise<void> => {
    cached = null;
    listeners.forEach((cb) => cb('SIGNED_OUT', null));
  });
  const auth = {
    paywallId: 'pw_1',
    onAuthChange: (cb: Listener): (() => void) => {
      listeners.add(cb);
      return (): void => {
        listeners.delete(cb);
      };
    },
    getCachedSession: (): AuthSession | null => cached,
    getCachedUser: (): null => null,
    ready: async (): Promise<void> => undefined,
    getAccessToken: async (): Promise<string | null> => null,
    signOut
  } as unknown as AuthClient;
  return {
    auth,
    signOut,
    // emit: signin-like событие. Если переход null→session или другой user.id —
    // SIGNED_IN; если тот же user — TOKEN_REFRESHED. Это match'ит реальный
    // applyExternalSession-классификатор в @sdk/core/auth.
    emit: (s) => {
      const event =
        !cached || !s || cached.user.id !== s.user.id ? 'SIGNED_IN' : 'TOKEN_REFRESHED';
      cached = s;
      listeners.forEach((cb) => cb(event, s));
    },
    setCached: (s) => {
      cached = s;
    }
  };
}

interface ClientHarness {
  client: BillingClient;
  createCheckout: ReturnType<typeof vi.fn>;
}

function makeClientHarness(
  settings: Partial<PaywallSettings>,
  authClient: AuthClient | undefined,
  opts: { withCurrentSession?: boolean } = {}
): ClientHarness {
  const blocks: LayoutBlock[] = [
    { type: 'price_grid' },
    { type: 'cta_button', label: 'Continue', action: 'checkout' }
  ];
  if (opts.withCurrentSession) {
    blocks.push({ type: 'current_session' });
  }
  const bootstrap: PaywallBootstrap = {
    settings: { id: 'pw_1', name: 'Test', ...settings },
    prices: [
      {
        id: 'price_1',
        currency: 'USD',
        amount: 9.99,
        interval: 'month',
        interval_count: 1,
        trial_days: null,
        label: 'Monthly'
      }
    ],
    offers: [],
    layout: {
      type: 'modal',
      blocks
    }
  };

  const createCheckout = vi.fn(
    async (): Promise<CheckoutResult> => ({ url: 'https://example.com/checkout', sessionId: 's_1' })
  );

  const client = {
    auth: authClient,
    bootstrap: vi.fn(async () => bootstrap),
    createCheckout
  } as unknown as BillingClient;

  return { client, createCheckout };
}

function mount(client: BillingClient): {
  container: HTMLElement;
  events: Array<{ type: string; payload?: unknown }>;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const events: Array<{ type: string; payload?: unknown }> = [];
  act(() => {
    render(
      h(PaywallRoot, {
        client,
        open: true,
        onClose: (): void => undefined,
        onEvent: (type: string, payload?: unknown): void => {
          events.push({ type, payload });
        }
      }),
      container
    );
  });
  return {
    container,
    events,
    unmount: () => {
      render(null, container);
      container.remove();
    }
  };
}

async function flush(): Promise<void> {
  // Дать `bootstrap()` Promise зарезолвиться + setState прогнать render.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function clickContinue(container: HTMLElement): void {
  const btn = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === 'Continue'
  );
  if (!btn) throw new Error('Continue button not found');
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('PaywallRoot preauth gate', () => {
  beforeEach(() => {
    // По дефолту имитируем "попап открылся": runCheckout считает не-null
    // возврат за успех и не дёргает location.assign-fallback.
    vi.stubGlobal('open', vi.fn().mockReturnValue({} as Window));
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('guest mode: click Continue triggers createCheckout immediately', async () => {
    const { client, createCheckout } = makeClientHarness({ checkout_mode: 'guest' }, undefined);
    const { container, unmount } = mount(client);
    await flush();
    clickContinue(container);
    await flush();
    expect(createCheckout).toHaveBeenCalledWith({ priceId: 'price_1', ignoreActivePurchase: false });
    unmount();
  });

  it('preauth + existing session: gate is skipped, createCheckout fires', async () => {
    const harness = makeAuthHarness(makeSession());
    const { client, createCheckout } = makeClientHarness({ checkout_mode: 'preauth' }, harness.auth);
    const { container, unmount } = mount(client);
    await flush();
    clickContinue(container);
    await flush();
    expect(createCheckout).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('preauth + no session: gate appears, createCheckout deferred', async () => {
    const harness = makeAuthHarness(null);
    const { client, createCheckout } = makeClientHarness({ checkout_mode: 'preauth' }, harness.auth);
    const { container, unmount } = mount(client);
    await flush();
    clickContinue(container);
    await flush();
    // createCheckout не должен дёрнуться — gate перехватил.
    expect(createCheckout).not.toHaveBeenCalled();
    // На экране — Sign in to continue + Back.
    expect(container.textContent).toContain('Sign in to continue');
    expect(container.textContent).toContain('Back');
    unmount();
  });

  it('preauth: signIn auto-resumes pending checkout with same priceId', async () => {
    const harness = makeAuthHarness(null);
    const { client, createCheckout } = makeClientHarness({ checkout_mode: 'preauth' }, harness.auth);
    const { container, unmount } = mount(client);
    await flush();
    clickContinue(container);
    await flush();
    expect(createCheckout).not.toHaveBeenCalled();

    // Имитируем успешный signIn — onAuthChange должен запустить runCheckout.
    act(() => {
      harness.emit(makeSession());
    });
    await flush();

    expect(createCheckout).toHaveBeenCalledWith({ priceId: 'price_1', ignoreActivePurchase: false });
    expect(createCheckout).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('preauth: popup blocked after auto-resume → shows popup_blocked view, never navigates current tab', async () => {
    // window.open(_blank) после длинной async-цепочки signin→createCheckout
    // может блокироваться (transient activation истёк). НЕ уносим юзера через
    // location.assign — пейвол должен остаться. Показываем inline retry с
    // фреш-гестуром по кнопке.
    vi.stubGlobal('open', vi.fn().mockReturnValue(null));
    const assignSpy = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign: assignSpy }
    });

    try {
      const harness = makeAuthHarness(null);
      const { client, createCheckout } = makeClientHarness({ checkout_mode: 'preauth' }, harness.auth);
      const { container, unmount } = mount(client);
      await flush();
      clickContinue(container);
      await flush();

      act(() => {
        harness.emit(makeSession());
      });
      await flush();

      expect(createCheckout).toHaveBeenCalledTimes(1);
      expect(assignSpy).not.toHaveBeenCalled();
      expect(container.textContent).toContain('Allow popups to continue');
      const reopenBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === 'Open checkout'
      );
      expect(reopenBtn).toBeTruthy();
      unmount();
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation
      });
    }
  });

  it('preauth: successful popup transitions to awaiting_payment view with retry button', async () => {
    // Счастливый путь: window.open вернул handle. Пейвол показывает
    // ожидание + кнопку Try again на случай если юзер закрыл вкладку.
    const harness = makeAuthHarness(null);
    const { client, createCheckout } = makeClientHarness({ checkout_mode: 'preauth' }, harness.auth);
    const { container, unmount } = mount(client);
    await flush();
    clickContinue(container);
    await flush();

    act(() => {
      harness.emit(makeSession());
    });
    await flush();

    expect(createCheckout).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Complete payment in the new tab');
    const retryBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Tab closed? Try again'
    );
    expect(retryBtn).toBeTruthy();

    // Try again — пересоздаёт checkout (URL мог expire'нуться).
    act(() => {
      retryBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(createCheckout).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('preauth: re-emit of same session does not double-fire checkout', async () => {
    const harness = makeAuthHarness(null);
    const { client, createCheckout } = makeClientHarness({ checkout_mode: 'preauth' }, harness.auth);
    const { container, unmount } = mount(client);
    await flush();
    clickContinue(container);
    await flush();

    act(() => {
      harness.emit(makeSession());
    });
    await flush();
    // Refresh цикл — onAuthChange может прислать ещё одну сессию.
    act(() => {
      harness.emit(makeSession());
    });
    await flush();

    expect(createCheckout).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('preauth: Back from gate returns to layout without triggering checkout', async () => {
    const harness = makeAuthHarness(null);
    const { client, createCheckout } = makeClientHarness({ checkout_mode: 'preauth' }, harness.auth);
    const { container, unmount } = mount(client);
    await flush();
    clickContinue(container);
    await flush();

    const back = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent && b.textContent.includes('Back')
    );
    expect(back).toBeTruthy();
    act(() => {
      back!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    // Снова видим Continue → значит вернулись в layout.
    const continueBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Continue'
    );
    expect(continueBtn).toBeTruthy();
    expect(createCheckout).not.toHaveBeenCalled();
    unmount();
  });

  it('preauth: gate renders OAuth buttons from settings.auth_providers', async () => {
    const harness = makeAuthHarness(null);
    const { client } = makeClientHarness(
      { checkout_mode: 'preauth', auth_providers: ['google', 'apple'] },
      harness.auth
    );
    const { container, unmount } = mount(client);
    await flush();
    clickContinue(container);
    await flush();
    expect(container.textContent).toContain('Continue with Google');
    expect(container.textContent).toContain('Continue with Apple');
    unmount();
  });

  it('preauth: gate without auth_providers shows email-only form', async () => {
    const harness = makeAuthHarness(null);
    const { client } = makeClientHarness({ checkout_mode: 'preauth' }, harness.auth);
    const { container, unmount } = mount(client);
    await flush();
    clickContinue(container);
    await flush();
    expect(container.textContent).not.toContain('Continue with Google');
    expect(container.textContent).not.toContain('Continue with Apple');
    expect(container.textContent).toContain('Sign in to continue');
    unmount();
  });

  it('current_session: signed-in renders email + Sign out, calls auth.signOut() on click', async () => {
    const harness = makeAuthHarness(makeSession());
    const { client, createCheckout } = makeClientHarness(
      { checkout_mode: 'guest' },
      harness.auth,
      { withCurrentSession: true }
    );
    const { container, unmount } = mount(client);
    await flush();

    expect(container.textContent).toContain('Signed in as');
    expect(container.textContent).toContain('a@b.c');

    const signOutBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Sign Out'
    );
    expect(signOutBtn).toBeTruthy();
    act(() => {
      signOutBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(harness.signOut).toHaveBeenCalledTimes(1);
    // После signOut harness эмитит null — block перерендеривается в "Restore".
    expect(container.textContent).toContain('Restore purchases');
    expect(createCheckout).not.toHaveBeenCalled();
    unmount();
  });

  it('current_session: guest sees "Restore purchases", click opens gate without pendingCheckout', async () => {
    const harness = makeAuthHarness(null);
    const { client, createCheckout } = makeClientHarness(
      { checkout_mode: 'guest', auth_providers: ['google'] },
      harness.auth,
      { withCurrentSession: true }
    );
    const { container, unmount } = mount(client);
    await flush();

    const restoreBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Restore purchases'
    );
    expect(restoreBtn).toBeTruthy();
    act(() => {
      restoreBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    // Gate открыт — видим заголовок auth-формы.
    expect(container.textContent).toContain('Sign in to continue');

    // Имитируем signIn — gate схлопывается, createCheckout НЕ вызывается
    // (рестор не несёт pendingCheckout).
    act(() => {
      harness.emit(makeSession());
    });
    await flush();

    expect(createCheckout).not.toHaveBeenCalled();
    // После схлопывания gate'а юзер снова в layout — видит signed-in summary.
    expect(container.textContent).toContain('Signed in as');
    unmount();
  });

  it('preauth without AuthClient: falls back to direct checkout (no gate)', async () => {
    const { client, createCheckout } = makeClientHarness({ checkout_mode: 'preauth' }, undefined);
    const { container, unmount } = mount(client);
    await flush();
    clickContinue(container);
    await flush();
    // Безопасный fallback — без AuthClient гейт смысла не имеет.
    expect(createCheckout).toHaveBeenCalledTimes(1);
    unmount();
  });
});
