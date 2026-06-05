import type { BillingClient } from '../core/BillingClient';
import type { PaywallUser } from '../core/types';

// The default parameters are tuned for "the user pays ~60-90s after clicking
// Continue, sometimes steps away for a coffee for 5-10 minutes". See the
// discussion in TODO.md (the "What this changes in the architecture" phase).
export interface UserWatcherOptions {
  client: BillingClient;
  /** Fired the first time we see has_active_subscription === true. */
  onActive: (user: PaywallUser) => void;
  /** Overall watch timeout. On expiry — stop without onActive. */
  onTimeout?: () => void;
  timeoutMs?: number;
  /** Polling interval while the tab is visible. */
  visibleIntervalMs?: number;
  /** Polling interval while the tab is hidden (the browser throttles timers). */
  hiddenIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_VISIBLE_INTERVAL_MS = 5_000;
const DEFAULT_HIDDEN_INTERVAL_MS = 30_000;

// Polling after checkout_started.
//
// Sources of the "check now" signal:
// 1. visibility change → visible (the user returned to the original tab).
// 2. window focus.
// 3. postMessage of the form { type: 'paywall_purchase' } from the success page
//    (acceleration: a success_url on our origin calls window.opener.postMessage).
// 4. A regular timer with a visibility-aware schedule.
//
// Stop: either has_active_subscription === true, or timeout.
//
// Runtime detection: see shouldRunUserWatcher() — the extension popup is discarded,
// it doesn't survive until the return from checkout. The background service worker
// is filtered out by the `typeof document` check in start().
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
      /* transient errors — skip one tick, the poller will fire again */
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
    // Reschedule the timer with the interval for the new state.
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

// Decide whether it even makes sense to run the watcher in the current runtime.
// false → the code that should close the paywall on payment relies on a
// different path (the absence of document — for the MV3 service worker).
//
// The watcher needs a DOM + window: it hangs on visibilitychange/focus/message
// events and a timer. That requirement filters out the service worker.
//
// We DON'T gate on the chrome-extension:// protocol. A full extension page /
// side panel survives the checkout (it opens in a separate tab), so it both
// can and must poll — gating it out left the awaiting screen with no way to
// close (the transition funnels through this watcher). The one context this
// doesn't help is the ephemeral toolbar action-popup: window.open() for the
// checkout steals focus and Chrome destroys the popup, taking the watcher with
// it — there the watcher harmlessly tears down and the next-open bootstrap
// covers detection. So running it everywhere with a DOM is safe.
export function shouldRunUserWatcher(): boolean {
  if (typeof document === 'undefined') return false;
  if (typeof window === 'undefined') return false;
  return true;
}
