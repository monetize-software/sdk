import { describe, expect, it, vi } from 'vitest';
import { render, renderHook } from '@testing-library/react';
import { PaywallProvider, usePaywall } from '../src';
import { FakePaywall, asPaywallUI } from './fakePaywall';

describe('<PaywallProvider>', () => {
  it('кладёт переданный instance в контекст synchronously', () => {
    const fake = new FakePaywall();
    const { result } = renderHook(() => usePaywall(), {
      wrapper: ({ children }) => (
        <PaywallProvider instance={asPaywallUI(fake)}>{children}</PaywallProvider>
      )
    });
    expect(result.current).toBe(asPaywallUI(fake));
  });

  it('бросает понятную ошибку, если usePaywall() вне Provider', () => {
    // On a throw during render, React 18 logs a boundary message to
    // console.error — this makes the test output noisy, but the behavior itself
    // is correct. We mute only this log for the duration of the test so the
    // other tests don't lose their diagnostics.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => usePaywall())).toThrow(
      /usePaywall.*outside.*PaywallProvider/i
    );
    errSpy.mockRestore();
  });

  it('destroy() своего инстанса в cleanup, не трогает externally-supplied', () => {
    const fake = new FakePaywall();
    const { unmount } = render(
      <PaywallProvider instance={asPaywallUI(fake)}>child</PaywallProvider>
    );
    unmount();
    expect(fake.destroyCalls).toBe(0);
  });
});
