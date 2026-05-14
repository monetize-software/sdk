import type { AuthClient, AuthSession } from '../core/auth';
import type { LayoutBlock, PaywallBootstrap } from '../core/types';
import { AuthPanel } from './renderer/blocks/AuthPanel';
import type { BlockContext } from './renderer/types';

type AuthPanelBlock = Extract<LayoutBlock, { type: 'auth_panel' }>;

export interface AuthGateProps {
  block: AuthPanelBlock;
  bootstrap: PaywallBootstrap;
  auth: AuthClient;
  authSession: AuthSession | null;
  onBack: () => void;
  /** Показывать кнопку «← Back». Для preauth/restore-flow — true (юзер
   *  пришёл сюда из layout, должен иметь возможность вернуться к тарифам).
   *  Для standalone openAuth() — false: модалка открыта только ради signin'а,
   *  ESC и X-кнопка модалки уже закрывают её, дублирующая Back путает. */
  showBack?: boolean;
}

// Полноэкранная обёртка над AuthPanel для preauth-gate flow. AuthPanel сам по
// себе — layout-блок и не знает про "вернуться к тарифам"; gate добавляет
// Back-кнопку + конструирует stub BlockContext (AuthPanel из контекста читает
// только auth/authSession, остальные поля не использует).
export function AuthGate({
  block,
  bootstrap,
  auth,
  authSession,
  onBack,
  showBack = true
}: AuthGateProps) {
  const ctx: BlockContext = {
    bootstrap,
    selectedPriceId: null,
    setSelectedPriceId: () => {},
    onAction: () => {},
    auth,
    authSession
  };

  return (
    <div class="flex flex-col gap-3">
      {showBack ? (
        <button
          type="button"
          onClick={onBack}
          class="-ml-1 self-start rounded-md px-1.5 py-0.5 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
        >
          ← Back
        </button>
      ) : null}
      <AuthPanel block={block} ctx={ctx} />
    </div>
  );
}
