import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode
} from 'react';
import type { OpenOptions } from '@monetize.software/sdk';
import { usePaywall } from '../hooks/usePaywall';
import { usePaywallState } from '../hooks/usePaywallState';

/**
 * Paywall-open options, proxied into `paywall.open(opts)`.
 * Any {@link OpenOptions} fields apply: `identity`, `renew`, `skipTrial`,
 * `skipVisibility`.
 */
type OpenProps = OpenOptions;

interface CommonProps extends OpenProps {
  /** What to open: layout (default), support, auth-gate (signin),
   *  signup form. 'auth' is equivalent to 'signin' (historically — openAuth
   *  defaults to signin-mode). For anonymous signin use
   *  `usePaywall().signInAnonymously()` directly — headless, without a modal. */
  mode?: 'paywall' | 'support' | 'auth' | 'signin' | 'signup';
  /** Direct-checkout: when `priceId` is set, a click calls
   *  `paywall.checkout(priceId, opts)` bypassing the layout with plans. `mode`
   *  is ignored in that case. Layout-flow (`mode='paywall'`, the default) and
   *  direct-checkout are mutually exclusive: either the user picks a plan in
   *  the modal, or the host has already picked one and leads to checkout. See
   *  `PaywallUI.checkout()` for preauth/already-paid behavior. */
  priceId?: string;
  /** Render-prop for full control over the trigger element. When set, all the
   *  usual `<button>` props (children, type, etc.) are ignored. */
  render?: (args: PaywallButtonRenderArgs) => ReactElement;
}

export interface PaywallButtonRenderArgs {
  /** Open the paywall according to `mode` + the passed opts. */
  open: () => void;
  /** Whether the PaywallUI instance is ready. Before the Provider mounts / on
   *  SSR — `false`. */
  ready: boolean;
  /** Direct-checkout is in the middle of headless bootstrap+createCheckout
   *  (only when the button has a `priceId` set). The render-prop can show a
   *  spinner right on its button and disable it so the user doesn't click
   *  again. For non-priceId modes always false. */
  processing: boolean;
}

/**
 * Props of the actual `<button>` render. Any HTML attributes — `disabled`,
 * `className`, `aria-label`, `type`, etc. — are forwarded to the native
 * element. `onClick` is combined with our open() handler (we call ours first,
 * then yours — so the host can prevent via event.preventDefault).
 */
type ButtonRenderProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  keyof OpenProps | 'children'
> & {
  children?: ReactNode;
};

export type PaywallButtonProps = CommonProps & ButtonRenderProps;

/**
 * Sugar over `usePaywall().open()`. By default the button renders as a native
 * `<button>` with all your className/style/disabled, but when needed you can
 * pass `render` for an arbitrary element (Radix-style asChild pattern via a
 * render-prop).
 *
 * ```tsx
 * // common case
 * <PaywallButton className="btn-primary" renew>
 *   Renew subscription
 * </PaywallButton>
 *
 * // custom element
 * <PaywallButton render={({ open, ready }) => (
 *   <MyFancyButton onClick={open} disabled={!ready}>Upgrade</MyFancyButton>
 * )} />
 *
 * // support form instead of plans
 * <PaywallButton mode="support">Need help?</PaywallButton>
 *
 * // direct-checkout: the host already picked a plan in its own UI (pricing
 * // cards), the click leads straight to the provider, bypassing the layout
 * // with plans.
 * <PaywallButton priceId={price.id} className="btn-primary">
 *   Get this plan
 * </PaywallButton>
 * ```
 *
 * Before the Provider mounts or on SSR the button renders with `disabled=true`
 * (the host can style the loading-state via the CSS pseudo `[aria-busy]`) — a
 * click at that moment is a no-op, because there is no PaywallUI instance yet.
 */
export const PaywallButton = forwardRef<HTMLButtonElement, PaywallButtonProps>(
  function PaywallButton(props, ref) {
    const paywall = usePaywall();
    const state = usePaywallState();
    const {
      mode = 'paywall',
      priceId,
      identity,
      renew,
      skipTrial,
      skipVisibility,
      render,
      onClick,
      disabled,
      ...buttonProps
    } = props;

    const ready = paywall !== null;

    // Direct-checkout (priceId mode): while the SDK is doing headless bootstrap
    // + createCheckout, `state.processing` is true. We disable the button and
    // show aria-busy — the host gets "I clicked, SDK is working" feedback
    // without a modal flash. For non-priceId modes (modal-flow) this flag is
    // always false: the modal appears instantly and shows the LoadingView
    // itself, no busy on the button needed.
    const processing = !!priceId && state.processing;

    const openOpts: OpenOptions = { identity, renew, skipTrial, skipVisibility };

    const open = (): void => {
      if (!paywall) return;
      // priceId wins over mode: direct-checkout is separate semantics (the host
      // already picked a plan in its own UI), `mode` makes no sense to combine
      // with a specific price.
      if (priceId) {
        paywall.checkout(priceId, openOpts);
        return;
      }
      switch (mode) {
        case 'support':
          paywall.openSupport(openOpts);
          return;
        case 'auth':
        case 'signin':
          paywall.openSignin(openOpts);
          return;
        case 'signup':
          paywall.openSignup(openOpts);
          return;
        default:
          paywall.open(openOpts);
      }
    };

    if (render) {
      return render({ open, ready, processing });
    }

    return (
      <button
        ref={ref}
        type="button"
        disabled={disabled || !ready || processing}
        aria-busy={!ready || processing ? true : undefined}
        onClick={(event) => {
          // Our handler first — the host can't stop anything via
          // event.preventDefault(), because open() already fired. This is
          // intentional: opening the paywall shouldn't depend on whether the
          // host forgot to return `false` from its analytics handler. If a
          // preflight check is needed — use the `render`-prop pattern, full
          // control is there.
          open();
          onClick?.(event);
        }}
        {...buttonProps}
      />
    );
  }
);
