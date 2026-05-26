import type { AuthClient, AuthSession } from '../core/auth';
import type { LayoutBlock, PaywallBootstrap } from '../core/types';
import { AuthPanel } from './renderer/blocks/AuthPanel';
import type { BlockContext } from './renderer/types';
import { useI18n } from './i18n';

type AuthPanelBlock = Extract<LayoutBlock, { type: 'auth_panel' }>;

/** Контекст, из которого AuthGate был открыт. Управляет дефолтным заголовком/
 *  субзаголовком, чтобы юзер сразу понимал зачем его сюда привели:
 *  - `restore`  — клик "Restore purchases" в current_session
 *  - `preauth`  — checkout_mode=preauth перед /start-checkout
 *  - `standalone` — paywall.openAuth() (без всякого layout-контекста) */
export type AuthIntent = 'restore' | 'preauth' | 'standalone';

export interface AuthGateProps {
  block: AuthPanelBlock;
  bootstrap: PaywallBootstrap;
  auth: AuthClient;
  authSession: AuthSession | null;
  onBack: () => void;
  /** Показывать кнопку Back. Для preauth/restore-flow — true (юзер пришёл сюда
   *  из layout). Для standalone openAuth() — false: модалка открыта только
   *  ради signin'а, ESC и крестик модалки уже её закрывают. */
  showBack?: boolean;
  intent?: AuthIntent;
  /** Какой mode выставить в AuthPanel на старте. Host вызвал openSignup()
   *  → 'signup', openSignin()/openAuth() → 'signin' (дефолт). */
  initialMode?: 'signin' | 'signup';
}

// Полноэкранная обёртка над AuthPanel для AuthGate flow. AuthPanel сам не
// знает про "вернуться к тарифам"; gate рисует Back-кнопку curved-arrow
// в top-right (как на легаси-скринах) и подсовывает intent-specific heading.
export function AuthGate({
  block,
  bootstrap,
  auth,
  authSession,
  onBack,
  showBack = true,
  intent = 'preauth',
  initialMode
}: AuthGateProps) {
  const { t } = useI18n();
  const ctx: BlockContext = {
    bootstrap,
    selectedPriceId: null,
    setSelectedPriceId: () => {},
    onAction: () => {},
    auth,
    authSession,
    initialAuthMode: initialMode
  };

  // intent override'ит heading/subheading layout-block'а:
  //   - 'restore'  → "Restore Purchases" / sign-in-to-restore
  //   - 'preauth'  → "Log in to continue your purchase" / link-purchase
  //   - 'standalone' (paywall.openAuth()) → дефолты по mode из AuthPanel
  // Если admin задал в layout кастомный heading/subheading — он сохраняется
  // только для standalone-варианта (для preauth/restore мы знаем контекст лучше).
  const effectiveBlock: AuthPanelBlock =
    intent === 'restore'
      ? {
          ...block,
          heading: t('auth.restore_purchases_heading', 'Restore Purchases'),
          subheading: t(
            'auth.restore_purchases_subheading',
            'Please sign in to restore your purchases.'
          )
        }
      : intent === 'preauth'
        ? {
            ...block,
            heading: t('auth.login_continue_purchase', 'Log in to continue your purchase'),
            subheading: t(
              'auth.link_purchase_subheading',
              "We'll link the purchase to your account to keep access."
            ),
            // Preauth heading — descriptive sentence ("Log in to continue your
            // purchase"), а не action verb. Длинные локализации (RU: "Войдите,
            // чтобы продолжить покупку") в pill-кнопку h-12 не помещаются и
            // переносятся на 2 строки. Явный короткий submit_label решает.
            submit_label: t('auth.log_in', 'Sign In')
          }
        : block;

  // Padding + overflow-y-auto делегированы сюда (а не в Modal), потому что
  // Modal-обёртка теперь structurally нейтральна — Renderer возвращает свой
  // sticky-footer-layout, а gate-views хотят обычный единый scroll-зона.
  return (
    <div class="relative flex-1 min-h-0 overflow-y-auto p-6 sm:p-8">
      {showBack ? <BackArrowButton onClick={onBack} ariaLabel={t('nav.back_aria', 'Back')} /> : null}
      <AuthPanel block={effectiveBlock} ctx={ctx} />
    </div>
  );
}

function BackArrowButton({ onClick, ariaLabel }: { onClick: () => void; ariaLabel: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      class="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
    >
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M5 8h8a4 4 0 0 1 0 8H9"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M8 4 4 8l4 4"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  );
}
