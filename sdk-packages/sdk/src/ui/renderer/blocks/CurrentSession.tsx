import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { LayoutBlock } from '../../../core/types';
import type { BlockProps } from '../types';
import { useI18n } from '../../i18n';

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
  const { t } = useI18n();
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

    // "Signed in as <email>" — рендерим вручную из двух частей, чтобы email
    // оставался в bold-вёрстке. {email} placeholder в локали игнорируется —
    // строка показывается до email, b-тег c email-ом идёт после.
    return (
      <div class="-mt-3 flex flex-col items-center gap-1.5 pt-1 text-center text-[13px] text-gray-500">
        <span>
          {t('session.signed_in_as_prefix', 'Signed in as')}{' '}
          <b class="font-medium text-gray-700">{session.user.email}</b>
        </span>
        <div class="flex items-center justify-center gap-3">
          <AccentLink onClick={onSignOut} disabled={!auth || signingOut}>
            {signingOut
              ? t('session.signing_out', 'Signing out…')
              : t('session.sign_out', 'Sign Out')}
          </AccentLink>
          <Dot />
          <AccentLink onClick={onSupport}>
            {t('session.contact_support', 'Contact Support')}
          </AccentLink>
        </div>
      </div>
    );
  }

  return (
    <div class="-mt-3 flex items-center justify-center gap-3 pt-1 text-center text-[13px]">
      <AccentLink onClick={() => ctx.onAction('restore')}>
        {t('session.restore_purchases', 'Restore purchases')}
      </AccentLink>
      <Dot />
      <AccentLink onClick={onSupport}>{t('session.contact_support', 'Contact Support')}</AccentLink>
    </div>
  );
}

function AccentLink({
  onClick,
  disabled,
  children
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ComponentChildren;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      class="font-semibold transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:opacity-80"
      style={{ color: 'var(--pw-accent)' }}
    >
      {children}
    </button>
  );
}

function Dot() {
  return <span class="h-1 w-1 rounded-full bg-gray-300" aria-hidden="true" />;
}
