import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { PaywallProvider, usePaywallState } from '../src';
import { FakePaywall, asPaywallUI } from './fakePaywall';

describe('usePaywallState', () => {
  it('возвращает initial snapshot и реагирует на onStateChange', () => {
    const fake = new FakePaywall({
      initialState: { open: false, view: null, error: null, processing: false }
    });

    const { result } = renderHook(() => usePaywallState(), {
      wrapper: ({ children }) => (
        <PaywallProvider instance={asPaywallUI(fake)}>{children}</PaywallProvider>
      )
    });

    expect(result.current).toEqual({ open: false, view: null, error: null, processing: false });

    act(() => {
      fake.setState({ open: true, view: 'layout', error: null, processing: false });
    });

    expect(result.current).toEqual({
      open: true,
      view: 'layout',
      error: null,
      processing: false
    });
  });
});
