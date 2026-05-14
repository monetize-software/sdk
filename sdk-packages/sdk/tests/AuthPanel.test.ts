// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { AuthPanel } from '../src/ui/renderer/blocks/AuthPanel';
import type { BlockContext } from '../src/ui/renderer/types';
import type { AuthClient, AuthSession } from '../src/core/auth';
import { PaywallError, type LayoutBlock } from '../src/core/types';

// Минимальный мок AuthClient: достаточно для рендера AuthPanel и вызова
// signIn/signUp/oauth/forgot. Не наследуем реальный AuthClient — берём
// duck-typed shape, чтобы не тащить настоящий конструктор + сеть в каждый тест.
function makeAuthMock(overrides: Partial<AuthClient> = {}): AuthClient {
  const stub: Partial<AuthClient> = {
    signInWithEmail: vi.fn(async () => makeSession()),
    signUp: vi.fn(async () => ({ kind: 'signed_in', session: makeSession() } as const)),
    signInWithOAuth: vi.fn(async () => makeSession()),
    sendOtp: vi.fn(async () => undefined),
    verifyOtp: vi.fn(async () => makeSession()),
    requestPasswordReset: vi.fn(async () => undefined),
    updatePassword: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    refresh: vi.fn(async () => null),
    onAuthChange: vi.fn((): (() => void) => () => undefined),
    getCachedSession: vi.fn(() => null),
    getCachedUser: vi.fn(() => null),
    ready: vi.fn(async () => undefined),
    getAccessToken: vi.fn(async () => null),
    ...overrides
  };
  return stub as AuthClient;
}

function makeSession(user = { id: 'u_1', email: 'a@b.c' }): AuthSession {
  return {
    access_token: 'a1',
    refresh_token: 'r1',
    expires_at: Date.now() + 3600_000,
    user
  };
}

function renderPanel(
  block: Extract<LayoutBlock, { type: 'auth_panel' }>,
  ctx: Partial<BlockContext> & { auth?: AuthClient; authSession?: AuthSession | null }
): { container: HTMLElement; unmount: () => void; rerender: (next: typeof ctx) => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);

  const fullCtx = (c: typeof ctx): BlockContext => ({
    bootstrap: { settings: { id: 'pw_1', name: 'X' }, prices: [], offers: [] },
    selectedPriceId: null,
    setSelectedPriceId: () => undefined,
    onAction: vi.fn(),
    auth: c.auth,
    authSession: c.authSession ?? null
  });

  act(() => {
    render(h(AuthPanel, { block, ctx: fullCtx(ctx) }), container);
  });

  return {
    container,
    unmount: () => {
      render(null, container);
      container.remove();
    },
    rerender: (next) => {
      act(() => {
        render(h(AuthPanel, { block, ctx: fullCtx(next) }), container);
      });
    }
  };
}

const BLOCK_DEFAULT: Extract<LayoutBlock, { type: 'auth_panel' }> = {
  type: 'auth_panel'
};

describe('AuthPanel render', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns null when AuthClient is missing — block is no-op', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { container } = renderPanel(BLOCK_DEFAULT, {});
    expect(container.children.length).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('renders signin form with email + password by default', () => {
    const auth = makeAuthMock();
    const { container } = renderPanel(BLOCK_DEFAULT, { auth });
    const inputs = container.querySelectorAll('input');
    expect(inputs.length).toBe(2);
    expect(inputs[0].type).toBe('email');
    expect(inputs[1].type).toBe('password');
    // Submit-кнопка с лейблом Sign in.
    const submit = container.querySelector('button[type="submit"]');
    expect(submit?.textContent).toContain('Sign in');
  });

  it('renders OAuth buttons when block.providers is set', () => {
    const auth = makeAuthMock();
    const { container } = renderPanel(
      { ...BLOCK_DEFAULT, providers: ['google', 'apple'] },
      { auth }
    );
    const oauthBtns = Array.from(container.querySelectorAll('button[type="button"]')).filter(
      (b) => /Continue with/i.test(b.textContent ?? '')
    );
    expect(oauthBtns.length).toBe(2);
    expect(oauthBtns[0].textContent).toContain('Google');
    expect(oauthBtns[1].textContent).toContain('Apple');
  });

  it('hides itself when authenticated and hide_when_authenticated default (true)', () => {
    const session = makeSession();
    const auth = makeAuthMock({ getCachedSession: vi.fn(() => session) });
    const { container } = renderPanel(BLOCK_DEFAULT, { auth, authSession: session });
    expect(container.children.length).toBe(0);
  });

  it('shows signed-in summary when hide_when_authenticated=false', () => {
    const session = makeSession({ id: 'u_1', email: 'me@b.c' });
    const auth = makeAuthMock();
    const { container } = renderPanel(
      { ...BLOCK_DEFAULT, hide_when_authenticated: false },
      { auth, authSession: session }
    );
    expect(container.textContent).toContain('me@b.c');
    expect(container.textContent).toContain('Sign out');
  });

  it('Sign out button calls auth.signOut', () => {
    const session = makeSession();
    const signOutSpy = vi.fn(async () => undefined);
    const auth = makeAuthMock({ signOut: signOutSpy });
    const { container } = renderPanel(
      { ...BLOCK_DEFAULT, hide_when_authenticated: false },
      { auth, authSession: session }
    );
    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      /Sign out/i.test(b.textContent ?? '')
    );
    btn!.click();
    expect(signOutSpy).toHaveBeenCalled();
  });

  it('toggle to signup mode shows Create account submit', () => {
    const auth = makeAuthMock();
    const { container } = renderPanel(BLOCK_DEFAULT, { auth });
    const link = Array.from(container.querySelectorAll('button')).find((b) =>
      /Create account/i.test(b.textContent ?? '')
    );
    act(() => link!.click());
    const submit = container.querySelector('button[type="submit"]');
    expect(submit?.textContent).toContain('Create account');
  });

  it('hides "Create account" link when allow_signup=false', () => {
    const auth = makeAuthMock();
    const { container } = renderPanel({ ...BLOCK_DEFAULT, allow_signup: false }, { auth });
    const link = Array.from(container.querySelectorAll('button')).find((b) =>
      /Create account/i.test(b.textContent ?? '')
    );
    expect(link).toBeUndefined();
  });

  it('hides "Forgot password?" link when allow_password_reset=false', () => {
    const auth = makeAuthMock();
    const { container } = renderPanel(
      { ...BLOCK_DEFAULT, allow_password_reset: false },
      { auth }
    );
    const link = Array.from(container.querySelectorAll('button')).find((b) =>
      /Forgot password/i.test(b.textContent ?? '')
    );
    expect(link).toBeUndefined();
  });

  it('submits email/password and calls signInWithEmail', async () => {
    const signIn = vi.fn(async () => makeSession());
    const auth = makeAuthMock({ signInWithEmail: signIn });
    const { container } = renderPanel(BLOCK_DEFAULT, { auth });

    const emailInput = container.querySelector<HTMLInputElement>('input[type="email"]')!;
    const passwordInput = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    const form = container.querySelector('form')!;

    await act(async () => {
      emailInput.value = 'me@b.c';
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
      passwordInput.value = 'secret';
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(signIn).toHaveBeenCalledWith({ email: 'me@b.c', password: 'secret' });
  });

  it('renders inline error when signInWithEmail rejects', async () => {
    const signIn = vi.fn(async () => {
      throw new PaywallError('invalid_credentials', 'Invalid email or password');
    });
    const auth = makeAuthMock({ signInWithEmail: signIn });
    const { container } = renderPanel(BLOCK_DEFAULT, { auth });

    const form = container.querySelector('form')!;
    const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
    const password = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      email.value = 'a@b.c';
      email.dispatchEvent(new Event('input', { bubbles: true }));
      password.value = 'wrong';
      password.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain('Invalid email or password');
  });

  it('OAuth button click triggers signInWithOAuth', async () => {
    const oauth = vi.fn(async () => makeSession());
    const auth = makeAuthMock({ signInWithOAuth: oauth });
    const { container } = renderPanel(
      { ...BLOCK_DEFAULT, providers: ['google'] },
      { auth }
    );
    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      /Google/i.test(b.textContent ?? '')
    );
    await act(async () => {
      btn!.click();
    });
    expect(oauth).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google', onPopupOpened: expect.any(Function) })
    );
  });

  it('signup confirmation_required switches to OTP-verify mode', async () => {
    const signUp = vi.fn(
      async () =>
        ({ kind: 'confirmation_required', user: { id: 'u_2', email: 'new@b.c' } } as const)
    );
    const auth = makeAuthMock({ signUp });
    const { container } = renderPanel(BLOCK_DEFAULT, { auth });

    // Toggle signup
    const toSignup = Array.from(container.querySelectorAll('button')).find((b) =>
      /Create account/i.test(b.textContent ?? '')
    );
    act(() => toSignup!.click());

    // Fill + submit
    const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
    const password = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      email.value = 'new@b.c';
      email.dispatchEvent(new Event('input', { bubbles: true }));
      password.value = 'pw_new';
      password.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = container.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    // Должен появиться OTP-инпут с autocomplete=one-time-code.
    const otp = container.querySelector('input[autocomplete="one-time-code"]');
    expect(otp).toBeTruthy();
    expect(container.textContent).toContain('Check your email');
  });

  it('forgot password flow calls requestPasswordReset and shows confirmation', async () => {
    const reset = vi.fn(async () => undefined);
    const auth = makeAuthMock({ requestPasswordReset: reset });
    const { container } = renderPanel(BLOCK_DEFAULT, { auth });

    const forgot = Array.from(container.querySelectorAll('button')).find((b) =>
      /Forgot password/i.test(b.textContent ?? '')
    );
    act(() => forgot!.click());

    const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
    await act(async () => {
      email.value = 'me@b.c';
      email.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = container.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(reset).toHaveBeenCalledWith({ email: 'me@b.c' });
    expect(container.textContent).toMatch(/reset code has been sent/i);
  });
});
