import { useEffect, useState } from 'react';
import type { PaywallPrice } from '@monetize.software/sdk';
import { usePaywall } from './usePaywall';

/**
 * `prices` — кешированный snapshot bootstrap.prices (`null` до первого fetch'а
 * или когда инстанс ещё не готов).
 * `loading` — true пока первый запрос в полёте, после первого ответа всегда false.
 * `error` — последняя ошибка fetch'а (`null` если успешный или ещё не падал).
 *
 * Намеренно нет дискриминирующего поля типа `status: 'loading'|'ready'|'error'`
 * как в `usePaywallAccess`, потому что для прайсингов хосту обычно нужны три
 * независимые величины одновременно (показать предыдущий список + skeleton +
 * сообщение об ошибке поверх) — discriminated union тут только усложняет.
 */
export interface PaywallPricesState {
  prices: PaywallPrice[] | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Загружает и подписывается на цены пейвола. Подходит для отдельной
 * прайсинг-страницы / pricing-карточек, где host хочет показать те же цены,
 * что и в модалке, без открытия paywall'а.
 *
 * Реализация:
 *  - initial sync read через `getCachedPrices()` (если bootstrap уже в кеше
 *    BillingClient'а — например, после `paywall.preload()` или предыдущего
 *    open'а — цены доступны мгновенно);
 *  - `useEffect` дёргает `getPrices()` для гарантированной загрузки;
 *  - subscription на `ready` event — рефетч bootstrap'а на новом open()
 *    может принести обновлённые цены, мы обновляем snapshot.
 *
 * ```tsx
 * const { prices, loading } = usePaywallPrices();
 * if (loading && !prices) return <Skeleton />;
 * return prices?.map((p) => <PriceCard key={p.id} price={p} />);
 * ```
 */
export function usePaywallPrices(): PaywallPricesState {
  const paywall = usePaywall();
  const [state, setState] = useState<PaywallPricesState>(() => ({
    prices: paywall?.getCachedPrices() ?? null,
    loading: true,
    error: null
  }));

  useEffect(() => {
    if (!paywall) {
      setState({ prices: null, loading: true, error: null });
      return;
    }

    // Sync-доступ через cached snapshot — если bootstrap уже загружен,
    // показываем цены немедленно (без флеша «loading → ready»).
    const cached = paywall.getCachedPrices();
    setState({ prices: cached, loading: cached === null, error: null });

    const ctrl = new AbortController();
    let cancelled = false;

    const refresh = () => {
      paywall
        .getPrices({ signal: ctrl.signal })
        .then((prices) => {
          if (cancelled) return;
          setState({ prices, loading: false, error: null });
        })
        .catch((error: unknown) => {
          if (cancelled || ctrl.signal.aborted) return;
          setState((prev) => ({
            prices: prev.prices,
            loading: false,
            error: error instanceof Error ? error : new Error(String(error))
          }));
        });
    };

    refresh();

    // `ready` event фаерится из открытого paywall'а с финальным bootstrap'ом —
    // если хост открыл/закрыл модалку, цены могли обновиться через
    // stale-while-revalidate. Слушаем чтобы в pricing-странице цифры не
    // расходились с тем, что юзер увидит в модалке.
    const unsub = paywall.on('ready', () => {
      const fresh = paywall.getCachedPrices();
      if (fresh) setState({ prices: fresh, loading: false, error: null });
    });

    return () => {
      cancelled = true;
      ctrl.abort();
      unsub();
    };
  }, [paywall]);

  return state;
}
