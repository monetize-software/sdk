// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { PaywallRoot } from '../src/ui/PaywallRoot';
import type { BillingClient } from '../src/core/BillingClient';
import type { AuthClient, AuthSession } from '../src/core/auth';
import type { LayoutBlock, PaywallBootstrap, PaywallSettings, CheckoutResult } from '../src/core/types';

// Render tests for the preauth-gate flow in PaywallRoot:
// 1. checkout_mode=guest — checkout proceeds without a gate.
// 2. checkout_mode=preauth + existing session — the gate is skipped.
// 3. checkout_mode=preauth + no session — the gate is shown, createCheckout is NOT called.
// 4. After signIn (onAuthChange yields a session) — auto-resume of the original checkout.
// 5. Back from the gate — returns to the layout, createCheckout isn't called.
// 6. Defensive: preauth without AuthClient → falls back to the guest flow (createCheckout is called).

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
    getLastLogin: async (): Promise<null> => null,
    signOut
  } as unknown as AuthClient;
  return {
    auth,
    signOut,
    // emit: a signin-like event. On a null→session transition or a different user.id —
    // SIGNED_IN; for the same user — TOKEN_REFRESHED. This matches the real
    // applyExternalSession classifier in @sdk/core/auth.
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
  // Let the `bootstrap()` promise resolve + setState drive a render.
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
    // By default we simulate "popup opened": runCheckout treats a non-null
    // return as success and doesn't hit the location.assign fallback.
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
    // createCheckout must not fire — the gate intercepted it.
    expect(createCheckout).not.toHaveBeenCalled();
    // On screen — the preauth-intent heading "Log in to continue your purchase" + a Back button.
    expect(container.textContent).toContain('Log in to continue your purchase');
    expect(container.querySelector('button[aria-label="Back"]')).toBeTruthy();
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

    // Simulate a successful signIn — onAuthChange should start runCheckout.
    act(() => {
      harness.emit(makeSession());
    });
    await flush();

    expect(createCheckout).toHaveBeenCalledWith({ priceId: 'price_1', ignoreActivePurchase: false });
    expect(createCheckout).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('preauth: popup blocked after auto-resume → shows popup_blocked view, never navigates current tab', async () => {
    // window.open(_blank) after the long async chain signin→createCheckout
    // can be blocked (transient activation expired). We do NOT take the user away via
    // location.assign — the paywall must stay. We show an inline retry with
    // a fresh gesture on the button.
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
    // Happy path: window.open returned a handle. The paywall shows
    // a waiting state + a Try again button in case the user closed the tab.
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

    // Try again — recreates the checkout (the URL may have expired).
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
    // Refresh cycle — onAuthChange may send another session.
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

    const back = container.querySelector<HTMLButtonElement>('button[aria-label="Back"]');
    expect(back).toBeTruthy();
    act(() => {
      back!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    // We see Continue again → meaning we're back in the layout.
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
    expect(container.textContent).toContain('Log in to continue your purchase');
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
    // After signOut the harness emits null — the block re-renders into "Restore".
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

    // The gate opened with intent='restore' — we see the custom heading.
    expect(container.textContent).toContain('Restore Purchases');

    // Simulate signIn — the gate collapses, createCheckout is NOT called
    // (restore carries no pendingCheckout).
    act(() => {
      harness.emit(makeSession());
    });
    await flush();

    expect(createCheckout).not.toHaveBeenCalled();
    // After the gate collapses the user is back in the layout — sees the signed-in summary.
    expect(container.textContent).toContain('Signed in as');
    unmount();
  });

  it('preauth without AuthClient: falls back to direct checkout (no gate)', async () => {
    const { client, createCheckout } = makeClientHarness({ checkout_mode: 'preauth' }, undefined);
    const { container, unmount } = mount(client);
    await flush();
    clickContinue(container);
    await flush();
    // Safe fallback — without an AuthClient the gate makes no sense.
    expect(createCheckout).toHaveBeenCalledTimes(1);
    unmount();
  });
});
