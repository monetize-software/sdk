// Drop-in `PaywallUI` for the extension. The public API is identical to
// `@monetize.software/sdk` — the host writes the same code, the same options. Under the hood:
//  - billing — RemoteBillingClient (a proxy into offscreen)
//  - auth — RemoteAuthClient (when `auth: true`)
//  - tracker — RemoteEventTracker (events are forwarded into the offscreen EventTracker)
//
// The EventTracker is created ONCE per extension, in offscreen. PaywallUI here
// disables the internal tracker (`analytics: false` in the base constructor) and
// subscribes to public events itself, proxying them through RemoteEventTracker.
// It duplicates the bindings from the base PaywallUI.initTracker — but that's the
// lesser evil compared to two EventTrackers per user.

import { PaywallUI as BasePaywallUI, type PaywallUIOptions } from '@sdk/ui/PaywallUI';
import type { BillingClient } from '@sdk/core/BillingClient';
import type { AuthClient } from '@sdk/core/auth';
import { RemoteBillingClient } from './RemoteBillingClient';
import { RemoteAuthClient } from './RemoteAuthClient';
import { RemoteEventTracker } from './RemoteEventTracker';
import { getContentTransport } from './transport';

/** Options for the extension's PaywallUI. Removed:
 *  - `client` — RemoteBillingClient is created automatically
 *  - `storage` — storage lives in offscreen, content doesn't see it
 *  - `apiKey` — a server-SDK key, meaningless in a content-script
 *  - `fetch` — all network requests go through offscreen
 *
 *  `auth: true` will wire up RemoteAuthClient. Passing a ready AuthClient from
 *  @monetize.software/sdk here makes no sense (we specifically want the offscreen one). */
export interface ExtensionPaywallUIOptions
  extends Omit<PaywallUIOptions, 'client' | 'storage' | 'apiKey' | 'fetch'> {}

export class PaywallUI extends BasePaywallUI {
  /** RemoteEventTracker (a proxy into the offscreen EventTracker). Not to be
   *  confused with the base class's `tracker` (which is null — we disabled the internal one). */
  private remoteTracker: RemoteEventTracker | null = null;
  private trackerUnsubs: Array<() => void> = [];

  constructor(opts: ExtensionPaywallUIOptions) {
    const transport = getContentTransport();

    const billing = new RemoteBillingClient(transport, {
      paywallId: opts.paywallId,
      apiOrigin: opts.apiOrigin
    });

    // Auth: if the host asked for it — construct a RemoteAuthClient. There's no
    // point passing a ready AuthClient from @monetize.software/sdk here (we need the
    // offscreen instance anyway). So we accept only `true` or nothing; an
    // explicit AuthClient instance logs a warning and is ignored.
    let auth: RemoteAuthClient | undefined;
    if (opts.auth === true) {
      auth = new RemoteAuthClient(transport, {
        paywallId: opts.paywallId,
        apiOrigin: opts.apiOrigin
      });
    } else if (opts.auth) {
      console.warn(
        '[sdk-extension] passing AuthClient instance to PaywallUI.opts.auth ' +
          'is not supported in extension mode — pass `auth: true` to use ' +
          'offscreen-shared auth, or omit for hybrid identity-only mode.'
      );
    }

    // Pass auth into the billing client: PaywallRoot reads `client.auth` for
    // restore / preauth-flow / signin-detection. The real BillingClient sets
    // this field in its constructor — for the Remote variant we do an explicit
    // assignment before super() so PaywallRoot sees it.
    if (auth) {
      (billing as { auth?: typeof auth }).auth = auth;
    }

    super({
      ...opts,
      // The casts are safe: PaywallUI's resolveAuth duck-types auth (see
      // sdk/src/ui/PaywallUI.ts isAuthClientLike), and the billing param goes
      // through `opts.client ?? new BillingClient(...)` — RemoteBillingClient is
      // used there as-is, all the methods line up.
      client: billing as unknown as BillingClient,
      auth: auth as unknown as AuthClient | undefined,
      // Disable the internal EventTracker — the only tracker lives in offscreen.
      // We subscribe manually below.
      analytics: false
    });

    if (opts.analytics !== false) {
      this.remoteTracker = new RemoteEventTracker(transport);
      this.bindAnalytics();
    }
  }

  /** A mirror of sdk/PaywallUI.initTracker's bindings, but with RemoteEventTracker.
   *  Once @monetize.software/sdk exposes a public hook for injecting a tracker,
   *  this method will be replaced with a single line. */
  private bindAnalytics(): void {
    const t = this.remoteTracker;
    if (!t) return;

    this.trackerUnsubs.push(
      this.on('ready', (b) =>
        t.track('paywall_viewed', {
          is_test_mode: b.settings.is_test_mode,
          prices_count: b.prices.length,
          offers_count: b.offers.length
        })
      ),
      this.on('price_selected', (p) =>
        t.track('price_selected', { price_id: p.priceId })
      ),
      this.on('checkout_started', (p) =>
        t.track('checkout_started', { price_id: p.priceId, acquiring: p.acquiring })
      ),
      this.on('purchase_completed', (p) =>
        t.track('purchase_completed', { price_id: p.priceId, session_id: p.sessionId })
      ),
      this.on('purchase_failed', (p) => t.track('purchase_failed', { reason: p.reason })),
      this.on('close', () => t.track('paywall_closed')),
      this.on('trial_blocked', (s) =>
        t.track('trial_blocked', {
          mode: s.mode,
          ...(s.mode === 'time'
            ? { remaining_ms: s.remainingMs, total_ms: s.totalMs }
            : s.mode === 'opens'
              ? { remaining_actions: s.remainingActions, total_actions: s.totalActions }
              : {})
        })
      ),
      this.on('trial_expired', () => t.track('trial_expired')),
      this.on('visibility_blocked', (v) =>
        t.track('visibility_blocked', { reason: v.reason, country: v.country, tier: v.tier })
      ),
      this.on('error', (e) => t.track('error', { code: e.code, message: e.message }))
    );

    // We don't fire auth_signin_success / auth_signout yet: authChange is emitted
    // both on session hydration (the popup brings up the cache from offscreen)
    // and on token refresh, and with a parallel content-script + popup it gives
    // false signins. Real login events should be caught via direct calls to
    // signInWithEmail/signUp/signInWithOAuth/signOut, not via authChange.
  }

  /** A proxy through RemoteEventTracker. Hosts can call paywall.track for
   *  arbitrary analytics events — it flies to the single offscreen tracker
   *  alongside PaywallUI's auto-emits. */
  track(name: string, props?: Record<string, unknown>): void {
    this.remoteTracker?.track(name, props);
  }

  destroy(): void {
    for (const fn of this.trackerUnsubs) fn();
    this.trackerUnsubs = [];
    this.remoteTracker = null;
    super.destroy();
  }
}
