// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { PaywallRoot } from '../src/ui/PaywallRoot';
import type { BillingClient } from '../src/core/BillingClient';
import type { AuthClient, AuthSession } from '../src/core/auth';
import type { LayoutBlock, PaywallBootstrap } from '../src/core/types';

// Render tests for the support flow in PaywallRoot:
// 1. Contact Support from the current_session block — opens SupportGate with Back to the layout.
// 2. initialView='support' (paywall.openSupport()) — opens SupportGate immediately,
//    Back closes the modal (origin='standalone').
// 3. Submit success → "Request submitted" with the email.
// 4. Submit error → the inline error stays in the form.
// 5. A logged-in user sees "Sending as <email>" instead of an input.

function makeSession(email = 'logged@in.com'): AuthSession {
  return {
    access_token: 'a1',
    refresh_token: 'r1',
    expires_at: Date.now() + 3600_000,
    user: { id: 'u_1', email }
  };
}

interface AuthHarness {
  auth: AuthClient;
}

function makeAuthHarness(session: AuthSession | null = null): AuthHarness {
  return {
    auth: {
      paywallId: 'pw_1',
      onAuthChange: (): (() => void) => () => undefined,
      getCachedSession: (): AuthSession | null => session,
      getCachedUser: (): null => null,
      ready: async (): Promise<void> => undefined,
      getAccessToken: async (): Promise<string | null> => null,
      getLastLogin: async (): Promise<null> => null,
      signOut: vi.fn(async (): Promise<void> => undefined)
    } as unknown as AuthClient
  };
}

interface ClientHarness {
  client: BillingClient;
  createSupportTicket: ReturnType<typeof vi.fn>;
}

function makeClient(
  opts: {
    auth?: AuthClient;
    ticketResponse?: { ticket: { id: number; status: string } };
    ticketError?: Error;
    withCurrentSession?: boolean;
  } = {}
): ClientHarness {
  const blocks: LayoutBlock[] = [
    { type: 'price_grid' },
    { type: 'cta_button', label: 'Continue', action: 'checkout' }
  ];
  if (opts.withCurrentSession) blocks.push({ type: 'current_session' });

  const bootstrap: PaywallBootstrap = {
    settings: { id: 'pw_1', name: 'Test' },
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
    layout: { type: 'modal', blocks }
  };

  const createSupportTicket = vi.fn(async () => {
    if (opts.ticketError) throw opts.ticketError;
    return opts.ticketResponse ?? { ticket: { id: 1, status: 'open' } };
  });

  const client = {
    auth: opts.auth,
    bootstrap: vi.fn(async () => bootstrap),
    createCheckout: vi.fn(),
    createSupportTicket
  } as unknown as BillingClient;

  return { client, createSupportTicket };
}

function mount(
  client: BillingClient,
  initialView: 'layout' | 'support' = 'layout'
): { container: HTMLElement; closes: number; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let closes = 0;
  act(() => {
    render(
      h(PaywallRoot, {
        client,
        open: true,
        initialView,
        onClose: (): void => {
          closes += 1;
        },
        onEvent: (): void => undefined
      }),
      container
    );
  });
  return {
    container,
    get closes(): number {
      return closes;
    },
    unmount: () => {
      render(null, container);
      container.remove();
    }
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text
  ) as HTMLButtonElement | undefined;
}

function clickByText(container: HTMLElement, text: string): void {
  const btn = findButton(container, text);
  if (!btn) throw new Error(`button "${text}" not found`);
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function fillInput(container: HTMLElement, placeholder: string, value: string): void {
  // SupportGate now uses placeholders instead of separate labels
  // (filled-input style). We find the input/textarea by a placeholder substring.
  const candidates = Array.from(
    container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
  );
  const input = candidates.find((el) => (el.placeholder ?? '').includes(placeholder));
  if (!input) throw new Error(`input with placeholder "${placeholder}" not found`);
  act(() => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function clickBack(container: HTMLElement): void {
  // The Back/Close button is now a curved-arrow icon with no text; we find it by aria-label.
  const btn = container.querySelector<HTMLButtonElement>('button[aria-label="Back"]');
  if (!btn) throw new Error('Back button not found');
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('PaywallRoot support flow', () => {
  beforeEach(() => {
    vi.stubGlobal('open', vi.fn());
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Contact Support link from current_session opens SupportGate with Back to layout', async () => {
    const harness = makeAuthHarness(null);
    const { client } = makeClient({ auth: harness.auth, withCurrentSession: true });
    const { container, unmount } = mount(client);
    await flush();

    clickByText(container, 'Contact Support');
    await flush();

    // The Support heading + the Enter your subject/message placeholders prove
    // that SupportGate rendered (new layout: filled inputs, no labels).
    expect(container.textContent).toContain('Support');
    expect(
      container.querySelector<HTMLInputElement>('input[placeholder*="Enter your subject"]')
    ).toBeTruthy();
    expect(
      container.querySelector<HTMLTextAreaElement>('textarea[placeholder*="Enter your message"]')
    ).toBeTruthy();

    // Back returns to the layout (Continue is visible again, the support form disappears).
    clickBack(container);
    await flush();
    expect(findButton(container, 'Continue')).toBeTruthy();
    unmount();
  });

  it('initialView=support: opens SupportGate immediately, Close button closes modal', async () => {
    const { client } = makeClient();
    const handle = mount(client, 'support');
    // Independent of bootstrap — the form is already on screen.
    expect(
      handle.container.querySelector('input[placeholder*="Enter your subject"]')
    ).toBeTruthy();
    expect(
      handle.container.querySelector('textarea[placeholder*="Enter your message"]')
    ).toBeTruthy();
    // The Back button (aria-label="Back") is now a curved-arrow icon with no text.
    expect(handle.container.querySelector('button[aria-label="Back"]')).toBeTruthy();

    clickBack(handle.container);
    await flush();
    expect(handle.closes).toBe(1);
    handle.unmount();
  });

  it('signed-in user: email locked, "Sending as" text shown', async () => {
    const harness = makeAuthHarness(makeSession('me@me.com'));
    const { client } = makeClient({ auth: harness.auth, withCurrentSession: true });
    const { container, unmount } = mount(client);
    await flush();
    clickByText(container, 'Contact Support');
    await flush();

    expect(container.textContent).toContain('Sending as');
    expect(container.textContent).toContain('me@me.com');
    // the email input isn't rendered for a logged-in user (the "Enter your email" placeholder is absent).
    const emailInput = Array.from(container.querySelectorAll<HTMLInputElement>('input')).find(
      (el) => (el.placeholder ?? '').includes('Enter your email')
    );
    expect(emailInput).toBeUndefined();
    unmount();
  });

  it('successful submit shows "Request submitted" with the email', async () => {
    const { client, createSupportTicket } = makeClient({
      withCurrentSession: true,
      ticketResponse: { ticket: { id: 7, status: 'open' } }
    });
    const harness = makeAuthHarness(null);
    (client as unknown as { auth: AuthClient | undefined }).auth = harness.auth;
    const { container, unmount } = mount(client);
    await flush();
    clickByText(container, 'Contact Support');
    await flush();

    fillInput(container, 'Enter your email', 'guest@gh.com');
    fillInput(container, 'Enter your subject', 'Need help');
    fillInput(container, 'Enter your message','Some details about my issue.');

    const sendBtn = findButton(container, 'Send');
    expect(sendBtn?.disabled).toBe(false);
    act(() => {
      sendBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    await flush();

    expect(createSupportTicket).toHaveBeenCalledWith({
      subject: 'Need help',
      content: 'Some details about my issue.',
      email: 'guest@gh.com',
      files: undefined
    });
    expect(container.textContent).toContain('Request submitted');
    expect(container.textContent).toContain('guest@gh.com');
    unmount();
  });

  it('submit error keeps form mounted and shows inline error', async () => {
    const harness = makeAuthHarness(null);
    const { client } = makeClient({
      auth: harness.auth,
      withCurrentSession: true,
      ticketError: Object.assign(new Error('rate_limited'), { code: 'rate_limited' })
    });
    const { container, unmount } = mount(client);
    await flush();
    clickByText(container, 'Contact Support');
    await flush();

    fillInput(container, 'Enter your email', 'guest@gh.com');
    fillInput(container, 'Enter your subject', 'Need help');
    fillInput(container, 'Enter your message','msg');

    const sendBtn = findButton(container, 'Send');
    act(() => {
      sendBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    await flush();

    // The form didn't collapse into the success screen.
    expect(container.textContent).not.toContain('Request submitted');
    expect(container.textContent).toMatch(/Failed to send|rate_limited|Something went wrong/);
    unmount();
  });

  it('Back from standalone closes modal even when bootstrap not loaded yet', async () => {
    // Make a bootstrap that never resolves (simulating "still loading").
    const client = {
      auth: undefined,
      bootstrap: vi.fn((): Promise<PaywallBootstrap> => new Promise(() => undefined)),
      createCheckout: vi.fn(),
      createSupportTicket: vi.fn(async () => ({ ticket: { id: 1, status: 'open' } }))
    } as unknown as BillingClient;

    const handle = mount(client, 'support');
    // bootstrap must not get in the way — support is visible.
    expect(handle.container.textContent).toContain('Support');
    clickBack(handle.container);
    expect(handle.closes).toBe(1);
    handle.unmount();
  });
});
