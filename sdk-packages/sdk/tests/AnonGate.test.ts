// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import type { AuthClient, AuthSession } from '../src/core/auth';
import { PaywallError } from '../src/core/types';
import { AnonGate } from '../src/ui/AnonGate';

// AnonGate после удаления Turnstile-капчи — простой state machine с двумя
// фазами: signing-in / error. Логика resume / fresh-signin живёт внутри
// AuthClient.signInAnonymously; gate его только зовёт и реагирует на исход.

function makeAnonSession(): AuthSession {
  return {
    access_token: 'aa1',
    refresh_token: 'ar1',
    expires_at: Date.now() + 3600_000,
    user: { id: 'anon_uid_1', email: null, is_anonymous: true }
  };
}

function makeAuthMock(overrides: Partial<AuthClient> = {}): AuthClient {
  const stub: Partial<AuthClient> = {
    signInAnonymously: vi.fn(),
    onAuthChange: vi.fn((): (() => void) => () => undefined),
    getCachedSession: vi.fn(() => null),
    ready: vi.fn(async () => undefined),
    ...overrides
  };
  return stub as AuthClient;
}

function mount(props: Parameters<typeof AnonGate>[0]): {
  container: HTMLElement;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(AnonGate, props), container);
  });
  return {
    container,
    unmount: () => {
      render(null, container);
      container.remove();
    }
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('AnonGate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('calls signInAnonymously on mount and onSuccess on resume', async () => {
    const session = makeAnonSession();
    const signIn = vi.fn(async () => session);
    const auth = makeAuthMock({ signInAnonymously: signIn });
    const onSuccess = vi.fn();

    mount({ auth, onSuccess });
    await flushAsync();

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(session);
  });

  it('shows error state when signIn fails', async () => {
    const signIn = vi.fn(async () => {
      throw new PaywallError('upstream_error', 'GoTrue 502');
    });
    const auth = makeAuthMock({ signInAnonymously: signIn });
    const onSuccess = vi.fn();

    const view = mount({ auth, onSuccess });
    await flushAsync();

    expect(onSuccess).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('GoTrue 502');
  });

  it('Try again button re-runs signIn and resolves on second attempt', async () => {
    const session = makeAnonSession();
    let callCount = 0;
    const signIn = vi.fn(async (): Promise<AuthSession> => {
      callCount++;
      if (callCount === 1) throw new PaywallError('upstream_error', 'transient');
      return session;
    });
    const auth = makeAuthMock({ signInAnonymously: signIn });
    const onSuccess = vi.fn();

    const view = mount({ auth, onSuccess });
    await flushAsync();
    expect(view.container.textContent).toContain('transient');

    const retryBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Try again')
    );
    expect(retryBtn).toBeDefined();

    await act(async () => {
      retryBtn!.click();
      await flushAsync();
    });

    expect(signIn).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledWith(session);
  });

  it('does not call onSuccess after unmount (race-safe)', async () => {
    let resolve!: (s: AuthSession) => void;
    const pending = new Promise<AuthSession>((res) => {
      resolve = res;
    });
    const signIn = vi.fn(async () => pending);
    const auth = makeAuthMock({ signInAnonymously: signIn });
    const onSuccess = vi.fn();

    const view = mount({ auth, onSuccess });
    view.unmount();
    resolve(makeAnonSession());
    await flushAsync();
    await flushAsync();

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('renders Back button only when onBack provided', async () => {
    // signIn повисает — gate остаётся в signing-in, мы только проверяем
    // визуальное наличие/отсутствие Back-кнопки.
    const signIn = vi.fn(() => new Promise<AuthSession>(() => undefined));
    const auth = makeAuthMock({ signInAnonymously: signIn });

    const v1 = mount({ auth, onSuccess: vi.fn() });
    await flushAsync();
    expect(v1.container.textContent).not.toContain('Back');
    v1.unmount();

    const onBack = vi.fn();
    const v2 = mount({ auth, onSuccess: vi.fn(), onBack });
    await flushAsync();
    const backBtn = Array.from(v2.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Back')
    );
    expect(backBtn).toBeDefined();
    act(() => {
      backBtn!.click();
    });
    expect(onBack).toHaveBeenCalled();
  });
});
