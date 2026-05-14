import { useEffect, useState, type ReactNode } from 'react';
import { PaywallUI, type PaywallUIOptions } from '@monetize.software/sdk';
import { PaywallContext, PaywallProviderMarker } from './context';

/**
 * Два взаимоисключающих режима использования:
 *
 *  - `options` — Provider сам конструирует `PaywallUI` в useEffect и
 *     прибирает в cleanup. Самый частый кейс — обычный сайт.
 *  - `instance` — хост создаёт PaywallUI сам и передаёт готовым. Нужно для
 *     extension'ов (`@monetize.software/sdk-extension` поставляет structurally
 *     compatible PaywallUI с RemoteBillingClient), для shared-инстанса между
 *     несколькими React-деревьями и для тестов.
 *
 * Discriminated union на уровне типов — TS не даст передать оба сразу.
 */
export type PaywallProviderProps =
  | {
      options: PaywallUIOptions;
      instance?: never;
      children: ReactNode;
    }
  | {
      instance: PaywallUI;
      options?: never;
      children: ReactNode;
    };

/**
 * Корневой Provider для всех React-биндингов SDK.
 *
 * ```tsx
 * // вариант 1: Provider сам создаёт инстанс
 * <PaywallProvider options={{ paywallId: '...', auth: true }}>
 *   <App />
 * </PaywallProvider>
 *
 * // вариант 2: готовый инстанс снаружи (extension / shared)
 * const paywall = createPaywallUI({ paywallId: '...' });
 * <PaywallProvider instance={paywall}>
 *   <App />
 * </PaywallProvider>
 * ```
 *
 * SSR: инстанс создаётся в useEffect, на сервере context value=null. Все
 * хуки делают graceful fallback (`null` / `{ status: 'loading' }`), так что
 * Provider можно безопасно рендерить в Next.js / Remix без `'use client'`-
 * ограничений на дерево потомков.
 *
 * StrictMode: cleanup-эффект зовёт `destroy()`, чтобы dev double-mount не
 * оставлял утечек listener'ов и подписок. Микротик-эффекты PaywallUI-
 * конструктора (`autoDetectReturn`) на первом инстансе становятся no-op
 * после destroy.
 *
 * Смена `options` между рендерами: не реактивна — Provider создаёт инстанс
 * один раз. Если хосту реально нужно пересоздать (поменялся `paywallId`),
 * следует менять `key` у Provider'а — это идиоматичный React-способ форсить
 * пересоздание. Делать «умное» сравнение опций мы намеренно не пытаемся:
 * структурный equality глубоких options всегда ломается на функциях-колбеках
 * и live-обновлениях storage'а.
 */
export function PaywallProvider(props: PaywallProviderProps): JSX.Element {
  const externalInstance = 'instance' in props ? props.instance : undefined;
  const options = 'options' in props ? props.options : undefined;

  // Внешний инстанс → синхронно кладём его в state, чтобы первый render
  // потомков уже видел реальный PaywallUI (хосту он доступен мгновенно после
  // вызова createPaywallUI). Свой инстанс → null до useEffect, потому что
  // конструктор PaywallUI трогает window/queueMicrotask и не должен крутиться
  // на сервере.
  const [paywall, setPaywall] = useState<PaywallUI | null>(
    externalInstance ?? null
  );

  // Сам инстанс создаём в useEffect (только клиент). Если хост даёт готовый —
  // useEffect просто sync'ит state на случай, если ref поменялся между
  // рендерами без unmount'а.
  useEffect(() => {
    if (externalInstance) {
      setPaywall(externalInstance);
      // Externally-owned lifecycle — destroy() не наш.
      return;
    }

    if (!options) return;

    const created = new PaywallUI(options);
    setPaywall(created);
    return () => {
      created.destroy();
      // null на cleanup — потомки на следующем render'е увидят «инстанс ещё
      // не готов» вместо обращения к destroyed-объекту. В обычной жизни
      // unmount Provider'а сразу размонтирует и потомков, поэтому это
      // подстраховка для редких manual-remount-сценариев и StrictMode'а.
      setPaywall(null);
    };
    // options/instance меняются по reference. Реактивная пересборка инстанса
    // на каждый ре-рендер хост-компонента — не то, что нужно (см. JSDoc выше).
    // Для пересоздания используется React `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalInstance]);

  return (
    <PaywallProviderMarker.Provider value={true}>
      <PaywallContext.Provider value={paywall}>
        {props.children}
      </PaywallContext.Provider>
    </PaywallProviderMarker.Provider>
  );
}
