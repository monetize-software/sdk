import { forwardRef } from 'react';
import { PaywallButton, type PaywallButtonProps } from './PaywallButton';

export type PaywallSupportButtonProps = Omit<PaywallButtonProps, 'mode'>;

/**
 * Сахар над `<PaywallButton mode="support">`. Самостоятельная компонента, а
 * не пресет prop'а, для discoverability — название говорит за себя, и в
 * больших layout-ах легче видеть, где саппорт, а где основной upgrade-CTA.
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
