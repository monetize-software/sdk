import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { PaywallProvider, usePaywallEvent } from '../src';
import { FakePaywall, asPaywallUI } from './fakePaywall';

describe('usePaywallEvent', () => {
  it('подписывается на событие и вызывает свежий handler без re-subscribe', () => {
    const fake = new FakePaywall();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    const { rerender, unmount } = renderHook(
      ({ handler }) => usePaywallEvent('purchase_completed', handler),
      {
        initialProps: { handler: handler1 },
        wrapper: ({ children }) => (
          <PaywallProvider instance={asPaywallUI(fake)}>{children}</PaywallProvider>
        )
      }
    );

    act(() => {
      fake.emit('purchase_completed', { priceId: 'p1', sessionId: 's1' });
    });
    expect(handler1).toHaveBeenCalledWith({ priceId: 'p1', sessionId: 's1' });

    // Меняем handler без unmount — старая подписка должна позвать новый handler
    // (через ref), а не пересоздаваться.
    rerender({ handler: handler2 });

    act(() => {
      fake.emit('purchase_completed', { priceId: 'p2', sessionId: 's2' });
    });
    expect(handler2).toHaveBeenCalledWith({ priceId: 'p2', sessionId: 's2' });
    expect(handler1).toHaveBeenCalledTimes(1);

    unmount();

    // После unmount подписка снята — handler больше не вызывается.
    act(() => {
      fake.emit('purchase_completed', { priceId: 'p3', sessionId: 's3' });
    });
    expect(handler2).toHaveBeenCalledTimes(1);
  });
});
