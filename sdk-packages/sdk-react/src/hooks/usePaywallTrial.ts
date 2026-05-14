import { useCallback, useEffect, useState } from 'react';
import type { PaywallUI } from '@monetize.software/sdk';
import { usePaywall } from './usePaywall';

// `TrialStatus` локально не экспортируется из SDK, но мы его получаем
// через ReturnType-инференцию по публичному методу `getTrialStatus()`. Так
// тип всегда совпадает с тем, что реально возвращает PaywallUI, без зависимости
// от непубличного namespace'а SDK.
type TrialStatus = NonNullable<ReturnType<PaywallUI['getTrialStatus']>>;

/**
 * Текущий статус триала ({@link TrialStatus}) с автоматическим ре-рендером на
 * `trial_blocked` события.
 *
 * Возвращает `null`, пока триал не проверялся (хост не вызывал
 * `paywall.open()` / `paywall.getAccess()`) либо триал отключён в конфиге
 * пейвола. Сам триал-стейт живёт в storage (localStorage / chrome.storage),
 * проверяется в `paywall.open()` и в `paywall.getAccess()` — оба пути обновляют
 * in-memory snapshot, который мы здесь и читаем.
 *
 * Использовать чтобы рисовать собственный UI:
 *  - «У тебя осталось 3 показа» (mode `opens`) — `status.remainingActions`;
 *  - «Триал истечёт через 2 часа» (mode `time`) — `status.remainingMs`;
 *  - «Триал заблокирован, оплати чтобы продолжить» — `status.blocked === true`.
 *
 * ```tsx
 * const trial = usePaywallTrial();
 * if (trial?.mode === 'opens') {
 *   return <Banner>Showings left: {trial.remainingActions}</Banner>;
 * }
 * ```
 */
export function usePaywallTrial(): TrialStatus | null {
  const paywall = usePaywall();
  const [status, setStatus] = useState<TrialStatus | null>(() =>
    paywall?.getTrialStatus() ?? null
  );

  // Стабильный refresh для эффекта — отдельная функция, чтобы deps массив
  // эффекта был чистым (`[paywall]`), без useCallback-цепочек.
  const sync = useCallback(() => {
    if (!paywall) {
      setStatus(null);
      return;
    }
    setStatus(paywall.getTrialStatus());
  }, [paywall]);

  useEffect(() => {
    if (!paywall) {
      setStatus(null);
      return;
    }
    // Sync read на mount-е — getTrialStatus() мог обновиться между прошлым
    // рендером и effect'ом (например, hook вызван после первого open()-а).
    sync();

    // `trial_blocked` — единственный event, после которого snapshot реально
    // меняется. `trial_expired` фаерится один раз за жизнь инстанса и не
    // меняет shape статуса (статус становится `mode: 'none'` ИЛИ переходит
    // в un-blocked-режим, что и так читается через sync()).
    const unsubBlock = paywall.on('trial_blocked', sync);
    const unsubExpired = paywall.on('trial_expired', sync);

    return () => {
      unsubBlock();
      unsubExpired();
    };
  }, [paywall, sync]);

  return status;
}
