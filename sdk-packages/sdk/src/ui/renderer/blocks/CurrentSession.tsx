import { useState } from 'preact/hooks';
import type { LayoutBlock } from '../../../core/types';
import type { BlockProps } from '../types';

type CurrentSessionBlock = Extract<LayoutBlock, { type: 'current_session' }>;

// Footer под cta_button. Зеркалит legacy v2 PaywallCurrentSession:
//   - залогинен → "Signed in as <email>" + Sign out (вызывает auth.signOut())
//                + Contact Support
//   - гость    → "Restore purchases" + Contact Support
// Без AuthClient в managed-режиме — рендерим только Restore + Support
// (sign out нечему делать, restore без auth-клиента no-op'нет в handleAction).
// Анон-сессия (is_anonymous=true) трактуется как «нет логина»: анон существует
// только ради api-gateway-токена, у юзера нет email и UX-смысла «Signed in».
export function CurrentSession({ ctx }: BlockProps<CurrentSessionBlock>) {
  const session = ctx.authSession;
  const auth = ctx.auth;
  const [signingOut, setSigningOut] = useState(false);

  const onSupport = (): void => ctx.onAction('support');

  if (session && !session.user.is_anonymous) {
    const onSignOut = async (): Promise<void> => {
      if (!auth || signingOut) return;
      setSigningOut(true);
      try {
        await auth.signOut();
      } catch {
        /* signOut ошибки безшумные — onAuthChange всё равно отработает на refresh-fail */
      } finally {
        setSigningOut(false);
      }
    };

    return (
      <div class="mt-2 text-center text-xs text-gray-500">
        <span>Signed in as </span>
        <b class="font-medium text-gray-700">{session.user.email}</b>
        <div class="mt-1 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={onSignOut}
            disabled={!auth || signingOut}
            class="font-medium text-gray-600 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:underline"
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
          <Dot />
          <SupportLink onClick={onSupport} />
        </div>
      </div>
    );
  }

  return (
    <div class="mt-2 flex items-center justify-center gap-3 text-center text-xs text-gray-500">
      <button
        type="button"
        onClick={() => ctx.onAction('restore')}
        class="font-medium text-gray-600 underline-offset-2 hover:underline focus:outline-none focus-visible:underline"
      >
        Restore purchases
      </button>
      <Dot />
      <SupportLink onClick={onSupport} />
    </div>
  );
}

function SupportLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      class="font-medium text-gray-600 underline-offset-2 hover:underline focus:outline-none focus-visible:underline"
    >
      Contact Support
    </button>
  );
}

function Dot() {
  return <span class="h-1 w-1 rounded-full bg-gray-300" aria-hidden="true" />;
}
