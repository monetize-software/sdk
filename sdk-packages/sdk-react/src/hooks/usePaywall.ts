import { useContext } from 'react';
import type { PaywallUI } from '@monetize.software/sdk';
import { PaywallContext, PaywallProviderMarker } from '../context';

/**
 * Достаёт PaywallUI-инстанс из ближайшего {@link PaywallProvider}.
 *
 * Бросает ошибку, если вызван вне Provider'а — это явный программный баг,
 * не runtime-флоу. На SSR / до useEffect Provider'а возвращает `null`
 * (Provider есть, но инстанс ещё не смонтирован).
 *
 * Подавляющему большинству пейволов от хоста нужны `paywall.open()`,
 * `paywall.openSupport()`, подписки на события — для всего этого
 * usePaywall() самый прямой путь:
 *
 * ```tsx
 * const paywall = usePaywall();
 * <button onClick={() => paywall?.open()}>Upgrade</button>
 * ```
 *
 * Для типичных кейсов (gating, state-driven UI) обычно удобнее
 * специализированные хуки: {@link usePaywallState}, {@link usePaywallAccess},
 * {@link usePaywallUser}.
 */
export function usePaywall(): PaywallUI | null {
  const hasProvider = useContext(PaywallProviderMarker);
  const paywall = useContext(PaywallContext);

  if (!hasProvider) {
    throw new Error(
      '[sdk-react] usePaywall() called outside <PaywallProvider>. ' +
        'Wrap your tree with <PaywallProvider options={...}> or pass an ' +
        'externally-created instance via <PaywallProvider instance={paywall}>.'
    );
  }

  return paywall;
}
