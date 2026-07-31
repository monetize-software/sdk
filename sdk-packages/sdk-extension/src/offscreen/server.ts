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
import { PaywallError } from '@sdk/core/types';
import {
  AuthClient,
  type AuthSession,
  type OAuthResumeCheckout
} from '@sdk/core/auth';
import { EventTracker } from '@sdk/core/EventTracker';
import { createTrialStore } from '@sdk/core/trial';
import { STORAGE_KEYS } from '@sdk/core/storage';
import type { TrialConfig } from '@sdk/core/types';
import type { OffscreenServerOptions } from './index';
import { TransportServer } from '../shared/transport-server';
import { portToChannel } from '../shared/chrome-port';
import { RELAY_PORT_NAME } from '../shared/port-name';
import { base64ToBytes } from '../shared/base64';
import { MAX_SUPPORT_FILES, MAX_SUPPORT_FILE_SIZE } from '../shared/support-limits';

// Staged support attachments awaiting their createSupportTicket. Sweep window:
// generous enough for a slow sequential upload of 5 files, short enough that
// an abandoned form (staged files, tab closed before submit) doesn't pin
// megabytes in the offscreen heap for long.
const STAGED_FILE_TTL_MS = 10 * 60 * 1000;
// Heap cap across ALL tabs (one offscreen per extension): 2 full tickets' worth.
const STAGED_FILES_MAX_COUNT = MAX_SUPPORT_FILES * 2;

type StagedFile = { name: string; type: string; bytes: Uint8Array; stagedAt: number };

// How long a state handed out by oauthStart stays adoptable. Matches
// OAUTH_FLOW_TTL_MS in @sdk/core/auth — past it the verifier is gone anyway.
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
// How long a settled exchange is remembered after success. Covers the race where
// the SW adopts the code first and the still-alive popup asks for the same state
// a moment later: it gets the session instead of `oauth_invalid_state`. The code
// is single-use at GoTrue, so replaying it is not an option.
const OAUTH_EXCHANGE_MEMO_MS = 60 * 1000;

export class OffscreenServer {
  readonly billing: BillingClient;
  readonly auth: AuthClient | undefined;
  readonly tracker: EventTracker | undefined;
  private readonly transport = new TransportServer();
  private readonly stagedFiles = new Map<string, StagedFile>();
  private connectListener: ((port: chrome.runtime.Port) => void) | null = null;
  private userUnsub: (() => void) | null = null;
  private balanceUnsub: (() => void) | null = null;
  private authUnsub: (() => void) | null = null;
  /** States handed out by auth.oauthStart, oldest first. The adopt path (service
   *  worker) learns only the code — the state rides in `window.name`, which a
   *  worker cannot read — so we resolve the flow from here. */
  private pendingOAuthStates: Array<{
    state: string;
    at: number;
    resumeCheckout?: OAuthResumeCheckout;
  }> = [];
  /** Exchanges keyed by state, in-flight and briefly after settling. Both entry
   *  points funnel through it so one auth code is never sent to GoTrue twice. */
  private oauthExchanges = new Map<string, Promise<AuthSession>>();

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

  /** Drop staged support attachments older than the TTL. Called on every
   *  stage request — no timer needed, the map is only ever populated by the
   *  same request path. */
  private sweepStagedFiles(): void {
    const cutoff = Date.now() - STAGED_FILE_TTL_MS;
    for (const [id, f] of this.stagedFiles) {
      if (f.stagedAt < cutoff) this.stagedFiles.delete(id);
    }
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
    this.transport.on('billing.getSettledUser', async (_params, ctx) =>
      this.billing.getSettledUser({ signal: ctx.signal })
    );

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
    this.transport.on('billing.getCustomerPortalUrl', async (params, ctx) =>
      this.billing.getCustomerPortalUrl({ returnUrl: params.returnUrl, signal: ctx.signal })
    );

    // Attachments arrive as base64 (Files don't survive the JSON-serialized
    // runtime ports — see shared/messages.ts). Stage each file, then the
    // ticket request references the staged ids and we rebuild real Files here.
    this.transport.on('billing.stageSupportFile', (params) => {
      this.sweepStagedFiles();
      const bytes = base64ToBytes(params.dataBase64);
      if (bytes.length > MAX_SUPPORT_FILE_SIZE) {
        throw new PaywallError('invalid_file', 'Attachment too large', { status: 400 });
      }
      if (this.stagedFiles.size >= STAGED_FILES_MAX_COUNT) {
        throw new PaywallError('too_many_files', 'Too many staged attachments', {
          status: 429
        });
      }
      const fileId = crypto.randomUUID();
      this.stagedFiles.set(fileId, {
        name: params.name,
        type: params.type,
        bytes,
        stagedAt: Date.now()
      });
      return { fileId };
    });

    this.transport.on('billing.createSupportTicket', async (params) => {
      const { fileIds, ...ticket } = params;
      // Consume the staged entries up front: whether the backend call succeeds
      // or fails, a retry re-stages from the content side — nothing may linger.
      const files: File[] = [];
      for (const id of fileIds ?? []) {
        const staged = this.stagedFiles.get(id);
        this.stagedFiles.delete(id);
        // A missing id means the stage was swept (TTL) or never happened —
        // failing loudly beats silently recreating the "ticket without the
        // screenshot" bug this flow exists to fix.
        if (!staged) {
          throw new PaywallError('invalid_file', 'Attachment expired, re-send the ticket', {
            status: 400
          });
        }
        files.push(new File([staged.bytes as BlobPart], staged.name, { type: staged.type }));
      }
      return this.billing.createSupportTicket({
        ...ticket,
        files: files.length > 0 ? files : undefined
      });
    });

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
        userMeta: params.userMeta,
        switchAccount: params.switchAccount
      });
      this.rememberOAuthState(state, params.resumeCheckout);
      return { authorizeUrl: authorize_url, state };
    });
    this.transport.on('auth.oauthExchange', async (params) =>
      this.exchangeOAuthOnce(auth, params.state, params.code)
    );
    // Adopt: the surface that started the flow is gone (a toolbar action popup
    // is destroyed the moment the provider window takes focus, which on some
    // window managers happens every time), so nobody is left to hand us the
    // code. The SW read it off the callback URL instead. We own the verifier, so
    // we can finish alone — and the resulting authChange broadcast reaches every
    // surface that is still alive, plus the next one to open.
    this.transport.on('auth.oauthAdopt', async (params) => {
      const pending = this.newestPendingOAuthFlow();
      if (!pending) return { adopted: false, reason: 'no_pending_flow' };
      try {
        await this.exchangeOAuthOnce(auth, pending.state, params.code);
      } catch (e) {
        const code = e instanceof PaywallError ? e.code : 'exchange_failed';
        return { adopted: false, reason: code };
      }
      this.forgetOAuthState(pending.state);
      // Signed in. If a purchase was waiting behind this gate, create it now so
      // the worker can send the provider tab straight to payment — otherwise the
      // user has to reopen the extension and click buy a second time, which is
      // the whole reason this path exists.
      const checkoutUrl = pending.resumeCheckout
        ? await this.createResumeCheckout(pending.resumeCheckout)
        : undefined;
      return checkoutUrl ? { adopted: true, checkoutUrl } : { adopted: true };
    });
    this.transport.on('auth.getAccessToken', async () => auth.getAccessToken());

    this.transport.on('auth.signInAnonymously', async (params) =>
      auth.signInAnonymously({
        captchaToken: params.captchaToken,
        userMeta: params.userMeta,
        forceNewAnon: params.forceNewAnon
      })
    );
  }

  private rememberOAuthState(state: string, resumeCheckout?: OAuthResumeCheckout): void {
    const cutoff = Date.now() - OAUTH_STATE_TTL_MS;
    this.pendingOAuthStates = this.pendingOAuthStates.filter((f) => f.at >= cutoff);
    this.pendingOAuthStates.push({ state, at: Date.now(), resumeCheckout });
  }

  /**
   * Creates the checkout a finished sign-in was gating. Returns the URL, or
   * undefined when there is nothing to open — including the 409 for a user who
   * already owns the subscription, where sending them to pay again would be
   * worse than sending them nowhere (they reopen the extension and the settled
   * -user gate shows the restored state).
   *
   * Mirrors what PaywallUI does around a checkout, because the surface that
   * normally would is gone: the pending marker keeps the next open from flashing
   * the paywall at a user who is mid-payment, and the analytics event keeps the
   * funnel honest.
   */
  private async createResumeCheckout(
    intent: OAuthResumeCheckout
  ): Promise<string | undefined> {
    try {
      const result = await this.billing.createCheckout({
        priceId: intent.priceId,
        offerId: intent.offerId,
        ignoreActivePurchase: intent.renew === true
      });
      if (!result.url) return undefined;

      this.tracker?.track('checkout_started', {
        price_id: intent.priceId,
        acquiring: result.acquiring
      });
      try {
        await Promise.resolve(
          this.billing
            .getStorage()
            .setItem(
              STORAGE_KEYS.checkoutPending(this.billing.paywallId),
              JSON.stringify({ at: Date.now() })
            )
        );
      } catch {
        /* quota / disabled storage — costs a one-time paywall flash, not the sale */
      }
      return result.url;
    } catch {
      // already_purchased, a dead price, the network — the sign-in itself stands,
      // so we still report adopted and simply close the tab.
      return undefined;
    }
  }

  /** The most recently started flow, which is the one a returning code belongs
   *  to. Concurrent OAuth flows in one extension are not a real scenario — each
   *  needs its own provider window — so newest-wins is enough, and a wrong guess
   *  costs only a failed exchange, never a wrong session (the code is bound to
   *  the challenge sent with that state). */
  private newestPendingOAuthFlow(): {
    state: string;
    resumeCheckout?: OAuthResumeCheckout;
  } | null {
    const cutoff = Date.now() - OAUTH_STATE_TTL_MS;
    for (let i = this.pendingOAuthStates.length - 1; i >= 0; i--) {
      if (this.pendingOAuthStates[i].at >= cutoff) return this.pendingOAuthStates[i];
    }
    return null;
  }

  private forgetOAuthState(state: string): void {
    this.pendingOAuthStates = this.pendingOAuthStates.filter((f) => f.state !== state);
  }

  private exchangeOAuthOnce(
    auth: AuthClient,
    state: string,
    code: string
  ): Promise<AuthSession> {
    const inflight = this.oauthExchanges.get(state);
    if (inflight) return inflight;

    const promise = auth.completeOAuthFlow({ state, code });
    this.oauthExchanges.set(state, promise);
    promise.then(
      () => {
        setTimeout(() => this.oauthExchanges.delete(state), OAUTH_EXCHANGE_MEMO_MS);
      },
      () => {
        // Failures are forgotten immediately — a retry with a fresh code must
        // not be answered from the memo.
        this.oauthExchanges.delete(state);
      }
    );
    return promise;
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

  /** Accept a raw MessageChannel, bypassing chrome.runtime. Unit tests wire an
   *  in-memory channel here to exercise the real handler graph; prod traffic
   *  always arrives through start() → onConnect. */
  acceptChannel(channel: Parameters<TransportServer['accept']>[0]): void {
    this.transport.accept(channel);
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
  // A thunk, not a string: after an edge failover (sdk core/edge.ts) events
  // must follow the origin that is actually reachable, resolved at flush time.
  const endpoint =
    cfg.endpoint ??
    (() => `${billing.activeApiOrigin()}/api/v1/paywall/${billing.paywallId}/events`);
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
