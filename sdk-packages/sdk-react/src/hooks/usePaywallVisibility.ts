import { useCallback, useEffect, useState } from 'react';
import type { PaywallUI } from '@monetize.software/sdk';
import { usePaywall } from './usePaywall';

// `VisibilityStatus` локально не экспортируется из SDK — получаем через
// ReturnType от публичного `getVisibility()`. См. usePaywallTrial для тех же
// соображений.
type VisibilityStatus = NonNullable<ReturnType<PaywallUI['getVisibility']>>;

/**
 * Server-computed visibility-снимок ({@link VisibilityStatus}): попадает ли
 * юзер в monetization-scope пейвола (страна, девайс, ручной visibility-флаг).
 *
 * Возвращает `null`, пока bootstrap не загружен или сервер не отдал
 * `settings.visibility` (старый online без targeting-патча).
 *
 * Использовать чтобы:
 *  - показать собственный fallback («сервис недоступен в вашей стране») вместо
 *    модалки, когда `visible === false`;
 *  - залогировать impression для аналитики страны/tier'а юзера;
 *  - принять решение какой CTA рисовать, не дёргая open() и не дожидаясь
 *    visibility_blocked event.
 *
 * ```tsx
 * const visibility = usePaywallVisibility();
 * if (visibility && !visibility.visible) {
 *   return <SoftBlock reason={visibility.reason} />;
 * }
 * ```
 */
export function usePaywallVisibility(): VisibilityStatus | null {
  const paywall = usePaywall();
  const [visibility, setVisibility] = useState<VisibilityStatus | null>(() =>
    paywall?.getVisibility() ?? null
  );

  const sync = useCallback(() => {
    if (!paywall) {
      setVisibility(null);
      return;
    }
    setVisibility(paywall.getVisibility());
  }, [paywall]);

  useEffect(() => {
    if (!paywall) {
      setVisibility(null);
      return;
    }
    sync();

    // `ready` event летит после успешного bootstrap'а — там обновляется
    // `lastVisibility` в PaywallUI. `visibility_blocked` — когда блокировка
    // реально срабатывает на gate'е. Оба меняют snapshot.
    const unsubReady = paywall.on('ready', sync);
    const unsubBlocked = paywall.on('visibility_blocked', sync);

    return () => {
      unsubReady();
      unsubBlocked();
    };
  }, [paywall, sync]);

  return visibility;
}
