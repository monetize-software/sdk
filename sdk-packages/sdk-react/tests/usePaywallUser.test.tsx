import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { PaywallUser } from '../src';
import { PaywallProvider, usePaywallUser } from '../src';
import { FakePaywall, asPaywallUI } from './fakePaywall';

const USER_PRO: PaywallUser = {
  user_id: 'u1',
  email: 'a@b.c',
  has_active_subscription: true
} as unknown as PaywallUser;

describe('usePaywallUser', () => {
  it('null до первого userChange, потом snapshot из getCachedUser', () => {
    const fake = new FakePaywall();
    const { result } = renderHook(() => usePaywallUser(), {
      wrapper: ({ children }) => (
        <PaywallProvider instance={asPaywallUI(fake)}>{children}</PaywallProvider>
      )
    });
    expect(result.current).toBeNull();

    act(() => {
      fake.setUser(USER_PRO);
    });

    expect(result.current).toBe(USER_PRO);
  });
});
