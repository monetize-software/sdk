import { forwardRef } from 'react';
import { PaywallButton, type PaywallButtonProps } from './PaywallButton';

export type PaywallSupportButtonProps = Omit<PaywallButtonProps, 'mode'>;

/**
 * Sugar over `<PaywallButton mode="support">`. A standalone component rather
 * than a prop preset, for discoverability — the name speaks for itself, and in
 * large layouts it's easier to see where support is versus the main
 * upgrade-CTA.
 *
 * ```tsx
 * <PaywallSupportButton className="link">Help</PaywallSupportButton>
 * ```
 */
export const PaywallSupportButton = forwardRef<
  HTMLButtonElement,
  PaywallSupportButtonProps
>(function PaywallSupportButton(props, ref) {
  return <PaywallButton {...props} mode="support" ref={ref} />;
});
