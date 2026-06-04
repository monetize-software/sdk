import { useEffect, useState, type ReactNode } from 'react';
import { PaywallUI, type PaywallUIOptions } from '@monetize.software/sdk';
import { PaywallContext, PaywallProviderMarker } from './context';

/**
 * Two mutually exclusive usage modes:
 *
 *  - `options` — the Provider constructs `PaywallUI` itself in useEffect and
 *     tears it down in cleanup. The most common case — a regular website.
 *  - `instance` — the host creates PaywallUI itself and passes it in ready.
 *     Needed for extensions (`@monetize.software/sdk-extension` ships a
 *     structurally compatible PaywallUI with RemoteBillingClient), for a
 *     shared instance across several React trees, and for tests.
 *
 * A discriminated union at the type level — TS won't let you pass both at once.
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
 * Root Provider for all of the SDK's React bindings.
 *
 * ```tsx
 * // option 1: the Provider creates the instance itself
 * <PaywallProvider options={{ paywallId: '...', auth: true }}>
 *   <App />
 * </PaywallProvider>
 *
 * // option 2: a ready instance from the outside (extension / shared)
 * const paywall = createPaywallUI({ paywallId: '...' });
 * <PaywallProvider instance={paywall}>
 *   <App />
 * </PaywallProvider>
 * ```
 *
 * SSR: the instance is created in useEffect, on the server context value=null.
 * All hooks do a graceful fallback (`null` / `{ status: 'loading' }`), so the
 * Provider can be safely rendered in Next.js / Remix without `'use client'`
 * restrictions on the descendant tree.
 *
 * StrictMode: the cleanup effect calls `destroy()` so that a dev double-mount
 * doesn't leak listeners and subscriptions. The microtask effects of the
 * PaywallUI constructor (`autoDetectReturn`) on the first instance become a
 * no-op after destroy.
 *
 * Changing `options` between renders: not reactive — the Provider creates the
 * instance once. If the host genuinely needs to recreate it (`paywallId`
 * changed), it should change the Provider's `key` — that's the idiomatic React
 * way to force a recreate. We deliberately don't attempt "smart" comparison of
 * the options: structural equality of deep options always breaks on callback
 * functions and live storage updates.
 */
export function PaywallProvider(props: PaywallProviderProps): JSX.Element {
  const externalInstance = 'instance' in props ? props.instance : undefined;
  const options = 'options' in props ? props.options : undefined;

  // External instance → put it into state synchronously so the first render
  // of descendants already sees the real PaywallUI (the host has it available
  // instantly after calling createPaywallUI). Own instance → null until
  // useEffect, because the PaywallUI constructor touches window/queueMicrotask
  // and must not run on the server.
  const [paywall, setPaywall] = useState<PaywallUI | null>(
    externalInstance ?? null
  );

  // We create the instance itself in useEffect (client only). If the host
  // gives a ready one, useEffect just syncs state in case the ref changed
  // between renders without an unmount.
  useEffect(() => {
    if (externalInstance) {
      setPaywall(externalInstance);
      // Externally-owned lifecycle — destroy() isn't ours to call.
      return;
    }

    if (!options) return;

    const created = new PaywallUI(options);
    setPaywall(created);
    return () => {
      created.destroy();
      // null on cleanup — on the next render descendants will see "instance
      // not ready yet" instead of touching a destroyed object. In normal life
      // unmounting the Provider immediately unmounts the descendants too, so
      // this is a safeguard for rare manual-remount scenarios and StrictMode.
      setPaywall(null);
    };
    // options/instance change by reference. Reactively rebuilding the instance
    // on every re-render of the host component isn't what we want (see JSDoc
    // above). To recreate it, use React `key`.
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
