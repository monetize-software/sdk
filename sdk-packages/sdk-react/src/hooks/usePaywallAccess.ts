import { useEffect, useState } from 'react';
import type {
  GetAccessOptions,
  PaywallAccessResult
} from '@monetize.software/sdk';
import { usePaywall } from './usePaywall';

/**
 * `loading` — первый fetch ещё в полёте (или Provider не готов).
 * `ready` — есть свежий ответ; `result` гарантированно non-null.
 *
 * Сделано discriminated union'ом, чтобы хост мог сужать тип одним if-ом:
 *
 *   `if (access.status === 'ready') access.result.access === 'granted'`
 */
export type PaywallAccessState =
  | { status: 'loading'; result: null }
  | { status: 'ready'; result: PaywallAccessResult };

const LOADING_STATE: PaywallAccessState = { status: 'loading', result: null };

/**
 * Главный хук для гейтинга фич: «нужно ли блокировать фичу для этого юзера?».
 *
 * Под капотом — `paywall.getAccess(opts)` без side-effect'ов (модалка не
 * монтируется, trial-storage не двигается). На каждый `userChange` событие
 * автоматически рефетчится — после успешной покупки `has_subscription`
 * сработает мгновенно, и хост перерендерит UI без feature-lock'а.
 *
 * Bootstrap кешируется в BillingClient, так что usePaywallAccess можно дёргать
 * в любом компоненте дерева — сетевой запрос будет ровно один (или ни одного,
 * если кеш свежий).
 *
 * ```tsx
 * const access = usePaywallAccess();
 * const paywall = usePaywall();
 *
 * if (access.status === 'loading') return <Skeleton />;
 * if (access.result.access === 'blocked') {
 *   return <button onClick={() => paywall?.open()}>Upgrade</button>;
 * }
 * return <PremiumFeature />;
 * ```
 *
 * Опции `opts` десериализуются по `skipTrial`/`skipVisibility` — стабильность
 * ссылки `opts` не требуется, эффект перезапустится только при реальном
 * изменении этих флагов. `signal` мы дропаем из deps (на каждый рендер у него
 * новый ref) — отмена inflight-запроса делается локально через AbortController
 * в cleanup-эффекте.
 */
export function usePaywallAccess(opts: GetAccessOptions = {}): PaywallAccessState {
  const paywall = usePaywall();
  const [state, setState] = useState<PaywallAccessState>(LOADING_STATE);

  const skipTrial = opts.skipTrial === true;
  const skipVisibility = opts.skipVisibility === true;

  useEffect(() => {
    if (!paywall) {
      // Инстанс ушёл (Provider unmount / StrictMode cleanup) — честно
      // вернуть loading, чтобы хост не показывал устаревший result от
      // прошлого инстанса.
      setState(LOADING_STATE);
      return;
    }

    const ctrl = new AbortController();
    let cancelled = false;

    const refresh = () => {
      paywall
        .getAccess({ skipTrial, skipVisibility, signal: ctrl.signal })
        .then((result) => {
          if (cancelled || ctrl.signal.aborted) return;
          // Каждый refresh даёт новый объект — useState увидит !== и
          // ререндерит. Это ок: для гейтинга интерес представляет именно
          // `access` поле, остальное (visibility/trial snapshot'ы) — auxiliary
          // данные, которые не должны бы менять решение хоста на тех же входах.
          setState({ status: 'ready', result });
        })
        .catch(() => {
          // getAccess() имеет собственный offline-fallback и не throw'ит на
          // failed network'е — сюда мы попадаем только при abort'е, который
          // прилетает в cleanup-эффекте. Молча игнорим.
        });
    };

    refresh();

    // userChange покрывает оба источника обновления decision'а:
    //  - после-checkout watcher эмит'ит userChange когда has_subscription=true
    //  - manual /me refresh из хоста (paywall.billing.getUser())
    // Дополнительно слушаем purchase_completed для symmetric'ности — на
    // некоторых платежных провайдерах userChange может задержаться, а
    // purchase_completed летит мгновенно по URL-маркеру/postMessage.
    const unsubUser = paywall.on('userChange', refresh);
    const unsubPurchase = paywall.on('purchase_completed', refresh);

    return () => {
      cancelled = true;
      ctrl.abort();
      unsubUser();
      unsubPurchase();
    };
  }, [paywall, skipTrial, skipVisibility]);

  return state;
}
