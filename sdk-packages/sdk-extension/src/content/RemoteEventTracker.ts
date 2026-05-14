// RemoteEventTracker — fire-and-forget proxy для аналитики. Все track()
// call'ы из всех вкладок попадают в единственный EventTracker в offscreen'е,
// который батчит и шлёт в /events. Победа — один батч на расширение,
// один sendBeacon на unload, никаких дублирующихся `app_opened` событий.
//
// API специально минимальный — только track(name, props). Buffer / flush /
// destroy логика живёт в offscreen'е, content её не контролирует.

import { TransportClient } from '../shared/transport-client';

export class RemoteEventTracker {
  constructor(private readonly transport: TransportClient) {}

  /** Отправить событие. Fire-and-forget — не возвращает Promise, не throw'ает.
   *  Сетевые/транспортные ошибки логируются в console и не блокируют caller. */
  track(name: string, props?: Record<string, unknown>): void {
    if (typeof name !== 'string' || name.length === 0) return;
    this.transport.request('tracker.track', { name, props }).catch((e) => {
      console.warn('[paywall] track failed', e);
    });
  }
}
