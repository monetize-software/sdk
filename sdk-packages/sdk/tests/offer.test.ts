import { describe, expect, it } from 'vitest';
import { findApplicableOffer, findLiveOffer } from '../src/core/offer';
import type { PaywallOffer } from '../src/core/types';

function offer(partial: Partial<PaywallOffer>): PaywallOffer {
  return {
    id: 'o1',
    discount_percent: 20,
    expires_at: null,
    duration_minutes: null,
    price_id: null,
    ...partial
  } as PaywallOffer;
}

const NOW = Date.parse('2026-05-30T12:00:00.000Z');

describe('findLiveOffer', () => {
  it('возвращает оффер с expires_at в будущем', () => {
    const offers = [offer({ expires_at: '2026-05-30T13:00:00.000Z' })];
    expect(findLiveOffer(offers, 'p1', { now: NOW })?.id).toBe('o1');
  });

  it('режет просроченный expires_at-оффер (а findApplicableOffer — нет)', () => {
    const offers = [offer({ expires_at: '2026-05-30T11:00:00.000Z' })];
    // сырой подбор всё ещё отдаёт оффер — отсюда и был баг в PriceGrid
    expect(findApplicableOffer(offers, 'p1')?.id).toBe('o1');
    expect(findLiveOffer(offers, 'p1', { now: NOW })).toBeNull();
  });

  it('режет просроченный duration_minutes-оффер по записанному старту', () => {
    const offers = [offer({ duration_minutes: 30 })];
    const expiredStart = () => '2026-05-30T11:00:00.000Z'; // 60 мин назад > 30 мин
    expect(
      findLiveOffer(offers, 'p1', { now: NOW, readStart: expiredStart })
    ).toBeNull();
  });

  it('держит живой duration_minutes-оффер пока окно не вышло', () => {
    const offers = [offer({ duration_minutes: 30 })];
    const freshStart = () => '2026-05-30T11:50:00.000Z'; // 10 мин назад < 30 мин
    expect(
      findLiveOffer(offers, 'p1', { now: NOW, readStart: freshStart })?.id
    ).toBe('o1');
  });

  it('duration_minutes без записанного старта трактуется как perpetual (скидка видна)', () => {
    const offers = [offer({ duration_minutes: 30 })];
    expect(
      findLiveOffer(offers, 'p1', { now: NOW, readStart: () => null })?.id
    ).toBe('o1');
  });

  it('оффер без discount_percent не подбирается', () => {
    const offers = [offer({ discount_percent: 0, expires_at: '2026-05-30T13:00:00.000Z' })];
    expect(findLiveOffer(offers, 'p1', { now: NOW })).toBeNull();
  });
});
