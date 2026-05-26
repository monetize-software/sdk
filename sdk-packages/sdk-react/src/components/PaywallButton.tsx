import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode
} from 'react';
import type { OpenOptions } from '@monetize.software/sdk';
import { usePaywall } from '../hooks/usePaywall';

/**
 * Параметры открытия пейвола, проксируются в `paywall.open(opts)`.
 * Любые поля {@link OpenOptions} применимы: `identity`, `renew`, `skipTrial`,
 * `skipVisibility`.
 */
type OpenProps = OpenOptions;

interface CommonProps extends OpenProps {
  /** Что открывать: layout (default), support, auth-gate (signin),
   *  signup-форма. 'auth' эквивалентен 'signin' (исторически — openAuth
   *  дефолтит в signin-mode). Для анонимного signin используй
   *  `usePaywall().signInAnonymously()` напрямую — headless без модалки. */
  mode?: 'paywall' | 'support' | 'auth' | 'signin' | 'signup';
  /** Render-prop для полного контроля над элементом-триггером. Когда задан,
   *  все обычные `<button>`-пропсы (children, type, и т.д.) игнорируются. */
  render?: (args: PaywallButtonRenderArgs) => ReactElement;
}

export interface PaywallButtonRenderArgs {
  /** Открыть пейвол согласно `mode` + переданным opts. */
  open: () => void;
  /** Готов ли инстанс PaywallUI. До mount-а Provider'а / на SSR — `false`. */
  ready: boolean;
}

/**
 * Props собственно `<button>`-рендера. Любые HTML-атрибуты — `disabled`,
 * `className`, `aria-label`, `type`, и т.д. — пробрасываются на нативный
 * элемент. `onClick` объединяется с нашим open()-хендлером (мы вызываем
 * наш первым, потом ваш — чтобы хост мог prevent'ить через event.preventDefault).
 */
type ButtonRenderProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  keyof OpenProps | 'children'
> & {
  children?: ReactNode;
};

export type PaywallButtonProps = CommonProps & ButtonRenderProps;

/**
 * Сахар над `usePaywall().open()`. Кнопка по умолчанию рендерится как
 * нативный `<button>` со всеми твоими className/style/disabled, но при нужде
 * можно передать `render` для произвольного элемента (Radix-style asChild
 * паттерн через render-prop).
 *
 * ```tsx
 * // обычный кейс
 * <PaywallButton className="btn-primary" renew>
 *   Renew subscription
 * </PaywallButton>
 *
 * // custom-элемент
 * <PaywallButton render={({ open, ready }) => (
 *   <MyFancyButton onClick={open} disabled={!ready}>Upgrade</MyFancyButton>
 * )} />
 *
 * // саппорт-форма вместо тарифов
 * <PaywallButton mode="support">Need help?</PaywallButton>
 * ```
 *
 * До mount-а Provider'а или на SSR кнопка рендерится с `disabled=true`
 * (через CSS-pseudo `[aria-busy]` хост может стилизовать loading-state) —
 * клик в этот момент no-op, потому что инстанса PaywallUI ещё нет.
 */
export const PaywallButton = forwardRef<HTMLButtonElement, PaywallButtonProps>(
  function PaywallButton(props, ref) {
    const paywall = usePaywall();
    const {
      mode = 'paywall',
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

    const openOpts: OpenOptions = { identity, renew, skipTrial, skipVisibility };

    const open = (): void => {
      if (!paywall) return;
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
      return render({ open, ready });
    }

    return (
      <button
        ref={ref}
        type="button"
        disabled={disabled || !ready}
        aria-busy={!ready ? true : undefined}
        onClick={(event) => {
          // Наш handler первым — host через event.preventDefault() ничего
          // не остановит, потому что open() уже стрельнул. Это намеренно:
          // открытие пейвола не должно зависеть от того, забыл ли хост
          // вернуть `false` из своего analytics-handler'а. Если нужен
          // префлайт-чек — паттерн через `render`-prop, там полный контроль.
          open();
          onClick?.(event);
        }}
        {...buttonProps}
      />
    );
  }
);
