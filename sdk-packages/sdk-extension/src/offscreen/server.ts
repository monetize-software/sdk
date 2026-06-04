// Offscreen-side server. Owns the real BillingClient + AuthClient (if enabled)
// — the single source of truth for the whole extension. Registers handlers on
// the TransportServer, accepts ports from the SW via chrome.runtime.onConnect,
// broadcasts userChange/authChange/balancesChange on state changes.
//
// Lifecycle: the server is created once via startOffscreenServer(). If the SW
// restarts, it re-creates offscreen (if the document died) or opens a new port
// (if the document is alive). In both cases the server accepts the new channel,
// and the state survives.
//
// OAuth flows. The PKCE verifier is held in offscreen between the oauthStart and
// oauthExchange requests. Content only opens the popup and waits for the code
// (natively, in its own frame) — the verifier never crosses the runtime boundary.

import { BillingClient } from '@sdk/core/BillingClient';
import { AuthClient } from '@sdk/core/auth';
import { EventTracker } from '@sdk/core/EventTracker';
import { createTrialStore } from '@sdk/core/trial';
import type { TrialConfig } from '@sdk/core/types';
import type { OffscreenServerOptions } from './index';
import { TransportServer } from '../shared/transport-server';
import { portToChannel } from '../shared/chrome-port';
import { RELAY_PORT_NAME } from '../shared/port-name';

export class OffscreenServer {
  readonly billing: BillingClient;
  readonly auth: AuthClient | undefined;
  readonly tracker: EventTracker | undefined;
  private readonly transport = new TransportServer();
  private connectListener: ((port: chrome.runtime.Port) => void) | null = null;
  private userUnsub: (() => void) | null = null;
  private balanceUnsub: (() => void) | null = null;
  private authUnsub: (() => void) | null = null;

  constructor(opts: OffscreenServerOptions) {
    if (opts.auth) {
      this.auth = new AuthClient({
        paywallId: opts.paywallId,
        apiOrigin: opts.apiOrigin
      });
    }

    this.billing = new BillingClient({
      paywallId: opts.paywallId,
      apiOrigin: opts.apiOrigin,
      auth: this.auth
    });

    this.tracker = createTrackerIfEnabled(opts, this.billing);

    this.registerBillingHandlers();
    if (this.auth) this.registerAuthHandlers(this.auth);
    if (this.tracker) this.registerTrackerHandlers(this.tracker);
    this.bridgeBroadcasts();
  }

  private registerTrackerHandlers(tracker: EventTracker): void {
    this.transport.on('tracker.track', (params) => {
      tracker.track(params.name, params.props);
    });
  }

  private registerBillingHandlers(): void {
    // ctx.signal is forwarded into the underlying fetch — cancellation from the
    // content side (the user closed the modal) actually cancels the network
    // request in offscreen, instead of leaving a "zombie fetch" hanging until
    // timeout.
    this.transport.on('billing.bootstrap', async (params, ctx) =>
      this.billing.bootstrap({ force: params.force, signal: ctx.signal })
    );
    this.transport.on('billing.getCachedBootstrap', () =>
      this.billing.getCachedBootstrap()
    );

    this.transport.on('billing.getVisitorId', async () => this.billing.getVisitorId());

    this.transport.on('billing.getUser', async (params, ctx) =>
      this.billing.getUser({ force: params.force, signal: ctx.signal })
    );
    this.transport.on('billing.getCachedUser', () => this.billing.getCachedUser());

    this.transport.on('billing.getBalances', async (params, ctx) =>
      this.billing.getBalances({ force: params.force, signal: ctx.signal })
    );
    this.transport.on('billing.getCachedBalances', () => this.billing.getCachedBalances());

    this.transport.on('billing.createCheckout', async (params, ctx) =>
      this.billing.createCheckout({ ...params, signal: ctx.signal })
    );

    this.transport.on('billing.listPurchases', async (_params, ctx) =>
      this.billing.listPurchases({ signal: ctx.signal })
    );
    this.transport.on('billing.cancelSubscription', async (params, ctx) =>
      this.billing.cancelSubscription({ ...params, signal: ctx.signal })
    );

    this.transport.on('billing.createSupportTicket', async (params) =>
      this.billing.createSupportTicket(params)
    );

    this.transport.on('billing.getIdentity', () => this.billing.getIdentity() ?? null);
    this.transport.on('billing.setIdentity', (params) => {
      this.billing.setIdentity(params.identity ?? undefined);
    });

    // Storage proxy. Any consumer going through `billing.getStorage()` ends up
    // here; the state lives in the offscreen localStorage = single source of truth.
    const storage = this.billing.getStorage();
    this.transport.on('storage.get', async (params) => storage.getItem(params.key));
    this.transport.on('storage.set', async (params) => {
      await storage.setItem(params.key, params.value);
    });
    this.transport.on('storage.remove', async (params) => {
      await storage.removeItem(params.key);
    });

    // Trial-store with an atomic recordBlock via navigator.locks. Each
    // recordBlock call is serialized by the key `trial:<paywallId>` — two tabs
    // can't grab the same snapshot at once and both write a decrement, so
    // there's no drift.
    this.transport.on('trial.check', async (params) =>
      withTrialLock(params.paywallId, () =>
        this.makeTrialStore(params.paywallId, params.config).check()
      )
    );
    this.transport.on('trial.recordBlock', async (params) =>
      withTrialLock(params.paywallId, () =>
        this.makeTrialStore(params.paywallId, params.config).recordBlock()
      )
    );
    this.transport.on('trial.reset', async (params) =>
      withTrialLock(params.paywallId, () =>
        this.makeTrialStore(params.paywallId, params.config).reset()
      )
    );
  }

  /** Each trial handler creates a fresh store — it's stateless and reads state
   *  from storage. There's no point caching instances (storage = SoT). */
  private makeTrialStore(paywallId: string, config: TrialConfig) {
    return createTrialStore(this.billing.getStorage(), paywallId, config);
  }

  private registerAuthHandlers(auth: AuthClient): void {
    this.transport.on('auth.signInWithEmail', async (params) =>
      auth.signInWithEmail(params)
    );
    this.transport.on('auth.signUp', async (params) => auth.signUp(params));
    this.transport.on('auth.signOut', async () => auth.signOut());
    this.transport.on('auth.refresh', async () => auth.refresh());
    this.transport.on('auth.getCachedSession', () => auth.getCachedSession());
    this.transport.on('auth.requestPasswordReset', async (params) =>
      auth.requestPasswordReset(params)
    );
    this.transport.on('auth.updatePassword', async (params) =>
      auth.updatePassword(params)
    );
    this.transport.on('auth.sendOtp', async (params) => auth.sendOtp(params));
    this.transport.on('auth.verifyOtp', async (params) => auth.verifyOtp(params));
    this.transport.on('auth.resendConfirmation', async (params) =>
      auth.resendConfirmation(params)
    );
    this.transport.on('auth.revokeAllSessions', async () => auth.revokeAllSessions());
    this.transport.on('auth.getLastLogin', async () => auth.getLastLogin());

    // OAuth split-API (Phase 4.5). The verifier lives inside AuthClient between
    // these two requests; content only opens the popup and waits for the code.
    // No state in the SDK-extension offscreen-server — it's all in AuthClient
    // itself.
    this.transport.on('auth.oauthStart', async (params) => {
      const { authorize_url, state } = await auth.startOAuthFlow({
        provider: params.provider,
        scopes: params.scopes,
        userMeta: params.userMeta
      });
      return { authorizeUrl: authorize_url, state };
    });
    this.transport.on('auth.oauthExchange', async (params) =>
      auth.completeOAuthFlow({ state: params.state, code: params.code })
    );
    this.transport.on('auth.getAccessToken', async () => auth.getAccessToken());

    this.transport.on('auth.signInAnonymously', async (params) =>
      auth.signInAnonymously({
        captchaToken: params.captchaToken,
        userMeta: params.userMeta,
        forceNewAnon: params.forceNewAnon
      })
    );
  }

  private bridgeBroadcasts(): void {
    this.userUnsub = this.billing.onUserChange(
      (user) => this.transport.broadcast('userChange', user),
      { immediate: 'none' }
    );
    this.balanceUnsub = this.billing.onBalanceChange(
      (balances) => this.transport.broadcast('balancesChange', balances),
      { immediate: 'none' }
    );
    if (this.auth) {
      // We do NOT broadcast INITIAL_SESSION: it's a per-subscriber synthetic
      // event; the content-side RemoteAuthClient emits it itself right after
      // resolving its hydrate promise (via a getCachedSession request).
      // Otherwise one content re-connect would spawn a duplicate INITIAL_SESSION
      // for every listener in it.
      this.authUnsub = this.auth.onAuthChange((event, session) => {
        if (event === 'INITIAL_SESSION') return;
        this.transport.broadcast('authChange', { event, session });
      });
    }
  }

  /** Start the listener on chrome.runtime.onConnect. */
  start(): void {
    if (this.connectListener) return;
    // We accept only the SW relay-port (RELAY_PORT_NAME). chrome.runtime.connect
    // from popup/content/side-panel is delivered to ALL extension contexts with
    // an onConnect listener — including offscreen directly, bypassing the SW. If
    // we accepted PORT_NAME, a single popup.connect() would deliver TWO ports to
    // offscreen (SW relay + direct popup), and one send from the popup would be
    // duplicated: the SW relay posts the msg → handler #1, the direct popup port
    // receives the same msg → handler #2. The SW therefore uses a separate name,
    // RELAY_PORT_NAME, for its own connect to offscreen.
    this.connectListener = (port) => {
      if (port.name !== RELAY_PORT_NAME) return;
      this.transport.accept(portToChannel(port));
    };
    chrome.runtime.onConnect.addListener(this.connectListener);
  }

  stop(): void {
    if (this.connectListener) {
      chrome.runtime.onConnect.removeListener(this.connectListener);
      this.connectListener = null;
    }
    this.userUnsub?.();
    this.balanceUnsub?.();
    this.authUnsub?.();
    this.userUnsub = null;
    this.balanceUnsub = null;
    this.authUnsub = null;
    this.tracker?.destroy();
  }
}

/** Serializes trial operations by key — atomic read-modify-write inside
 *  offscreen. navigator.locks is available in the offscreen context (Chrome
 *  69+); for browsers without it — fallback to a direct call (a race is
 *  possible, but that's a deep legacy case). */
async function withTrialLock<T>(paywallId: string, fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(`@monetize.software/sdk-extension:trial:${paywallId}`, fn);
  }
  return fn();
}

function createTrackerIfEnabled(
  opts: OffscreenServerOptions,
  billing: BillingClient
): EventTracker | undefined {
  if (opts.analytics === false) return undefined;
  const cfg = typeof opts.analytics === 'object' && opts.analytics !== null ? opts.analytics : {};
  const endpoint =
    cfg.endpoint ?? `${billing.apiOrigin}/api/v1/paywall/${billing.paywallId}/events`;
  return new EventTracker({
    endpoint,
    paywallId: billing.paywallId,
    capabilities: billing.capabilities,
    getVisitorId: () => billing.getVisitorId(),
    getCachedVisitorId: () => billing.getCachedVisitorId(),
    getUserId: () => billing.getIdentity()?.userId ?? null,
    flushIntervalMs: cfg.flushIntervalMs,
    maxBufferSize: cfg.maxBufferSize
  });
}
