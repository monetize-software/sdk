// Offscreen-side server. Owns the real BillingClient + AuthClient (если
// включён) — единственный source of truth для всего расширения. Регистрирует
// handler'ы на TransportServer'е, принимает port'ы от SW через
// chrome.runtime.onConnect, broadcast'ит userChange/authChange/balancesChange
// при изменении состояния.
//
// Жизненный цикл: server создаётся один раз через startOffscreenServer().
// Если SW рестартует — он пере-create'ит offscreen (если документ умер) или
// откроет новый port (если документ жив). Server в обоих случаях accept'ит
// новый канал, state переживает.
//
// OAuth flows. PKCE verifier хранится в offscreen'е между oauthStart и
// oauthExchange request'ами. Content только открывает popup и ждёт code'а
// (нативно, в своём frame'е) — verifier через runtime-границу не уходит.

import { BillingClient } from '@sdk/core/BillingClient';
import { AuthClient } from '@sdk/core/auth';
import { EventTracker } from '@sdk/core/EventTracker';
import { createTrialStore } from '@sdk/core/trial';
import type { TrialConfig } from '@sdk/core/types';
import type { OffscreenServerOptions } from './index';
import { TransportServer } from '../shared/transport-server';
import { portToChannel } from '../shared/chrome-port';
import { PORT_NAME } from '../shared/port-name';

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
    // ctx.signal пробрасывается в underlying fetch — отмена с content-стороны
    // (юзер закрыл модалку) реально кенселит сетевой запрос в offscreen'е,
    // не оставляя «зомби-fetch» висеть до timeout'а.
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

    this.transport.on('billing.getIdentity', () => this.billing.getIdentity() ?? null);
    this.transport.on('billing.setIdentity', (params) => {
      this.billing.setIdentity(params.identity ?? undefined);
    });

    // Storage proxy. Любой consumer через `billing.getStorage()` ходит сюда;
    // state живёт в offscreen'овском localStorage = single source of truth.
    const storage = this.billing.getStorage();
    this.transport.on('storage.get', async (params) => storage.getItem(params.key));
    this.transport.on('storage.set', async (params) => {
      await storage.setItem(params.key, params.value);
    });
    this.transport.on('storage.remove', async (params) => {
      await storage.removeItem(params.key);
    });

    // Trial-store с атомарным recordBlock через navigator.locks. Каждый
    // вызов recordBlock сериализуется по ключу `trial:<paywallId>` —
    // две вкладки одновременно не могут получить одинаковый snapshot и
    // оба записать decrement, drift'а нет.
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

  /** Каждый trial-handler создаёт свежий store — он stateless, читает
   *  state из storage. Кешировать инстансы смысла нет (storage = SoT). */
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

    // OAuth split-API (Phase 4.5). Verifier живёт внутри AuthClient'а
    // между двумя этими request'ами, content только открывает popup и
    // ждёт code'а. Никакого state в SDK-extension'овском offscreen-server —
    // всё в самом AuthClient'е.
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
        forceCaptcha: params.forceCaptcha
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
      // INITIAL_SESSION НЕ broadcast'им: это per-subscriber synthetic event,
      // RemoteAuthClient на content-side выдаёт его сам сразу после resolve
      // своего hydrate-promise'а (через getCachedSession-запрос). Иначе один
      // ре-connect content'а породит дубль INITIAL_SESSION'а на каждого
      // listener'а в нём.
      this.authUnsub = this.auth.onAuthChange((event, session) => {
        if (event === 'INITIAL_SESSION') return;
        this.transport.broadcast('authChange', { event, session });
      });
    }
  }

  /** Старт listener'а на chrome.runtime.onConnect. */
  start(): void {
    if (this.connectListener) return;
    this.connectListener = (port) => {
      if (port.name !== PORT_NAME) return;
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

/** Сериализует операции trial по ключу — atomically read-modify-write
 *  внутри offscreen. navigator.locks доступен в offscreen-контексте (Chrome
 *  69+), для browsers без него — fallback на прямой call (race возможна,
 *  но это совсем legacy-кейс). */
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
