import type { BillingClient } from '../core/BillingClient';
import type { PaywallUser } from '../core/types';

// Параметры по умолчанию подобраны под "юзер платит ~60-90с после клика
// Continue, иногда ходит за чашкой 5-10 минут". См. обсуждение в TODO.md
// (фаза "Что это меняет в архитектуре").
export interface UserWatcherOptions {
  client: BillingClient;
  /** Дёрнут, когда впервые увидели has_active_subscription === true. */
  onActive: (user: PaywallUser) => void;
  /** Полный таймаут наблюдения. По истечении — стоп без onActive. */
  onTimeout?: () => void;
  timeoutMs?: number;
  /** Интервал polling, когда вкладка видимая. */
  visibleIntervalMs?: number;
  /** Интервал polling, когда вкладка скрыта (браузер троттлит таймеры). */
  hiddenIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_VISIBLE_INTERVAL_MS = 5_000;
const DEFAULT_HIDDEN_INTERVAL_MS = 30_000;

// Polling после checkout_started.
//
// Источники сигнала "проверить сейчас":
// 1. visibility change → visible (юзер вернулся в исходную вкладку).
// 2. window focus.
// 3. postMessage вида { type: 'paywall_purchase' } от success-страницы
//    (acceleration: success_url на нашем origin делает window.opener.postMessage).
// 4. Регулярный таймер с visibility-aware расписанием.
//
// Стоп: либо has_active_subscription === true, либо таймаут.
//
// Runtime detection: см. shouldRunUserWatcher() — extension popup отбрасывается,
// он не доживает до возврата с checkout. Background service worker отсекается
// проверкой `typeof document` в start().
export class UserWatcher {
  private opts: Required<Omit<UserWatcherOptions, 'client'>> & { client: BillingClient };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private focusHandler: (() => void) | null = null;
  private messageHandler: ((e: MessageEvent) => void) | null = null;
  private stopped = false;
  private checking = false;

  constructor(opts: UserWatcherOptions) {
    this.opts = {
      client: opts.client,
      onActive: opts.onActive,
      onTimeout: opts.onTimeout ?? (() => {}),
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      visibleIntervalMs: opts.visibleIntervalMs ?? DEFAULT_VISIBLE_INTERVAL_MS,
      hiddenIntervalMs: opts.hiddenIntervalMs ?? DEFAULT_HIDDEN_INTERVAL_MS
    };
  }

  start(): void {
    if (this.stopped) return;
    if (typeof document === 'undefined' || typeof window === 'undefined') return;

    void this.check();
    this.scheduleNext();

    this.visibilityHandler = () => this.handleVisibilityChange();
    document.addEventListener('visibilitychange', this.visibilityHandler);

    this.focusHandler = () => void this.check();
    window.addEventListener('focus', this.focusHandler);

    this.messageHandler = (e: MessageEvent) => this.handleMessage(e);
    window.addEventListener('message', this.messageHandler);

    this.timeoutTimer = setTimeout(() => {
      if (this.stopped) return;
      this.stop();
      this.opts.onTimeout();
    }, this.opts.timeoutMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.timeoutTimer !== null) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = null;
    if (typeof document !== 'undefined' && this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    if (typeof window !== 'undefined') {
      if (this.focusHandler) window.removeEventListener('focus', this.focusHandler);
      if (this.messageHandler) window.removeEventListener('message', this.messageHandler);
    }
    this.visibilityHandler = null;
    this.focusHandler = null;
    this.messageHandler = null;
  }

  private async check(): Promise<void> {
    if (this.stopped || this.checking) return;
    this.checking = true;
    try {
      const user = await this.opts.client.getUser({ force: true });
      if (this.stopped) return;
      if (user.has_active_subscription) {
        this.stop();
        this.opts.onActive(user);
      }
    } catch {
      /* транзиентные ошибки — пропустим один тик, поллер дёрнет ещё */
    } finally {
      this.checking = false;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const visible =
      typeof document !== 'undefined' && document.visibilityState === 'visible';
    const interval = visible
      ? this.opts.visibleIntervalMs
      : this.opts.hiddenIntervalMs;
    this.timer = setTimeout(async () => {
      await this.check();
      this.scheduleNext();
    }, interval);
  }

  private handleVisibilityChange(): void {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'visible') void this.check();
    // Перепланируем таймер с интервалом нового состояния.
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduleNext();
  }

  private handleMessage(e: MessageEvent): void {
    const data = e.data as { type?: string } | null;
    if (!data || typeof data !== 'object') return;
    if (data.type !== 'paywall_purchase') return;
    void this.check();
  }
}

// Решаем, имеет ли смысл вообще запускать watcher в текущем рантайме.
// false → код, который должен закрывать пейвол на оплату, полагается на
// другой путь (bootstrap при следующем открытии для extension popup;
// отсутствие document — для service worker).
export function shouldRunUserWatcher(): boolean {
  if (typeof document === 'undefined') return false;
  if (typeof window === 'undefined') return false;
  // Chrome extension popup живёт только пока открыт. window.open()
  // checkout-провайдера сразу ест фокус → popup закрывается → весь JS-context
  // (включая SDK и watcher) уничтожается. Polling тут бесполезен.
  if (typeof location !== 'undefined' && location.protocol === 'chrome-extension:') {
    return false;
  }
  return true;
}
