import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { LayoutBlock } from '../../../core/types';
import type { BlockProps } from '../types';
import { useI18n } from '../../i18n';

type CurrentSessionBlock = Extract<LayoutBlock, { type: 'current_session' }>;

// Footer below cta_button. Mirrors legacy v2 PaywallCurrentSession:
//   - signed in → "Signed in as <email>" + Sign out (calls auth.signOut())
//                + Contact Support
//   - guest     → "Restore purchases" + Contact Support
// Without an AuthClient in managed mode we render only Restore + Support
// (there is nothing to sign out, and restore without an auth client is a no-op in handleAction).
// An anonymous session (is_anonymous=true) is treated as "not signed in": the anon
// exists only for the api-gateway token, the user has no email and "Signed in" makes no UX sense.
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
        /* signOut errors are silent — onAuthChange will fire anyway on refresh-fail */
      } finally {
        setSigningOut(false);
      }
    };

    // "Signed in as <email>" — rendered manually from two parts so the email
    // stays in bold markup. The {email} placeholder in the locale is ignored —
    // the string is shown before the email, and the b-tag with the email comes after.
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
