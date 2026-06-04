import { createContext } from 'react';
import type { PaywallUI } from '@monetize.software/sdk';

/**
 * Internal React Context into which PaywallProvider puts the PaywallUI instance.
 *
 * value === null until the Provider has managed to mount the instance (SSR,
 * the first render before useEffect, a dev double-mount in StrictMode after
 * cleanup). Hooks must handle null correctly — return loading/null/no-op
 * rather than crashing.
 *
 * defaultValue is intentionally `null`, not `undefined` — this lets
 * usePaywall() distinguish "Provider doesn't wrap the tree" (the
 * undefined-simulation via the sentinel object below isn't needed, we catch
 * that differently) from "Provider exists, but the instance isn't created
 * yet" (null).
 */
export const PaywallContext = createContext<PaywallUI | null>(null);
PaywallContext.displayName = 'PaywallContext';

/**
 * Sentinel for tracking: "is the component inside a Provider at all?".
 *
 * React Context returns defaultValue when `<Provider>` doesn't wrap the tree.
 * If defaultValue=null and the Provider also legitimately puts null (on SSR /
 * before mount) — we can't distinguish these two cases. So the Provider always
 * wraps a second Context with a HAS_PROVIDER=true marker, which usePaywall
 * checks first.
 */
export const PaywallProviderMarker = createContext<boolean>(false);
PaywallProviderMarker.displayName = 'PaywallProviderMarker';
