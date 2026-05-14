import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PaywallAccessResult, PaywallUser } from '../src';
import { PaywallProvider, usePaywallAccess } from '../src';
import { FakePaywall, asPaywallUI } from './fakePaywall';

const BLOCKED: PaywallAccessResult = {
  access: 'blocked',
  reason: 'no_subscription',
  visibility: null,
  trial: null,
  user: null
};

const GRANTED: PaywallAccessResult = {
  access: 'granted',
  reason: 'has_subscription',
  visibility: null,
  trial: null,
  user: { user_id: 'u1', has_active_subscription: true } as unknown as PaywallUser
};

describe('usePaywallAccess', () => {
  it('loading → ready после первого getAccess', async () => {
    const fake = new FakePaywall({ initialAccess: BLOCKED });

    const { result } = renderHook(() => usePaywallAccess(), {
      wrapper: ({ children }) => (
        <PaywallProvider instance={asPaywallUI(fake)}>{children}</PaywallProvider>
      )
    });

    expect(result.current.status).toBe('loading');

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.status === 'ready' && result.current.result.access).toBe('blocked');
  });

  it('рефетчится на userChange и переключается на granted', async () => {
    const fake = new FakePaywall({ initialAccess: BLOCKED });

    const { result } = renderHook(() => usePaywallAccess(), {
      wrapper: ({ children }) => (
        <PaywallProvider instance={asPaywallUI(fake)}>{children}</PaywallProvider>
      )
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fake.getAccessCalls).toBeGreaterThanOrEqual(1);

    // Юзер купил подписку — следующий getAccess() должен вернуть granted.
    fake.setAccess(GRANTED);
    act(() => {
      fake.emit('userChange', { has_active_subscription: true });
    });

    await waitFor(() =>
      expect(
        result.current.status === 'ready' &&
          result.current.result.access === 'granted'
      ).toBe(true)
    );
  });
});
