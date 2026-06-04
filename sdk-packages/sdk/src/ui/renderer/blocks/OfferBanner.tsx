import { useEffect, useRef, useState } from 'preact/hooks';
import type { LayoutBlock, PaywallOffer } from '../../../core/types';
import type { BlockProps } from '../types';
import { useI18n, type TFn } from '../../i18n';

type OfferBannerBlock = Extract<LayoutBlock, { type: 'offer_banner' }>;

// Start storage for relative timers (offer.duration_minutes). The key is
// tied to offer.id — reopening the paywall does not reset the countdown,
// and the user cannot "farm" the offer banner forever. The key stays in storage
// even after expiry — it is a forever-marker "the offer has already started for the user";
// without it, reopening after expiry would write a fresh `start` again
// and the countdown would restart from zero.
const STORAGE_KEY = (offerId: string): string => `pw-offer-${offerId}-start`;

export interface TimeLeft {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  expired: boolean;
}

function calcTimeLeft(endMs: number): TimeLeft {
  const distance = endMs - Date.now();
  if (distance <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, expired: true };
  }
  return {
    days: Math.floor(distance / (1000 * 60 * 60 * 24)),
    hours: Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
    minutes: Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60)),
    seconds: Math.floor((distance % (1000 * 60)) / 1000),
    expired: false
  };
}

// Resolves endMs: expires_at (absolute server date) takes priority, otherwise
// duration_minutes from the first paywall open, stored in localStorage.
// null — an offer without a timer, no banner needed.
function resolveEndMs(offer: PaywallOffer): number | null {
  if (offer.expires_at) {
    const t = Date.parse(offer.expires_at);
    return Number.isFinite(t) ? t : null;
  }
  if (offer.duration_minutes && offer.duration_minutes > 0) {
    if (typeof window === 'undefined') return null;
    try {
      const key = STORAGE_KEY(offer.id);
      let startIso = window.localStorage.getItem(key);
      if (!startIso) {
        startIso = new Date().toISOString();
        window.localStorage.setItem(key, startIso);
      }
      return Date.parse(startIso) + offer.duration_minutes * 60_000;
    } catch {
      // Storage unavailable (private mode / SSR) — a relative timer is useless.
      return null;
    }
  }
  return null;
}

export function pickActiveOffer(
  offers: PaywallOffer[] | undefined,
  preferredId?: string
): PaywallOffer | null {
  if (!offers || offers.length === 0) return null;
  if (preferredId) {
    const match = offers.find((o) => o.id === preferredId);
    if (match) return match;
  }
  // The first offer with an active timer. Without a timer the banner makes no sense
  // (an offer-without-urgency is shown via the PriceGrid discount badge).
  return offers.find((o) => o.expires_at || o.duration_minutes) ?? null;
}

/** Hook: ticks every second until the offer is expired. Returns null if the
 *  offer is invalid (no timer). Used both in the layout-block OfferBanner
 *  and in the top-tab OfferTopBanner from PaywallRoot. */
export function useOfferCountdown(offer: PaywallOffer | null): TimeLeft | null {
  const endMs = offer ? resolveEndMs(offer) : null;
  const [timeLeft, setTimeLeft] = useState<TimeLeft | null>(() =>
    endMs !== null ? calcTimeLeft(endMs) : null
  );
  const endMsRef = useRef(endMs);
  endMsRef.current = endMs;

  useEffect(() => {
    if (endMs === null) {
      setTimeLeft(null);
      return undefined;
    }
    setTimeLeft(calcTimeLeft(endMs));
    const timer = setInterval(() => {
      const next = calcTimeLeft(endMsRef.current ?? 0);
      setTimeLeft(next);
      // Do NOT delete `pw-offer-<id>-start` on expiry — the key is needed as a
      // forever-marker "the offer has already started"; otherwise re-opening the paywall after
      // expiry would write a fresh start and the countdown would restart from zero
      // (offer-farming bug). It is enough to stop the tick.
      if (next.expired) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [endMs, offer?.duration_minutes, offer?.id]);

  return timeLeft;
}

export function OfferBanner({ block, ctx }: BlockProps<OfferBannerBlock>) {
  const { t } = useI18n();
  const offer = pickActiveOffer(ctx.bootstrap.offers, block.offer_id);
  const timeLeft = useOfferCountdown(offer);

  if (!offer || timeLeft === null) return null;
  if (timeLeft.expired && !block.force) return null;

  const title = block.title ?? offer.label ?? t('offer.limited_time', 'Limited-time offer');
  const titleWithDiscount = offer.discount_percent
    ? `${title} ${offer.discount_percent}%`
    : title;

  return (
    <div
      class="flex flex-wrap items-center justify-center gap-2 rounded-2xl px-4 py-3 text-[15px] font-semibold leading-tight text-white"
      style={{
        background:
          'linear-gradient(135deg, color-mix(in srgb, var(--pw-accent) 55%, white) 0%, var(--pw-accent) 50%, color-mix(in srgb, var(--pw-accent) 85%, black) 100%)',
        textShadow: '0 0 2px rgba(0, 0, 0, 0.25)'
      }}
      role="status"
    >
      <FlashIcon />
      <span>{titleWithDiscount}</span>
      <Countdown value={timeLeft} t={t} />
    </div>
  );
}

export function Countdown({ value, t }: { value: TimeLeft; t: TFn }) {
  return (
    <div class="flex items-center gap-1 font-mono text-sm">
      {value.days > 0 ? (
        <>
          <Cell>{String(value.days)}</Cell>
          <span class="text-xs">{t('countdown.d', 'd')}</span>
        </>
      ) : null}
      <Cell>{String(value.hours).padStart(2, '0')}</Cell>
      <span class="text-xs">{t('countdown.h', 'h')}</span>
      <Cell>{String(value.minutes).padStart(2, '0')}</Cell>
      <span class="text-xs">{t('countdown.m', 'm')}</span>
      <Cell>{String(value.seconds).padStart(2, '0')}</Cell>
      <span class="text-xs">{t('countdown.s', 's')}</span>
    </div>
  );
}

function Cell({ children }: { children: preact.ComponentChildren }) {
  return (
    <span class="rounded bg-black/20 px-1.5 py-0.5 text-xs font-bold">
      {children}
    </span>
  );
}

/** Top-tab variant: sticks to the top of the Modal as a little tab label
 *  (rounded-top, negative margin-bottom for overlap). Mirrors the legacy
 *  PaywallModal:`offer-banner-enter -mb-2 pb-5 rounded-tl-xl rounded-tr-xl`. */
export function OfferTopBanner({ offer }: { offer: PaywallOffer }) {
  const { t } = useI18n();
  const timeLeft = useOfferCountdown(offer);
  if (timeLeft === null || timeLeft.expired) return null;
  const title = offer.label ?? t('offer.limited_time', 'Limited-time offer');
  const titleWithDiscount = offer.discount_percent
    ? `${title} ${offer.discount_percent}%`
    : title;
  return (
    <div
      class="-mb-2 flex flex-wrap items-center justify-center gap-2 rounded-t-xl px-4 pb-5 pt-3 text-[15px] font-semibold leading-tight text-white"
      style={{
        background:
          'linear-gradient(135deg, color-mix(in srgb, var(--pw-accent) 55%, white) 0%, var(--pw-accent) 50%, color-mix(in srgb, var(--pw-accent) 85%, black) 100%)',
        textShadow: '0 0 2px rgba(0, 0, 0, 0.25)'
      }}
      role="status"
    >
      <FlashIcon />
      <span>{titleWithDiscount}</span>
      <Countdown value={timeLeft} t={t} />
    </div>
  );
}

function FlashIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="m9.44 5.359-2.394-.895.61-3.036c.062-.31-.345-.531-.57-.291L2.434 6.105a.336.336 0 0 0 .126.537l2.395.894-.61 3.037c-.062.31.345.53.57.29l4.653-4.968a.336.336 0 0 0-.126-.536Z"
      />
    </svg>
  );
}
