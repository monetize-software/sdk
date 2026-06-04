import type { AuthClient, AuthSession } from '../core/auth';
import type { LayoutBlock, PaywallBootstrap } from '../core/types';
import { AuthPanel } from './renderer/blocks/AuthPanel';
import type { BlockContext } from './renderer/types';
import { useI18n } from './i18n';

type AuthPanelBlock = Extract<LayoutBlock, { type: 'auth_panel' }>;

/** The context AuthGate was opened from. Controls the default heading/
 *  subheading so the user immediately understands why they were brought here:
 *  - `restore`  — a "Restore purchases" click in current_session
 *  - `preauth`  — checkout_mode=preauth before /start-checkout
 *  - `standalone` — paywall.openAuth() (without any layout context) */
export type AuthIntent = 'restore' | 'preauth' | 'standalone';

export interface AuthGateProps {
  block: AuthPanelBlock;
  bootstrap: PaywallBootstrap;
  auth: AuthClient;
  authSession: AuthSession | null;
  onBack: () => void;
  /** Whether to show the Back button. For preauth/restore flow — true (the
   *  user came here from the layout). For standalone openAuth() — false: the
   *  modal is open only for the sake of signin, and ESC plus the modal's X
   *  already close it. */
  showBack?: boolean;
  intent?: AuthIntent;
  /** Which mode to set in AuthPanel on start. The host called openSignup()
   *  → 'signup', openSignin()/openAuth() → 'signin' (default). */
  initialMode?: 'signin' | 'signup';
}

// Full-screen wrapper over AuthPanel for the AuthGate flow. AuthPanel itself
// doesn't know about "back to plans"; the gate draws a curved-arrow Back button
// in the top-right (as on the legacy screens) and supplies an intent-specific
// heading.
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

  // intent overrides the layout block's heading/subheading:
  //   - 'restore'  → "Restore Purchases" / sign-in-to-restore
  //   - 'preauth'  → "Log in to continue your purchase" / link-purchase
  //   - 'standalone' (paywall.openAuth()) → defaults by mode from AuthPanel
  // If the admin set a custom heading/subheading in the layout — it's kept only
  // for the standalone variant (for preauth/restore we know the context better).
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
            // Preauth heading — a descriptive sentence ("Log in to continue
            // your purchase"), not an action verb. Long localizations (RU:
            // "Войдите, чтобы продолжить покупку") don't fit into the h-12
            // pill button and wrap onto 2 lines. An explicit short submit_label
            // solves it.
            submit_label: t('auth.log_in', 'Sign In')
          }
        : block;

  // Padding + overflow-y-auto are delegated here (not to Modal), because the
  // Modal wrapper is now structurally neutral — Renderer returns its own
  // sticky-footer layout, while gate-views want a single ordinary scroll zone.
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
