// Drop-in `PaywallUI` для extension'а. Public API идентичен `@monetize.software/sdk`'у —
// host пишет тот же код, опции те же. Под капотом:
//  - billing — RemoteBillingClient (proxy в offscreen)
//  - auth — RemoteAuthClient (когда `auth: true`)
//  - tracker — RemoteEventTracker (события forward'ятся в offscreen-EventTracker)
//
// EventTracker создаётся ОДИН на расширение, в offscreen'е. PaywallUI здесь
// внутренний tracker отключает (`analytics: false` в base-конструкторе) и
// сам подписывается на public-события, проксируя их через RemoteEventTracker.
// Дубликат биндингов из base PaywallUI.initTracker — но это меньшее зло, чем
// два EventTracker'а на одного юзера.

import { PaywallUI as BasePaywallUI, type PaywallUIOptions } from '@sdk/ui/PaywallUI';
import type { BillingClient } from '@sdk/core/BillingClient';
import type { AuthClient } from '@sdk/core/auth';
import { RemoteBillingClient } from './RemoteBillingClient';
import { RemoteAuthClient } from './RemoteAuthClient';
import { RemoteEventTracker } from './RemoteEventTracker';
import { getContentTransport } from './transport';

/** Опции extension'овского PaywallUI. Убраны:
 *  - `client` — RemoteBillingClient создаётся автоматически
 *  - `storage` — storage живёт в offscreen'е, content его не видит
 *  - `apiKey` — server-SDK key, не имеет смысла в content-script'е
 *  - `fetch` — все сетевые запросы идут через offscreen
 *
 *  `auth: true` подключит RemoteAuthClient. Передавать готовый AuthClient
 *  из @monetize.software/sdk сюда не имеет смысла (мы хотим именно offscreen'овский). */
export interface ExtensionPaywallUIOptions
  extends Omit<PaywallUIOptions, 'client' | 'storage' | 'apiKey' | 'fetch'> {}

export class PaywallUI extends BasePaywallUI {
  /** RemoteEventTracker (proxy в offscreen-EventTracker). Не путать с
   *  base-классовым `tracker` (там null — мы отключили внутренний). */
  private remoteTracker: RemoteEventTracker | null = null;
  private trackerUnsubs: Array<() => void> = [];

  constructor(opts: ExtensionPaywallUIOptions) {
    const transport = getContentTransport();

    const billing = new RemoteBillingClient(transport, {
      paywallId: opts.paywallId,
      apiOrigin: opts.apiOrigin
    });

    // Auth: если host попросил — конструируем RemoteAuthClient. Готовый
    // AuthClient из @monetize.software/sdk сюда не имеет смысла прокидывать (всё
    // равно нужен offscreen-instance). Поэтому accept только `true` или
    // ничего; явный AuthClient instance логирует warning и игнорится.
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

    // Прокидываем auth внутрь billing-клиента: PaywallRoot читает
    // `client.auth` для restore / preauth-flow / signin-detection. Настоящий
    // BillingClient выставляет это поле в конструкторе — у Remote-варианта
    // делаем явное присваивание перед super(), чтобы PaywallRoot увидел.
    if (auth) {
      (billing as { auth?: typeof auth }).auth = auth;
    }

    super({
      ...opts,
      // Cast'ы безопасны: PaywallUI'ев resolveAuth duck-type'ит auth (см.
      // sdk/src/ui/PaywallUI.ts isAuthClientLike), а billing-параметр идёт
      // через `opts.client ?? new BillingClient(...)` — RemoteBillingClient
      // там используется как есть, методы все сходятся.
      client: billing as unknown as BillingClient,
      auth: auth as unknown as AuthClient | undefined,
      // Внутренний EventTracker отключаем — единственный tracker живёт в
      // offscreen'е. Манчиально подписываемся ниже.
      analytics: false
    });

    if (opts.analytics !== false) {
      this.remoteTracker = new RemoteEventTracker(transport);
      this.bindAnalytics();
    }
  }

  /** Зеркало sdk/PaywallUI.initTracker'овских биндингов, но с RemoteEventTracker.
   *  Когда @monetize.software/sdk экспоузнет публичный hook для inject'а tracker'а,
   *  этот метод заменится на одну строку. */
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

    // auth_signin_success / auth_signout пока не фаерим: authChange эмитится
    // и на гидрации сессии (popup поднимает кеш из offscreen), и на token
    // refresh, и при параллельном content-script + popup — даёт ложные
    // signin'ы. Реальные login-события нужно ловить через прямые вызовы
    // signInWithEmail/signUp/signInWithOAuth/signOut, а не через authChange.
  }

  /** Прокси через RemoteEventTracker. Hosts могут вызывать paywall.track
   *  для произвольных аналитических событий — летит в единственный
   *  offscreen-tracker наряду с auto-emit'ами PaywallUI. */
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
