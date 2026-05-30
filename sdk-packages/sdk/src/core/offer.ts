import type { PaywallOffer } from './types';

/**
 * Resolved view of a paywall offer — what host UI actually needs to render
 * a strike-through price + countdown without re-implementing the math.
 *
 * `remainingMs` ticks down with wall-clock time and reaches 0 on expiry.
 * `totalMs` stays constant — useful for progress bars / share-of-time UX.
 * `expiresAt` is the Date.now()-comparable epoch ms of expiry.
 *
 * For offers without an expiry mechanism (no `expires_at` and no
 * `duration_minutes`), `remainingMs`/`totalMs`/`expiresAt` are all `null`,
 * but the resolved view is still returned — discount badge / strike-through
 * still make sense for "perpetual sale" offers.
 */
export interface ResolvedOffer {
  offer: PaywallOffer;
  discountPercent: number;
  remainingMs: number | null;
  totalMs: number | null;
  expiresAt: number | null;
}

/** Storage key under which a relative `duration_minutes` offer records its
 *  first-view timestamp. Shared between the renderer (which writes the
 *  start on first open) and the host SDK helpers (which read it). */
export function offerStartStorageKey(offerId: string): string {
  return `pw-offer-${offerId}-start`;
}

/** Pick the offer applicable to a price. Targeted (`price_id === id`) wins
 *  over the global default (`price_id === null`). Offers without a positive
 *  `discount_percent` are ignored. */
export function findApplicableOffer(
  offers: PaywallOffer[] | null | undefined,
  priceId: string
): PaywallOffer | null {
  if (!offers || offers.length === 0) return null;
  const targeted = offers.find(
    (o) => o.price_id === priceId && (o.discount_percent ?? 0) > 0
  );
  if (targeted) return targeted;
  const global = offers.find(
    (o) => o.price_id == null && (o.discount_percent ?? 0) > 0
  );
  return global ?? null;
}

/**
 * Как `findApplicableOffer`, но возвращает оффер только пока он **жив** (не
 * истёк). `findApplicableOffer` сам по себе фильтрует лишь по `price_id` +
 * `discount_percent > 0` и срок не смотрит — поэтому strike-through/`-X%` в
 * `PriceGrid` внутри модалки переживал expiry, хотя countdown-баннер уже
 * скрывался (рассинхрон внутри модалки + расхождение с хост-прайсингом,
 * который резолвит через `resolveOffer`). Эта обёртка прогоняет найденный
 * оффер через `resolveOffer` и режет просроченное.
 *
 * Для duration_minutes-оффера без записанного старта (marker ещё не
 * проставлен) `resolveOffer` отдаёт оффер как perpetual — скидка
 * показывается, как и раньше; режется ровно истёкшее.
 */
export function findLiveOffer(
  offers: PaywallOffer[] | null | undefined,
  priceId: string,
  opts: ResolveOfferOptions = {}
): PaywallOffer | null {
  const offer = findApplicableOffer(offers, priceId);
  if (!offer) return null;
  return resolveOffer(offer, opts) ? offer : null;
}

export interface ResolveOfferOptions {
  /** Current epoch ms. Inject for deterministic tests; default `Date.now()`. */
  now?: number;
  /**
   * Synchronous reader for the `duration_minutes` start-timestamp ISO string.
   * Host passes a closure over its sync storage (browser → `localStorage`,
   * memory → in-process map). Return `null` if no start has been recorded.
   *
   * Intentionally synchronous, because consumers call this from UI render —
   * an async StorageAdapter would force every price card to suspend.
   *
   * If omitted, `duration_minutes`-only offers return `expiresAt = null`,
   * which makes the resolved view treat them as "not yet started" (the
   * renderer is responsible for writing the start on first paywall view).
   */
  readStart?: (offerId: string) => string | null;
}

/** Compute the resolved view of an offer. Pure, no side-effects. */
export function resolveOffer(
  offer: PaywallOffer,
  opts: ResolveOfferOptions = {}
): ResolvedOffer | null {
  const discountPercent = offer.discount_percent ?? 0;
  if (discountPercent <= 0) return null;

  const now = opts.now ?? Date.now();
  const expiresAt = resolveExpiresAt(offer, opts.readStart);
  const totalMs = resolveTotalMs(offer, expiresAt);
  const remainingMs = expiresAt !== null ? Math.max(0, expiresAt - now) : null;

  // Expired — caller treats null as "do not show". `remainingMs` reaching 0
  // happens one tick before this branch fires; the host UI is expected to
  // re-render on the next tick and see null here.
  if (expiresAt !== null && expiresAt <= now) return null;

  return { offer, discountPercent, remainingMs, totalMs, expiresAt };
}

function resolveExpiresAt(
  offer: PaywallOffer,
  readStart: ((id: string) => string | null) | undefined
): number | null {
  if (offer.expires_at) {
    const t = Date.parse(offer.expires_at);
    return Number.isFinite(t) ? t : null;
  }
  if (offer.duration_minutes && offer.duration_minutes > 0 && readStart) {
    const startIso = readStart(offer.id);
    if (!startIso) return null; // not yet activated for this user
    const start = Date.parse(startIso);
    if (!Number.isFinite(start)) return null;
    return start + offer.duration_minutes * 60_000;
  }
  return null;
}

function resolveTotalMs(offer: PaywallOffer, expiresAt: number | null): number | null {
  if (offer.duration_minutes && offer.duration_minutes > 0) {
    return offer.duration_minutes * 60_000;
  }
  // expires_at-only: total = expires_at - "now of activation", which we don't
  // know. Approximation: use full window from epoch is meaningless, so just
  // mirror remaining (callers that want progress on `expires_at` offers can
  // capture the value on first render).
  if (expiresAt !== null) {
    return expiresAt - Date.now();
  }
  return null;
}

/** Safe browser localStorage getter — returns null in SSR / private mode. */
export function readBrowserOfferStart(offerId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(offerStartStorageKey(offerId));
  } catch {
    return null;
  }
}
