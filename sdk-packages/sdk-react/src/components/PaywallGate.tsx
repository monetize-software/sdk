import { useEffect, type ReactNode } from 'react';
import type { PaywallAccessResult } from '@monetize.software/sdk';
import { usePaywall } from '../hooks/usePaywall';
import { usePaywallAccess } from '../hooks/usePaywallAccess';

export interface PaywallGateProps {
  /** Что показать, пока `getAccess()` не вернул ответ (initial fetch / Provider mount). */
  loading?: ReactNode;
  /**
   * Fallback для `blocked` ответа — обычно CTA «Upgrade». Принимает либо
   * статичный ReactNode, либо render-функцию, получающую callback
   * `open()` — удобно, чтобы кастомная кнопка сама дёргала модалку:
   *
   * ```tsx
   * fallback={({ open }) => <MyCTA onClick={open}>Upgrade</MyCTA>}
   * ```
   *
   * Если не передан — компонент рендерит `null` для blocked (host
   * полагается на `openOnBlocked` или ловит open() сам через `usePaywall`).
   */
  fallback?: ReactNode | ((args: BlockedRenderArgs) => ReactNode);
  /**
   * Автоматически дёргать `paywall.open()` сразу как только access перешёл в
   * blocked. Удобно для feature-разделителей вида «нажми и попадёшь на
   * paywall»: компонент сам открывает модалку, не нужно писать onClick.
   *
   * По умолчанию `false` — большинство хостов хотят сначала показать
   * объясняющий CTA, а модалку открывать по клику. Включать осознанно.
   */
  openOnBlocked?: boolean;
  /** Премиум-контент. Рендерится только когда access=granted. */
  children: ReactNode;
}

export interface BlockedRenderArgs {
  result: Extract<PaywallAccessResult, { access: 'blocked' }>;
  open: () => void;
}

/**
 * Декларативная обёртка над {@link usePaywallAccess} + {@link usePaywall}.open().
 *
 * Три состояния:
 *  - `loading` (первый fetch / Provider не готов) — рендерим `props.loading`;
 *  - `granted` (есть подписка / visibility / trial) — рендерим `children`;
 *  - `blocked` — рендерим `fallback` (если задан) и опционально дёргаем
 *    `paywall.open()` при `openOnBlocked={true}`.
 *
 * ```tsx
 * <PaywallGate
 *   loading={<Skeleton />}
 *   fallback={({ open }) => <button onClick={open}>Upgrade</button>}
 * >
 *   <PremiumFeature />
 * </PaywallGate>
 * ```
 *
 * Для нестандартных сценариев (показать "Try free trial" вместо upgrade,
 * комбинировать с собственным auth-flow'ом) использовать
 * {@link usePaywallAccess} напрямую — gate решает 80% кейсов, не пытаясь
 * стать конфигурируемым на каждый чих.
 */
export function PaywallGate(props: PaywallGateProps): JSX.Element | null {
  const paywall = usePaywall();
  const access = usePaywallAccess();

  // `openOnBlocked` — side-effect, поэтому в useEffect. Зависим от access
  // через идентификатор `result.access`, а не от объекта целиком, чтобы
  // не дёргать open() на каждом refresh-е getAccess'а с тем же blocked-итогом.
  const isBlocked =
    access.status === 'ready' && access.result.access === 'blocked';
  const shouldAutoOpen = props.openOnBlocked === true && isBlocked;

  useEffect(() => {
    if (shouldAutoOpen && paywall) paywall.open();
  }, [shouldAutoOpen, paywall]);

  if (access.status === 'loading') {
    return <>{props.loading ?? null}</>;
  }

  if (access.result.access === 'granted') {
    return <>{props.children}</>;
  }

  // blocked
  const fallback = props.fallback;
  if (typeof fallback === 'function') {
    return (
      <>
        {fallback({
          result: access.result,
          open: () => paywall?.open()
        })}
      </>
    );
  }
  return <>{fallback ?? null}</>;
}
