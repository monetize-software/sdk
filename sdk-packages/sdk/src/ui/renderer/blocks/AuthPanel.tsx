import { useEffect, useRef, useState } from 'preact/hooks';
import type { LastLogin, OAuthProvider } from '../../../core/auth';
import type { LayoutBlock } from '../../../core/types';
import { PaywallError } from '../../../core/types';
import type { BlockProps } from '../types';
import { useI18n, type TFn } from '../../i18n';

type AuthPanelBlock = Extract<LayoutBlock, { type: 'auth_panel' }>;

type Mode = 'signin' | 'signup' | 'signup_sent' | 'forgot' | 'reset_sent' | 'reset_verify';

function providerLabel(provider: OAuthProvider, t: TFn): string {
  switch (provider) {
    case 'google':
      return t('auth.continue_with_google', 'Continue with Google');
    case 'apple':
      return t('auth.continue_with_apple', 'Continue with Apple');
    case 'github':
      return t('auth.continue_with_github', 'Continue with GitHub');
    case 'facebook':
      return t('auth.continue_with_facebook', 'Continue with Facebook');
  }
}

// `err.message` из ApiClient на ошибках бэка без `message`-поля = HTTP statusText
// ("Unauthorized", "Bad Request") — англоязычный и сырой. Маппим стабильные
// `err.code` на i18n-ключи; для всего непонятного — generic fallback вместо
// statusText. `code` приходит из тела ответа (`payload.code`) либо
// `http_<status>`, либо `network_error` (см. api.ts).
function authErrorMessage(
  err: unknown,
  mode: 'signin' | 'signup' | 'otp' | 'reset',
  t: TFn
): string {
  const fallback =
    mode === 'signup'
      ? t('auth.signup_failed', 'Sign-up failed')
      : t('auth.signin_failed', 'Sign-in failed');
  if (!(err instanceof PaywallError)) return fallback;
  switch (err.code) {
    case 'invalid_credentials':
      return t('auth.invalid_credentials', 'Invalid email or password');
    case 'email_not_confirmed':
      return t('auth.email_not_confirmed', 'Please confirm your email before signing in.');
    case 'email_exists':
    case 'user_already_exists':
      return t('auth.email_exists', 'An account with this email already exists.');
    case 'weak_password':
      return t('auth.weak_password', 'Password is too weak.');
    case 'invalid_otp':
    case 'otp_expired':
    case 'token_expired':
      return t('auth.invalid_otp', 'The code is invalid or has expired.');
    case 'over_email_send_rate_limit':
    case 'over_request_rate_limit':
    case 'rate_limited':
    case 'http_429':
      return t('auth.rate_limited', 'Too many requests. Please try again later.');
    case 'network_error':
      return t('auth.network_error', 'Network error. Please check your connection and try again.');
    case 'upstream':
    case 'upstream_error':
    case 'http_502':
    case 'http_503':
    case 'http_504':
      return t('auth.service_unavailable', 'Service is temporarily unavailable. Please try again.');
    default:
      return fallback;
  }
}

export function AuthPanel({ block, ctx }: BlockProps<AuthPanelBlock>) {
  const auth = ctx.auth;
  const session = ctx.authSession;
  const allowSignup = block.allow_signup !== false;
  const allowReset = block.allow_password_reset !== false;
  const hideWhenAuthed = block.hide_when_authenticated !== false;

  if (!auth) {
    if (typeof console !== 'undefined') {
      console.warn('[paywall] auth_panel rendered without AuthClient — pass `auth: true` to PaywallUI');
    }
    return null;
  }

  // Анон-сессия — это «нет авторизации»: анон годится только для api-gateway,
  // покупка/restore требуют реального signin.
  const realSession = session && !session.user.is_anonymous ? session : null;
  if (realSession && hideWhenAuthed) return null;

  if (realSession) {
    return <SignedIn email={realSession.user.email ?? ''} onSignOut={() => auth.signOut().catch(() => {})} />;
  }

  return (
    <AuthForm
      block={block}
      allowSignup={allowSignup}
      allowReset={allowReset}
      ctx={ctx}
    />
  );
}

function SignedIn({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const { t } = useI18n();
  return (
    <div class="flex items-center justify-between gap-3 rounded-2xl bg-gray-100 px-4 py-3">
      <div class="flex flex-col">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
          {t('auth.signed_in', 'Signed in')}
        </span>
        <span class="text-sm font-medium text-gray-900">{email}</span>
      </div>
      <button
        type="button"
        onClick={onSignOut}
        class="rounded-md px-1.5 py-0.5 text-xs font-medium text-gray-600 transition-colors hover:bg-white hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
      >
        {t('auth.sign_out', 'Sign out')}
      </button>
    </div>
  );
}

interface FormProps {
  block: AuthPanelBlock;
  allowSignup: boolean;
  allowReset: boolean;
  ctx: BlockProps<AuthPanelBlock>['ctx'];
}

function AuthForm({ block, allowSignup, allowReset, ctx }: FormProps) {
  const { t } = useI18n();
  const auth = ctx.auth!;
  const providers = block.providers ?? [];

  // initialAuthMode из ctx — host вызвал openSignup() / openSignin().
  // Если admin отключил signup (allow_signup=false), 'signup' игнорируем
  // и стартуем с 'signin' — соблюдаем admin-настройку.
  const initial: Mode =
    ctx.initialAuthMode === 'signup' && allowSignup ? 'signup' : 'signin';
  const [mode, setMode] = useState<Mode>(initial);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [busy, setBusy] = useState<null | OAuthProvider | 'email' | 'reset'>(null);
  // Синхронный guard для double-submit: setBusy — асинхронный setState,
  // и два form-submit события в одном tick'е (Enter+click, двойной mount
  // в demo-ext, transport race) оба проходили `if (busy) return`, дёргая
  // requestPasswordReset/signIn дважды. useRef обновляется синхронно.
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Sign up — progressive disclosure: первый клик «Sign Up» только раскрывает
  // password+confirm; второй клик с заполненными полями делает реальный signUp.
  // По смене mode сбрасываем — переход signin↔signup всегда начинается с
  // collapsed формы.
  const [signupExpanded, setSignupExpanded] = useState(false);

  // Last-used auth метод и email (per-paywall). Async-load из storage на mount,
  // пока null — UI просто рендерится без бейджа. Pre-fill email только если
  // юзер ещё ничего не вводил — иначе перезапишем то, что он печатает.
  //
  // Defensive: старые билды @monetize.software/sdk-extension (≤ 3.0.0-alpha.4)
  // не реализовали getLastLogin в RemoteAuthClient — без guard'а consumer
  // получал бы `auth.getLastLogin is not a function` в консоли. Бейдж в этом
  // случае просто не показывается, signin продолжает работать.
  const [lastLogin, setLastLogin] = useState<LastLogin | null>(null);
  useEffect(() => {
    if (typeof auth.getLastLogin !== 'function') return;
    let cancelled = false;
    auth.getLastLogin().then(
      (v) => {
        if (cancelled || !v) return;
        setLastLogin(v);
        if (v.email) {
          setEmail((current) => (current === '' ? v.email! : current));
        }
      },
      () => {
        /* storage недоступен — UI без бейджа, signin работает */
      }
    );
    return () => {
      cancelled = true;
    };
  }, [auth]);

  const switchTo = (next: Mode): void => {
    setMode(next);
    setError(null);
    setInfo(null);
    setSignupExpanded(false);
  };

  const onSubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (submittingRef.current || busy) return;
    submittingRef.current = true;
    try {
      setError(null);
      setInfo(null);

      // Sign up shortcut: первый сабмит просто раскрывает password-поля,
      // без сетевого запроса. Email обязателен на этом шаге, иначе HTML5
      // validation сама пометит поле required.
      if (mode === 'signup' && !signupExpanded) {
        if (!email.trim()) return;
        setSignupExpanded(true);
        return;
      }

      if (mode === 'signup' && password !== confirmPassword) {
        setError(t('auth.passwords_mismatch', "Passwords don't match"));
        return;
      }

      setBusy('email');
      try {
        if (mode === 'signin') {
          await auth.signInWithEmail({ email, password });
        } else if (mode === 'signup') {
          const res = await auth.signUp({ email, password });
          if (res.kind === 'confirmation_required') {
            // Link-флоу (как recovery): прод-шаблон шлёт confirmation-ссылку,
            // не код. Показываем «проверьте email → кликните ссылку» вместо
            // dead-end экрана ввода кода. Подтверждение завершается на
            // /paywall/v3/auth/confirm, сессия прилетает cross-tab → гейт сам
            // продвигается. Чистим password, чтобы не висел в state.
            setPassword('');
            setMode('signup_sent');
          }
        } else if (mode === 'forgot') {
          await auth.requestPasswordReset({ email });
          setMode('reset_sent');
        } else if (mode === 'reset_verify') {
          await auth.verifyOtp({
            email,
            token: otpCode,
            type: password ? 'recovery' : 'email'
          });
          if (password) {
            await auth.updatePassword({ password });
          }
        }
      } catch (err) {
        const errMode =
          mode === 'signup' ? 'signup'
            : mode === 'reset_verify' ? 'otp'
            : mode === 'forgot' ? 'reset' : 'signin';
        setError(authErrorMessage(err, errMode, t));
      } finally {
        setBusy(null);
      }
    } finally {
      submittingRef.current = false;
    }
  };

  const onOAuth = async (provider: OAuthProvider): Promise<void> => {
    if (submittingRef.current || busy) return;
    submittingRef.current = true;
    setBusy(provider);
    setError(null);
    setInfo(null);
    try {
      await auth.signInWithOAuth({
        provider,
        onPopupOpened: () => setBusy(null)
      });
    } catch (err) {
      if (err instanceof PaywallError && (err.code === 'oauth_cancelled' || err.code === 'oauth_timeout')) {
        return;
      }
      setError(authErrorMessage(err, 'signin', t));
    } finally {
      submittingRef.current = false;
      setBusy(null);
    }
  };

  const showOAuth = providers.length > 0 && (mode === 'signin' || mode === 'signup');
  const showEmailField = mode === 'signin' || mode === 'signup' || mode === 'forgot';
  const showPasswordField =
    mode === 'signin' || (mode === 'signup' && signupExpanded);

  if (mode === 'reset_sent') {
    return <ResetSentView email={email} onBack={() => switchTo('signin')} t={t} />;
  }

  if (mode === 'signup_sent') {
    return <SignupSentView email={email} onBack={() => switchTo('signin')} t={t} />;
  }

  return (
    <div class="flex flex-col gap-5">
      <Header mode={mode} customHeading={block.heading} customSubheading={block.subheading} />

      {showOAuth ? (
        <div class="flex flex-col gap-2.5">
          {providers.map((p) => (
            <div key={p} class="relative">
              <button
                type="button"
                onClick={() => onOAuth(p)}
                disabled={busy !== null}
                class="flex h-12 w-full items-center justify-center gap-2.5 rounded-full border-1 border-gray-200 bg-white px-5 text-base font-medium text-gray-900 transition-all hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
              >
                {busy === p ? (
                  <span class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-700" />
                ) : (
                  <ProviderIcon provider={p} />
                )}
                <span>{providerLabel(p, t)}</span>
              </button>
              {lastLogin?.method === p ? <LastUsedBadge email={lastLogin.email} /> : null}
            </div>
          ))}
          <Divider />
        </div>
      ) : null}

      <form onSubmit={onSubmit} class="flex flex-col gap-3">
        {showEmailField && (
          <FilledField
            type="email"
            placeholder={t('auth.email', 'Email address')}
            value={email}
            onInput={setEmail}
            autocomplete="email"
            required
          />
        )}

        {showPasswordField && (
          <PasswordField
            placeholder={t('auth.password', 'Password')}
            value={password}
            onInput={setPassword}
            autocomplete={mode === 'signin' ? 'current-password' : 'new-password'}
            required
          />
        )}

        {mode === 'signup' && signupExpanded && (
          <PasswordField
            placeholder={t('auth.repeat_password', 'Repeat password')}
            value={confirmPassword}
            onInput={setConfirmPassword}
            autocomplete="new-password"
            required
          />
        )}

        {mode === 'reset_verify' && (
          <FilledField
            type="text"
            placeholder={t('auth.confirmation_code', 'Confirmation code')}
            value={otpCode}
            onInput={setOtpCode}
            autocomplete="one-time-code"
            inputMode="numeric"
            required
          />
        )}

        {mode === 'reset_verify' && (
          <PasswordField
            placeholder={t(
              'auth.new_password_optional',
              'New password (optional — only for password reset)'
            )}
            value={password}
            onInput={setPassword}
            autocomplete="new-password"
          />
        )}

        {mode === 'signin' && allowReset && (
          <div class="flex justify-end text-sm">
            <AccentLink onClick={() => switchTo('forgot')}>
              {t('auth.forgot_password', 'Forgot password?')}
            </AccentLink>
          </div>
        )}

        {error && <p class="text-sm text-red-600">{error}</p>}
        {info && <p class="text-sm text-gray-500">{info}</p>}

        <PrimaryButton
          busy={busy === 'email'}
          label={submitLabel(mode, signupExpanded, block.submit_label ?? block.heading, t)}
        />
      </form>

      <FormFooter
        mode={mode}
        allowSignup={allowSignup}
        onSwitch={switchTo}
      />
    </div>
  );
}

function Header({
  mode,
  customHeading,
  customSubheading
}: {
  mode: Mode;
  customHeading?: string | null;
  customSubheading?: string | null;
}) {
  const { t } = useI18n();
  // customHeading/customSubheading override'ят default для signin+signup mode'ов.
  // Restore/preauth intent ставит свой heading, но когда юзер кликает
  // "Forgot password?" — view меняется на forgot и должен показать
  // дефолтный "Forgot password?" заголовок, а не intent-specific строку.
  // Reset views (forgot/reset_sent/reset_verify) всегда используют дефолты.
  const defaults = defaultHeader(mode, t);
  const useCustom = mode === 'signin' || mode === 'signup';
  const title = useCustom && customHeading ? customHeading : defaults.title;
  const subtitle =
    useCustom && customSubheading !== undefined
      ? customSubheading || null
      : defaults.subtitle;
  return (
    <div class="flex flex-col gap-2">
      <h2 class="text-3xl font-bold tracking-tight text-gray-900">{title}</h2>
      {subtitle ? (
        <p class="text-base leading-relaxed text-gray-600">{subtitle}</p>
      ) : null}
    </div>
  );
}

function defaultHeader(mode: Mode, t: TFn): { title: string; subtitle: string | null } {
  switch (mode) {
    case 'signin':
      return {
        title: t('auth.welcome', 'Welcome back!'),
        subtitle: t('auth.default_subtitle', 'Sign in to access all features and sync your data.')
      };
    case 'signup':
      return {
        title: t('auth.welcome_signup', 'Welcome!'),
        subtitle: t('auth.default_subtitle', 'Sign in to access all features and sync your data.')
      };
    case 'forgot':
      return {
        title: t('auth.forgot_password_title', 'Forgot password?'),
        subtitle: t(
          'auth.forgot_subtitle',
          "Enter your email and we'll send you a password reset link."
        )
      };
    case 'reset_sent':
    case 'signup_sent':
      return {
        title: t('auth.check_email_title', 'Check your email'),
        subtitle: null
      };
    case 'reset_verify':
      return {
        title: t('auth.reset_password_title', 'Reset password'),
        subtitle: t(
          'auth.reset_password_subtitle',
          'Enter the code from your email and a new password.'
        )
      };
  }
}

function submitLabel(
  mode: Mode,
  signupExpanded: boolean,
  customHeading: string | undefined,
  t: TFn
): string {
  // Если задан customHeading — он используется и как submit-лейбл для signin
  // ("Restore Purchases" → button "Restore Purchases"). Для остальных mode'ов
  // submit-лейбл фиксированный (Sign Up / Send Reset Email / Verify).
  if (mode === 'signin' && customHeading) return customHeading;
  switch (mode) {
    case 'signin':
      return t('auth.log_in', 'Sign In');
    case 'signup':
      return signupExpanded
        ? t('auth.create_account', 'Create Account')
        : t('auth.sign_up', 'Sign Up');
    case 'forgot':
      return t('auth.send_reset', 'Send Reset Email');
    case 'reset_verify':
      return t('auth.verify', 'Verify');
    default:
      return t('cta.continue', 'Continue');
  }
}

function FormFooter({
  mode,
  allowSignup,
  onSwitch
}: {
  mode: Mode;
  allowSignup: boolean;
  onSwitch: (m: Mode) => void;
}) {
  const { t } = useI18n();
  if (mode === 'signin' && allowSignup) {
    return (
      <p class="text-center text-sm text-gray-600">
        {t('auth.no_account', "Don't have an account?")}{' '}
        <AccentLink onClick={() => onSwitch('signup')}>
          {t('auth.sign_up_link', 'Sign Up')}
        </AccentLink>
      </p>
    );
  }
  if (mode === 'signup') {
    return (
      <p class="text-center text-sm text-gray-600">
        {t('auth.have_account', 'Already have an account?')}{' '}
        <AccentLink onClick={() => onSwitch('signin')}>
          {t('auth.log_in_link', 'Log In')}
        </AccentLink>
      </p>
    );
  }
  if (mode === 'forgot' || mode === 'reset_sent' || mode === 'reset_verify') {
    return (
      <p class="text-center text-sm text-gray-600">
        {t('auth.no_account', "Don't have an account?")}{' '}
        <AccentLink onClick={() => onSwitch('signup')}>
          {t('auth.sign_up_link', 'Sign Up')}
        </AccentLink>
      </p>
    );
  }
  return null;
}

function AccentLink({
  onClick,
  children
}: {
  onClick: () => void;
  children: preact.ComponentChildren;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      class="font-semibold transition-opacity hover:opacity-80 focus:outline-none focus-visible:opacity-80"
      style={{ color: 'var(--pw-accent)' }}
    >
      {children}
    </button>
  );
}

function PrimaryButton({ busy, label }: { busy: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={busy}
      class="pw-cta-shimmer relative mt-1 flex min-h-12 w-full items-center justify-center overflow-hidden rounded-3xl px-5 py-2 text-center text-base font-semibold leading-tight text-white transition-transform duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]"
      style={{
        background:
          'linear-gradient(135deg, color-mix(in srgb, var(--pw-accent) 55%, white) 0%, var(--pw-accent) 55%, color-mix(in srgb, var(--pw-accent) 90%, black) 100%)',
        boxShadow:
          '0 0 20px 0 color-mix(in srgb, var(--pw-accent) 25%, transparent), inset 0 0 8px 0 color-mix(in srgb, white 25%, transparent)'
      }}
    >
      {busy ? (
        <span class="relative z-10 inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
      ) : (
        <span class="relative z-10">{label}</span>
      )}
    </button>
  );
}

interface FilledFieldProps {
  type: 'email' | 'text';
  placeholder: string;
  value: string;
  onInput: (v: string) => void;
  autocomplete?: string;
  inputMode?: 'numeric' | 'text' | 'email';
  required?: boolean;
}

function FilledField({ type, placeholder, value, onInput, autocomplete, inputMode, required }: FilledFieldProps) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onInput={(e) => onInput((e.target as HTMLInputElement).value)}
      autocomplete={autocomplete}
      inputMode={inputMode}
      required={required}
      class="h-14 w-full rounded-2xl bg-gray-100 px-5 text-base text-gray-900 outline-none transition-all placeholder:text-gray-500 hover:bg-gray-200/60 focus:bg-gray-200/60 focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--pw-accent)_30%,transparent)]"
    />
  );
}

interface PasswordFieldProps {
  placeholder: string;
  value: string;
  onInput: (v: string) => void;
  autocomplete?: string;
  required?: boolean;
}

function PasswordField({ placeholder, value, onInput, autocomplete, required }: PasswordFieldProps) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Chrome/Safari при смене type между password↔text стирают .value (autofill-guard).
  // Preact видит ту же value-prop и не ре-сетит DOM — поле остаётся пустым.
  useEffect(() => {
    const el = inputRef.current;
    if (el && el.value !== value) el.value = value;
  }, [visible, value]);
  const passwordAriaShow = t('auth.show_password', 'Show password');
  const passwordAriaHide = t('auth.hide_password', 'Hide password');
  return (
    <div class="relative">
      <input
        ref={inputRef}
        type={visible ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        autocomplete={autocomplete}
        required={required}
        class="h-14 w-full rounded-2xl bg-gray-100 pl-5 pr-12 text-base text-gray-900 outline-none transition-all placeholder:text-gray-500 hover:bg-gray-200/60 focus:bg-gray-200/60 focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--pw-accent)_30%,transparent)]"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? passwordAriaHide : passwordAriaShow}
        tabIndex={-1}
        class="absolute right-4 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded text-gray-500 transition-colors hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  );
}

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M1.667 10S4.583 4.167 10 4.167 18.333 10 18.333 10 15.417 15.833 10 15.833 1.667 10 1.667 10Z"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" stroke-width="1.5" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M8.236 4.293A6.96 6.96 0 0 1 10 4.167C15.417 4.167 18.333 10 18.333 10a13.5 13.5 0 0 1-1.92 2.755M11.768 11.768A2.5 2.5 0 0 1 8.233 8.233"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M14.953 14.953A8.84 8.84 0 0 1 10 15.833C4.583 15.833 1.667 10 1.667 10a13.5 13.5 0 0 1 3.38-3.953M1.667 1.667l16.666 16.666"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function LastUsedBadge({ email }: { email: string | null }) {
  const { t } = useI18n();
  // Pill в правом верхнем углу кнопки. truncate + max-w защищают от длинного
  // email'а (выйдет за края кнопки). pointer-events-none — чтобы клик попадал
  // в саму кнопку, а не в бейдж сверху.
  const label = email
    ? t('auth.last_used', 'Last · {email}', { email: maskEmail(email) })
    : t('auth.last_used_no_email', 'Last');
  return (
    <span class="pointer-events-none absolute -top-2 right-3 max-w-[75%] truncate rounded-full bg-gray-900 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white shadow-sm">
      {label}
    </span>
  );
}

// alex@example.com → ale*****@example.com. Маскируем local-part (видны
// первые 3 символа), domain оставляем как есть — он публичен и помогает
// юзеру опознать аккаунт.
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const visible = local.slice(0, 3);
  return `${visible}*****@${domain}`;
}

function Divider() {
  const { t } = useI18n();
  return (
    <div class="flex items-center gap-3 py-1 text-sm text-gray-400">
      <div class="h-px flex-1 bg-gray-200" />
      <span>{t('auth.or', 'or')}</span>
      <div class="h-px flex-1 bg-gray-200" />
    </div>
  );
}

function ProviderIcon({ provider }: { provider: OAuthProvider }) {
  if (provider === 'google') {
    return (
      <svg width="20" height="20" viewBox="0 0 18 18" aria-hidden="true">
        <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.49h4.84a4.14 4.14 0 0 1-1.79 2.71v2.26h2.9c1.7-1.56 2.69-3.87 2.69-6.62Z" />
        <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.83.86-3.06.86-2.36 0-4.36-1.59-5.07-3.74H.92v2.33A9 9 0 0 0 9 18Z" />
        <path fill="#FBBC05" d="M3.93 10.68a5.4 5.4 0 0 1 0-3.36V4.99H.92a9 9 0 0 0 0 8.02l3-2.33Z" />
        <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.34l2.58-2.58A9 9 0 0 0 .92 4.99l3.01 2.33C4.64 5.17 6.64 3.58 9 3.58Z" />
      </svg>
    );
  }
  if (provider === 'apple') {
    return (
      // viewBox 0 0 24 24 даёт воздух сверху/снизу пути, поэтому визуально
      // Apple-яблоко выглядит меньше Google. Компенсируем увеличенным
      // width/height — 26×26 даёт примерно equal optical size с Google 20×20.
      <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
      </svg>
    );
  }
  if (provider === 'github') {
    return (
      <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M8 0C3.6 0 0 3.6 0 8a8 8 0 0 0 5.5 7.6c.4.1.5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.4.7 0-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.6 7.6 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.5.8 1.2.8 2.1 0 3.1-1.9 3.7-3.6 3.9.3.3.6.8.6 1.6V15c0 .2.1.5.6.4A8 8 0 0 0 16 8c0-4.4-3.6-8-8-8Z" />
      </svg>
    );
  }
  return (
    <svg width="18" height="20" viewBox="0 0 14 16" fill="currentColor" aria-hidden="true">
      <path d="M14 2.7C14 1.2 12.8 0 11.3 0H2.7C1.2 0 0 1.2 0 2.7v10.6C0 14.8 1.2 16 2.7 16h4V9.8H4.7v-2H6.7V6.4c0-2 1.2-3.1 3-3.1.9 0 1.7.1 2 .2V5h-1.4c-.8 0-1 .4-1 1v1.5h2.4l-.3 2H9.3V16h2c1.5 0 2.7-1.2 2.7-2.7V2.7Z" />
    </svg>
  );
}

// Link-флоу подтверждения signup'а — зеркало ResetSentView. Прод email-шаблон
// «Confirm signup» шлёт ссылку (redirect_to → /paywall/v3/auth/confirm), не код.
// После клика по ссылке юзер подтверждается на v3-странице, сессия синкается
// cross-tab → auth-гейт сам продвигается. Этот экран — «ожидание подтверждения»
// + fallback «Back to Login» (email уже подтверждён → можно зайти паролем).
function SignupSentView({
  email,
  onBack,
  t
}: {
  email: string;
  onBack: () => void;
  t: TFn;
}) {
  return (
    <div class="flex flex-col items-center gap-4 py-2 text-center">
      <div
        class="flex h-14 w-14 items-center justify-center rounded-full"
        style={{
          background: 'linear-gradient(135deg, #4ade80, #16a34a)',
          color: '#fff',
          boxShadow:
            '0 0 0 8px rgba(74,222,128,0.12), 0 8px 20px -6px rgba(22,163,74,0.45)'
        }}
        aria-hidden="true"
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
          <path
            d="M5 13l4 4L19 7"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </div>

      <h2 class="mt-1 text-3xl font-bold tracking-tight text-gray-900">
        {t('auth.check_email_title', 'Check your email')}
      </h2>

      <p class="text-base leading-relaxed text-gray-600">
        {t(
          'auth.signup_sent_subtitle',
          'We sent a confirmation link to your email. Click it to activate your account, then sign in.'
        )}
      </p>

      {email ? (
        <p class="break-all text-base font-semibold text-gray-900">{email}</p>
      ) : null}

      <button
        type="button"
        onClick={onBack}
        class="pw-cta-shimmer relative mt-2 flex min-h-12 w-full items-center justify-center overflow-hidden rounded-3xl px-5 py-2 text-center text-base font-semibold leading-tight text-white transition-transform duration-150 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]"
        style={{
          background:
            'linear-gradient(135deg, color-mix(in srgb, var(--pw-accent) 55%, white) 0%, var(--pw-accent) 55%, color-mix(in srgb, var(--pw-accent) 90%, black) 100%)',
          boxShadow:
            '0 0 20px 0 color-mix(in srgb, var(--pw-accent) 25%, transparent), inset 0 0 8px 0 color-mix(in srgb, white 25%, transparent)'
        }}
      >
        <span class="relative z-10">
          {t('auth.back_to_login', 'Back to Login')}
        </span>
      </button>
    </div>
  );
}

function ResetSentView({
  email,
  onBack,
  t
}: {
  email: string;
  onBack: () => void;
  t: TFn;
}) {
  return (
    <div class="flex flex-col items-center gap-4 py-2 text-center">
      <div
        class="flex h-14 w-14 items-center justify-center rounded-full"
        style={{
          background: 'linear-gradient(135deg, #4ade80, #16a34a)',
          color: '#fff',
          boxShadow:
            '0 0 0 8px rgba(74,222,128,0.12), 0 8px 20px -6px rgba(22,163,74,0.45)'
        }}
        aria-hidden="true"
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
          <path
            d="M5 13l4 4L19 7"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </div>

      <h2 class="mt-1 text-3xl font-bold tracking-tight text-gray-900">
        {t('auth.check_email_title', 'Check your email')}
      </h2>

      <p class="text-base leading-relaxed text-gray-600">
        {t(
          'auth.reset_sent_subtitle',
          'We sent a password reset link. Follow the instructions in the email to reset your password.'
        )}
      </p>

      {email ? (
        <p class="break-all text-base font-semibold text-gray-900">{email}</p>
      ) : null}

      <p class="text-sm text-gray-500">
        {t('auth.reset_link_valid', 'The link is valid for 1 hour.')}
      </p>

      <button
        type="button"
        onClick={onBack}
        class="pw-cta-shimmer relative mt-2 flex min-h-12 w-full items-center justify-center overflow-hidden rounded-3xl px-5 py-2 text-center text-base font-semibold leading-tight text-white transition-transform duration-150 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]"
        style={{
          background:
            'linear-gradient(135deg, color-mix(in srgb, var(--pw-accent) 55%, white) 0%, var(--pw-accent) 55%, color-mix(in srgb, var(--pw-accent) 90%, black) 100%)',
          boxShadow:
            '0 0 20px 0 color-mix(in srgb, var(--pw-accent) 25%, transparent), inset 0 0 8px 0 color-mix(in srgb, white 25%, transparent)'
        }}
      >
        <span class="relative z-10">
          {t('auth.back_to_login', 'Back to Login')}
        </span>
      </button>
    </div>
  );
}
