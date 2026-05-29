import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ResolvedOffer } from '../src';
import { PaywallProvider, usePaywallOffer, usePaywallOffers } from '../src';
import { FakePaywall, asPaywallUI } from './fakePaywall';

const OFFER: ResolvedOffer = {
  offer: {
    id: 'off1',
    discount_percent: 20,
    expires_at: null,
    duration_minutes: 60,
    price_id: 'p1',
    label: 'Limited offer'
  },
  discountPercent: 20,
  remainingMs: 60_000,
  totalMs: 3_600_000,
  expiresAt: Date.now() + 60_000
};

describe('usePaywallOffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the resolved offer for the given price', () => {
    const fake = new FakePaywall();
    fake.setOfferForPrice('p1', OFFER);
    const { result } = renderHook(() => usePaywallOffer('p1'), {
      wrapper: ({ children }) => (
        <PaywallProvider instance={asPaywallUI(fake)}>{children}</PaywallProvider>
      )
    });
    expect(result.current).toBe(OFFER);
  });

  it('null when no offer matches the price', () => {
    const fake = new FakePaywall();
    const { result } = renderHook(() => usePaywallOffer('p1'), {
      wrapper: ({ children }) => (
        <PaywallProvider instance={asPaywallUI(fake)}>{children}</PaywallProvider>
      )
    });
    expect(result.current).toBeNull();
  });

  it('ticks while there is a countdown and refreshes the resolved offer', () => {
    const fake = new FakePaywall();
    fake.setOfferForPrice('p1', { ...OFFER, remainingMs: 2_000 });
    const { result } = renderHook(() => usePaywallOffer('p1'), {
      wrapper: ({ children }) => (
        <PaywallProvider instance={asPaywallUI(fake)}>{children}</PaywallProvider>
      )
    });
    expect(result.current?.remainingMs).toBe(2_000);

    act(() => {
      fake.setOfferForPrice('p1', { ...OFFER, remainingMs: 1_000 });
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current?.remainingMs).toBe(1_000);

    act(() => {
      fake.setOfferForPrice('p1', null);
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBeNull();
  });
});

describe('usePaywallOffers', () => {
  it('returns the cached offers list', () => {
    const fake = new FakePaywall();
    fake.setOffers([OFFER.offer]);
    const { result } = renderHook(() => usePaywallOffers(), {
      wrapper: ({ children }) => (
        <PaywallProvider instance={asPaywallUI(fake)}>{children}</PaywallProvider>
      )
    });
    expect(result.current).toEqual([OFFER.offer]);
  });
});
