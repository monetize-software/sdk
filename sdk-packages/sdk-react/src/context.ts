import { createContext } from 'react';
import type { PaywallUI } from '@monetize.software/sdk';

/**
 * Внутренний React Context, в который PaywallProvider кладёт PaywallUI-инстанс.
 *
 * value === null до того, как Provider успел смонтировать инстанс (SSR,
 * первый render до useEffect, дев double-mount в StrictMode после cleanup).
 * Хуки должны корректно обрабатывать null — отдавать loading/null/no-op,
 * а не падать.
 *
 * defaultValue intentionally `null`, а не `undefined` — это позволяет
 * usePaywall() различать «Provider не оборачивает дерево» (undefined-симуляция
 * через sentinel-объект ниже не нужна, мы это ловим иначе) и «Provider есть,
 * но инстанс ещё не создан» (null).
 */
export const PaywallContext = createContext<PaywallUI | null>(null);
PaywallContext.displayName = 'PaywallContext';

/**
 * Sentinel для отслеживания: «компонент вообще находится внутри Provider'а?».
 *
 * React Context отдаёт defaultValue, когда `<Provider>` не оборачивает дерево.
 * Если defaultValue=null, а Provider тоже легально кладёт null (на SSR /
 * до mount-а) — мы не различаем эти два случая. Поэтому Provider всегда
 * оборачивает второй Context с маркером HAS_PROVIDER=true, который usePaywall
 * проверяет первым.
 */
export const PaywallProviderMarker = createContext<boolean>(false);
PaywallProviderMarker.displayName = 'PaywallProviderMarker';
