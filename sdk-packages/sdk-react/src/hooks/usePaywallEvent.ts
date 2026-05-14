import { useEffect, useRef } from 'react';
import type { PaywallEvent, PaywallEventHandler } from '@monetize.software/sdk';
import { usePaywall } from './usePaywall';

// Payload-тип конкретного события достаём через `Parameters<PaywallEventHandler<E>>[0]`,
// потому что сам `PaywallEventPayloads` в SDK объявлен локально и не экспортируется.
// Подход через `Parameters<>` устойчив к этому: пока `PaywallEventHandler` есть в
// public surface, payload-тип SDK мы выводим корректно — TS-сборка sdk-react
// упадёт, если сигнатура `PaywallEventHandler` поедет.
type EventPayload<E extends PaywallEvent> = Parameters<PaywallEventHandler<E>>[0];

/**
 * Декларативная подписка на событие PaywallUI. Обёртка над `paywall.on(event, cb)`
 * с двумя важными отличиями от ручного useEffect:
 *
 * 1. handler не нужно мемоизировать через `useCallback` — внутри храним
 *    последнюю версию в `useRef`, само subscription пересоздаётся только
 *    при смене `event` или инстанса paywall'а. Это убирает класс багов с
 *    «забыл useCallback → подписка отписывается-переподписывается на каждый
 *    рендер → события теряются».
 *
 * 2. Корректно обрабатывает `paywall === null` (SSR / до Provider mount-а):
 *    подписка просто не создаётся, ждёт пока инстанс появится.
 *
 * ```tsx
 * usePaywallEvent('purchase_completed', (payload) => {
 *   toast.success(`Покупка ${payload.priceId} прошла`);
 *   queryClient.invalidateQueries(['user']);
 * });
 * ```
 *
 * Для self-cleaning логики (host эмит'а аналитики, инвалидаций кешей, гидрации
 * локального стейта) это самый прямой паттерн — компонент гарантированно
 * отпишется при unmount'е, и не нужно держать unsub-ref'ы вручную.
 */
export function usePaywallEvent<E extends PaywallEvent>(
  event: E,
  handler: PaywallEventHandler<E>
): void {
  const paywall = usePaywall();
  const handlerRef = useRef(handler);

  // Обновляем ref на каждом render'е — следующее срабатывание события
  // подхватит свежий handler. Без отдельного useEffect, потому что синхронный
  // assign в render-фазе для ref'а корректен и не нарушает rules-of-hooks.
  handlerRef.current = handler;

  useEffect(() => {
    if (!paywall) return;
    return paywall.on(event, (payload) => {
      // Cast необходим, потому что общий вариант `PaywallEventHandler` теряет
      // narrowing по `E`. handlerRef.current типизирован под конкретный E,
      // но `on()` принимает union — рантайм-shape гарантирован SDK'шным emit'ом.
      (handlerRef.current as (p: EventPayload<E>) => void)(payload);
    });
  }, [paywall, event]);
}
