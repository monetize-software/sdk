import { SDK_VERSION } from './api';

// Аналитический трекер SDK 3.0. Принимает события (системные через
// bindEventTracker и кастомные через PaywallUI.track()), копит в буфере и
// батчем шлёт на /api/v1/paywall/{id}/events.
//
// Принципы:
// - Fire-and-forget. Любая ошибка POST не должна влиять на UX.
// - Бэк-нагрузка минимальна: батч ~10-20 событий за окно ~1.5с.
// - sendBeacon на pagehide/visibilitychange — гарантирует доставку
//   "последней мили" при закрытии вкладки.
// - Без headers в beacon-режиме (нельзя по спеке) — visitor_id/user_id/sdk
//   metadata дублируются в body как fallback. Сервер их умеет читать.

export interface TrackedEvent {
  type: string;
  ts: number;
  props?: Record<string, unknown>;
}

export interface EventTrackerOptions {
  endpoint: string;
  paywallId: string;
  capabilities?: string[];
  getVisitorId: () => Promise<string>;
  getCachedVisitorId?: () => string | null;
  getUserId?: () => string | null | undefined;
  enabled?: boolean;
  flushIntervalMs?: number;
  maxBufferSize?: number;
  /** Тестовый override fetch'а. */
  fetch?: typeof fetch;
  /** Тестовый override sendBeacon'а — позволяет проверить unload-flow в jsdom. */
  sendBeacon?: (url: string, data: BodyInit) => boolean;
}

const DEFAULT_FLUSH_INTERVAL_MS = 1500;
const DEFAULT_MAX_BUFFER_SIZE = 20;
// Hard cap, чтобы фоновая запись не разрослась бесконечно при глухой сети.
const HARD_BUFFER_LIMIT = 200;

export class EventTracker {
  private opts: EventTrackerOptions;
  private buffer: TrackedEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private unloadHandler: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;

  constructor(opts: EventTrackerOptions) {
    this.opts = opts;
    if (this.isEnabled()) this.attachUnloadHandlers();
  }

  private isEnabled(): boolean {
    return this.opts.enabled !== false;
  }

  track(type: string, props?: Record<string, unknown>): void {
    if (this.destroyed || !this.isEnabled()) return;
    if (typeof type !== 'string' || type.length === 0) return;

    this.buffer.push({ type, ts: Date.now(), props });

    const max = this.opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    if (this.buffer.length >= max) {
      void this.flush();
      return;
    }
    if (this.buffer.length > HARD_BUFFER_LIMIT) {
      // Защита от утечки при недоступности сервера: дропаем самые старые.
      this.buffer = this.buffer.slice(-HARD_BUFFER_LIMIT);
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.destroyed) return;
    const interval = this.opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, interval);
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const events = this.buffer;
    this.buffer = [];

    try {
      const visitorId = await this.opts.getVisitorId();
      const userId = this.opts.getUserId?.() ?? null;
      const body = JSON.stringify({ events });
      const fetchImpl = this.opts.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
      if (!fetchImpl) return;

      await fetchImpl(this.opts.endpoint, {
        method: 'POST',
        credentials: 'omit',
        keepalive: true, // если страница закроется в этот момент — браузер всё равно дотянет
        headers: this.buildHeaders(visitorId, userId),
        body
      });
    } catch {
      /* тихо: аналитика не должна мешать UX. Потеря события приемлема. */
    }
  }

  /**
   * Отправка через navigator.sendBeacon — для unload/pagehide. Гарантированно
   * долетает (POST с keepalive тоже почти, но beacon сделан именно под это).
   * Headers ставить нельзя (спецификация), поэтому SDK metadata едет в body
   * как fallback-поля, которые сервер читает в дополнение к headers.
   */
  flushBeacon(): void {
    if (this.buffer.length === 0) return;

    const events = this.buffer;
    this.buffer = [];

    const visitorId = this.opts.getCachedVisitorId?.() ?? null;
    const userId = this.opts.getUserId?.() ?? null;

    // Если visitor_id ещё не зарезолвили (редкий race на ранней секунде жизни) —
    // вернём события в буфер и вызовем обычный flush с keepalive-fetch'ом.
    if (!visitorId) {
      this.buffer.unshift(...events);
      void this.flush();
      return;
    }

    const body = JSON.stringify({
      events,
      // body-level дубликаты для beacon-flow, читаются сервером как fallback.
      visitor_id: visitorId,
      user_id: userId,
      sdk_version: SDK_VERSION,
      paywall_id: this.opts.paywallId,
      capabilities: this.opts.capabilities?.join(',') ?? ''
    });

    const beacon =
      this.opts.sendBeacon ??
      (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
        ? navigator.sendBeacon.bind(navigator)
        : null);

    if (!beacon) {
      // Возвращаем events в буфер — обычный flush через keepalive подберёт.
      this.buffer.unshift(...events);
      void this.flush();
      return;
    }

    try {
      // text/plain — sendBeacon обычно ставит этот тип, сервер парсит вручную.
      const ok = beacon(this.opts.endpoint, body);
      if (!ok) {
        this.buffer.unshift(...events);
        void this.flush();
      }
    } catch {
      this.buffer.unshift(...events);
      void this.flush();
    }
  }

  private buildHeaders(visitorId: string, userId: string | null): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-SDK-Version': SDK_VERSION,
      'X-Paywall-Id': this.opts.paywallId,
      'X-Visitor-Id': visitorId
    };
    if (this.opts.capabilities?.length) {
      h['X-SDK-Capabilities'] = this.opts.capabilities.join(',');
    }
    if (userId) h['X-User-Id'] = userId;
    return h;
  }

  private attachUnloadHandlers(): void {
    if (typeof window === 'undefined') return;

    this.unloadHandler = () => this.flushBeacon();
    this.visibilityHandler = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        this.flushBeacon();
      }
    };

    // pagehide — основной путь (стабильнее чем unload, работает в bfcache).
    window.addEventListener('pagehide', this.unloadHandler);
    // visibilitychange/hidden — дополнительный, на iOS Safari часто единственный.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  private detachUnloadHandlers(): void {
    if (typeof window === 'undefined') return;
    if (this.unloadHandler) window.removeEventListener('pagehide', this.unloadHandler);
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    this.unloadHandler = null;
    this.visibilityHandler = null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    void this.flush();
    this.detachUnloadHandlers();
  }
}
