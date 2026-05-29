import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { AuthSession, PaywallUser } from '../src';
import { PaywallProvider, usePaywallUser } from '../src';
import { FakePaywall, asPaywallUI } from './fakePaywall';

const USER_PRO: PaywallUser = {
  user_id: 'u1',
  email: 'a@b.c',
  has_active_subscription: true
} as unknown as PaywallUser;

const SESSION: AuthSession = {
  access_token: 'at',
  refresh_token: 'rt',
  expires_at: Date.now() / 1000 + 3600,
  user: { id: 'u1', email: 'a@b.c' }
} as unknown as AuthSession;

describe('usePaywallUser (managed-auth)', () => {
  it('guest когда нет session — даже после bootstrap c null user', () => {
    const fake = new FakePaywall({ withAuth: true });
    const { result } = renderHook(() => usePaywallUser(), {
      wrapper: ({ children }) => (
        <PaywallProvider instance={asPaywallUI(fake)}>{children}</PaywallProvider>
      )
    });
    expect(result.current.status).toBe('guest');
    expect(result.current.user).toBeNull();
    expect(result.current.session).toBeNull();
  });

  it('после signIn состояние signed_in с session, user приходит позже', () => {
    const fake = new FakePaywall({ withAuth: true });
    const { result } = renderHook(() => usePaywallUser(), {
      wrapper: ({ children }) => (
        <PaywallProvider instance={asPaywallUI(fake)}>{children}</PaywallProvider>
      )
    });

    act(() => {
      fake.setSession(SESSION);
    });
    expect(result.current.status).toBe('signed_in');
    expect(result.current.user).toBeNull();
    expect(result.current.session).toBe(SESSION);

    act(() => {
      fake.setUser(USER_PRO);
    });
    expect(result.current.status).toBe('signed_in');
    if (result.current.status === 'signed_in') {
      expect(result.current.user).toBe(USER_PRO);
      expect(result.current.session).toBe(SESSION);
    }
  });

  it('signOut возвращает в guest', () => {
    const fake = new FakePaywall({ withAuth: true, initialSession: SESSION });
    const { result } = renderHook(() => usePaywallUser(), {
      wrapper: ({ children }) => (
        <PaywallProvider instance={asPaywallUI(fake)}>{children}</PaywallProvider>
      )
    });
    act(() => {
      fake.setUser(USER_PRO);
    });
    expect(result.current.status).toBe('signed_in');

    act(() => {
      fake.setSession(null);
      fake.setUser(null);
    });
    expect(result.current.status).toBe('guest');
  });
});

describe('usePaywallUser (hybrid mode)', () => {
  it('без managed-auth — guest пока не пришёл user через bootstrap', () => {
    const fake = new FakePaywall();
    const { result } = renderHook(() => usePaywallUser(), {
      wrapper: ({ children }) => (
        <PaywallProvider instance={asPaywallUI(fake)}>{children}</PaywallProvider>
      )
    });
    expect(result.current.status).toBe('guest');

    act(() => {
      fake.setUser(USER_PRO);
    });
    expect(result.current.status).toBe('signed_in');
    if (result.current.status === 'signed_in') {
      expect(result.current.user).toBe(USER_PRO);
      expect(result.current.session).toBeNull();
    }
  });
});
