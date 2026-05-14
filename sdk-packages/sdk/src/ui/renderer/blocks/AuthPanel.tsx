import { useState } from 'preact/hooks';
import type { OAuthProvider } from '../../../core/auth';
import type { LayoutBlock } from '../../../core/types';
import { PaywallError } from '../../../core/types';
import type { BlockProps } from '../types';

type AuthPanelBlock = Extract<LayoutBlock, { type: 'auth_panel' }>;

type Mode = 'signin' | 'signup' | 'forgot' | 'reset_sent' | 'reset_verify';

const PROVIDER_LABEL: Record<OAuthProvider, string> = {
  google: 'Continue with Google',
  apple: 'Continue with Apple',
  github: 'Continue with GitHub',
  facebook: 'Continue with Facebook'
};

export function AuthPanel({ block, ctx }: BlockProps<AuthPanelBlock>) {
  const auth = ctx.auth;
  const session = ctx.authSession;
  const allowSignup = block.allow_signup !== false;
  const allowReset = block.allow_password_reset !== false;
  const hideWhenAuthed = block.hide_when_authenticated !== false;

  // Без AuthClient рендерим заметный fallback в dev, в проде ничего: блок
  // в layout не попадает по ошибке только если host забыл передать auth-опцию.
  if (!auth) {
    if (typeof console !== 'undefined') {
      console.warn('[paywall] auth_panel rendered without AuthClient — pass `auth: true` to PaywallUI');
    }
    return null;
  }

  // Анон-сессия в UI пейвола — это «нет авторизации»: анон нужен только для
  // api-gateway-токена, для покупки/restore юзеру всё равно надо реально
  // залогиниться. hide_when_authenticated анон тоже игнорирует (иначе блок
  // схлопнется, и юзер останется без формы).
  const realSession = session && !session.user.is_anonymous ? session : null;

  // Реально залогинен и block явно не просит показать summary — скрываемся целиком.
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
  return (
    <div class="flex items-center justify-between gap-3 rounded-2xl border border-gray-200 bg-gray-50/60 px-4 py-3">
      <div class="flex flex-col">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Signed in</span>
        <span class="text-sm font-medium text-gray-900">{email}</span>
      </div>
      <button
        type="button"
        onClick={onSignOut}
        class="rounded-md px-1.5 py-0.5 text-xs font-medium text-gray-600 transition-colors hover:bg-white hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
      >
        Sign out
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
  const auth = ctx.auth!;
  const providers = block.providers ?? [];

  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [busy, setBusy] = useState<null | OAuthProvider | 'email' | 'reset'>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Успешный auth не эмитит через ctx.onAction — single source of truth для
  // signin/signout-аналитики = AuthClient.onAuthChange (PaywallUI на него
  // подписан и сам пишет в трекер). Failed-кейсы тоже не эмитим: показываем
  // юзеру inline-error, для funnel'а это пока не критично.
  const onSubmit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setBusy('email');
    setError(null);
    setInfo(null);
    try {
      if (mode === 'signin') {
        await auth.signInWithEmail({ email, password });
      } else if (mode === 'signup') {
        const res = await auth.signUp({ email, password });
        if (res.kind === 'confirmation_required') {
          // Сервер требует email confirm — переключаемся в OTP-verify, юзер
          // вводит 6-значный код из письма. После verify — мы сразу залогинены
          // (verifyOtp сам поставит session), AuthForm схлопнется.
          setMode('reset_verify');
          setInfo('Check your email for a confirmation code.');
        }
      } else if (mode === 'forgot') {
        await auth.requestPasswordReset({ email });
        setMode('reset_sent');
        setInfo('If that email exists, a reset code has been sent.');
      } else if (mode === 'reset_verify') {
        // Используется и для signup-confirm, и для recovery — оба flow одинаковые
        // (verifyOtp выдаёт session). Differentiator — какой type послали.
        await auth.verifyOtp({
          email,
          token: otpCode,
          type: password ? 'recovery' : 'email'
        });
        if (password) {
          // Recovery flow: после verify мы получили session, теперь меняем пароль.
          await auth.updatePassword({ password });
        }
      }
    } catch (e) {
      const msg = e instanceof PaywallError ? e.message : 'Something went wrong';
      setError(msg);
    } finally {
      setBusy(null);
    }
  };

  const onOAuth = async (provider: OAuthProvider) => {
    if (busy) return;
    setBusy(provider);
    setError(null);
    setInfo(null);
    try {
      // Лоадер снимаем сразу после открытия popup'а — дальше судьба флоу
      // в руках юзера. Юзер закрыл вкладку / отвлёкся / COOP-severance не дал
      // нам поймать closed → promise тихо дойдёт до oauth_timeout, но кнопка
      // не висит, юзер просто кликнет ещё раз.
      await auth.signInWithOAuth({
        provider,
        onPopupOpened: () => setBusy(null)
      });
    } catch (e) {
      // popup_blocked показываем (юзер должен включить popup'ы); cancelled/
      // timeout — нормальный ход событий, не считаем ошибкой.
      if (e instanceof PaywallError) {
        if (e.code === 'oauth_cancelled' || e.code === 'oauth_timeout') return;
        setError(e.message);
      } else {
        setError('Sign-in failed');
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="flex flex-col gap-3">
      {block.heading ? (
        <h2 class="text-lg font-semibold tracking-tight text-gray-900">{block.heading}</h2>
      ) : null}

      {providers.length > 0 && (mode === 'signin' || mode === 'signup') ? (
        <div class="flex flex-col gap-2">
          {providers.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onOAuth(p)}
              disabled={busy !== null}
              class="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 text-sm font-medium text-gray-900 shadow-[0_1px_0_rgba(15,23,42,0.04)] transition-all hover:-translate-y-px hover:border-gray-300 hover:bg-gray-50 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-[0_1px_0_rgba(15,23,42,0.04)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
            >
              {busy === p ? (
                <span class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-700" />
              ) : (
                <ProviderIcon provider={p} />
              )}
              <span>{PROVIDER_LABEL[p]}</span>
            </button>
          ))}
          <Divider />
        </div>
      ) : null}

      <form onSubmit={onSubmit} class="flex flex-col gap-2">
        {(mode === 'signin' || mode === 'signup' || mode === 'forgot') && (
          <Field
            type="email"
            label="Email"
            value={email}
            onInput={setEmail}
            autocomplete="email"
            required
          />
        )}

        {(mode === 'signin' || mode === 'signup') && (
          <Field
            type="password"
            label="Password"
            value={password}
            onInput={setPassword}
            autocomplete={mode === 'signin' ? 'current-password' : 'new-password'}
            required
          />
        )}

        {mode === 'reset_verify' && (
          <>
            <Field
              type="text"
              label="Confirmation code"
              value={otpCode}
              onInput={setOtpCode}
              autocomplete="one-time-code"
              inputMode="numeric"
              required
            />
            <Field
              type="password"
              label="New password (optional — only for password reset)"
              value={password}
              onInput={setPassword}
              autocomplete="new-password"
            />
          </>
        )}

        {mode === 'reset_sent' && info && (
          <p class="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">{info}</p>
        )}

        {error && <p class="text-xs text-red-600">{error}</p>}
        {info && mode !== 'reset_sent' && (
          <p class="text-xs text-gray-500">{info}</p>
        )}

        {mode !== 'reset_sent' && (
          <button
            type="submit"
            disabled={busy !== null}
            class="flex h-11 w-full items-center justify-center rounded-xl px-4 text-sm font-semibold tracking-tight text-white transition-all hover:-translate-y-px hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:brightness-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]"
            style={{
              background:
                'linear-gradient(180deg, color-mix(in srgb, var(--pw-accent) 92%, white), var(--pw-accent))',
              boxShadow:
                '0 1px 2px rgba(15,23,42,0.08), 0 6px 14px -4px color-mix(in srgb, var(--pw-accent) 50%, transparent)'
            }}
          >
            {busy === 'email' ? (
              <span class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            ) : (
              submitLabel(mode)
            )}
          </button>
        )}
      </form>

      <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-gray-500">
        {mode === 'signin' && allowSignup && (
          <button type="button" onClick={() => switchMode(setMode, setError, setInfo, 'signup')} class="font-medium text-gray-700 hover:underline">
            Create account
          </button>
        )}
        {mode === 'signup' && (
          <button type="button" onClick={() => switchMode(setMode, setError, setInfo, 'signin')} class="font-medium text-gray-700 hover:underline">
            I already have an account
          </button>
        )}
        {mode === 'signin' && allowReset && (
          <button type="button" onClick={() => switchMode(setMode, setError, setInfo, 'forgot')} class="hover:underline">
            Forgot password?
          </button>
        )}
        {(mode === 'forgot' || mode === 'reset_sent' || mode === 'reset_verify') && (
          <button type="button" onClick={() => switchMode(setMode, setError, setInfo, 'signin')} class="hover:underline">
            Back to sign in
          </button>
        )}
        {mode === 'reset_sent' && (
          <button type="button" onClick={() => switchMode(setMode, setError, setInfo, 'reset_verify')} class="font-medium text-gray-700 hover:underline">
            I have a code
          </button>
        )}
      </div>
    </div>
  );
}

function submitLabel(mode: Mode): string {
  switch (mode) {
    case 'signin':
      return 'Sign in';
    case 'signup':
      return 'Create account';
    case 'forgot':
      return 'Send reset code';
    case 'reset_verify':
      return 'Verify';
    default:
      return 'Continue';
  }
}

function switchMode(
  setMode: (m: Mode) => void,
  setError: (s: string | null) => void,
  setInfo: (s: string | null) => void,
  next: Mode
): void {
  setMode(next);
  setError(null);
  setInfo(null);
}

interface FieldProps {
  type: 'email' | 'password' | 'text';
  label: string;
  value: string;
  onInput: (v: string) => void;
  autocomplete?: string;
  inputMode?: 'numeric' | 'text' | 'email';
  required?: boolean;
}

function Field({ type, label, value, onInput, autocomplete, inputMode, required }: FieldProps) {
  return (
    <label class="flex flex-col gap-1.5">
      <span class="text-xs font-medium text-gray-700">{label}</span>
      <input
        type={type}
        value={value}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        autocomplete={autocomplete}
        inputMode={inputMode}
        required={required}
        class="h-11 w-full rounded-xl border border-gray-200 bg-white px-3.5 text-sm text-gray-900 shadow-[0_1px_0_rgba(15,23,42,0.02)] outline-none transition-all placeholder:text-gray-400 hover:border-gray-300 focus:border-[var(--pw-accent)] focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--pw-accent)_18%,transparent)]"
      />
    </label>
  );
}

function Divider() {
  return (
    <div class="flex items-center gap-2 py-1 text-[10px] uppercase tracking-[0.14em] text-gray-400">
      <div class="h-px flex-1 bg-gradient-to-r from-gray-200 to-transparent" />
      <span>or</span>
      <div class="h-px flex-1 bg-gradient-to-r from-transparent to-gray-200" />
    </div>
  );
}

// Минималистичные SVG-иконки провайдеров. CWS требует bundled-ассеты, поэтому
// никаких CDN-картинок. По цвету рисуем только Google (брендовый), остальные
// чёрно-белые — это нейтрально и подходит под любой brand_color пейвола.
function ProviderIcon({ provider }: { provider: OAuthProvider }) {
  if (provider === 'google') {
    return (
      <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
        <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.49h4.84a4.14 4.14 0 0 1-1.79 2.71v2.26h2.9c1.7-1.56 2.69-3.87 2.69-6.62Z" />
        <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.83.86-3.06.86-2.36 0-4.36-1.59-5.07-3.74H.92v2.33A9 9 0 0 0 9 18Z" />
        <path fill="#FBBC05" d="M3.93 10.68a5.4 5.4 0 0 1 0-3.36V4.99H.92a9 9 0 0 0 0 8.02l3-2.33Z" />
        <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.34l2.58-2.58A9 9 0 0 0 .92 4.99l3.01 2.33C4.64 5.17 6.64 3.58 9 3.58Z" />
      </svg>
    );
  }
  if (provider === 'apple') {
    return (
      <svg width="14" height="16" viewBox="0 0 14 16" fill="currentColor" aria-hidden="true">
        <path d="M11.4 8.5c0-2 1.6-3 1.7-3-.9-1.3-2.4-1.5-2.9-1.5-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7-1.3 0-2.6.8-3.3 2C-.4 8.4.7 12.5 2.2 14.7c.7 1.1 1.6 2.3 2.7 2.3 1.1 0 1.5-.7 2.8-.7 1.3 0 1.7.7 2.8.7 1.2 0 1.9-1.1 2.6-2.2.6-.9 1-1.8 1.1-2.7-1.4-.5-2.8-1.7-2.8-3.6Zm-2-6.5C10 1.3 10.4.4 10.3 0c-.7 0-1.6.5-2.1 1.1-.5.5-1 1.4-.9 2.2.7 0 1.5-.4 2.1-1.3Z" />
      </svg>
    );
  }
  if (provider === 'github') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M8 0C3.6 0 0 3.6 0 8a8 8 0 0 0 5.5 7.6c.4.1.5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.4.7 0-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.6 7.6 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.5.8 1.2.8 2.1 0 3.1-1.9 3.7-3.6 3.9.3.3.6.8.6 1.6V15c0 .2.1.5.6.4A8 8 0 0 0 16 8c0-4.4-3.6-8-8-8Z" />
      </svg>
    );
  }
  return (
    <svg width="14" height="16" viewBox="0 0 14 16" fill="currentColor" aria-hidden="true">
      <path d="M14 2.7C14 1.2 12.8 0 11.3 0H2.7C1.2 0 0 1.2 0 2.7v10.6C0 14.8 1.2 16 2.7 16h4V9.8H4.7v-2H6.7V6.4c0-2 1.2-3.1 3-3.1.9 0 1.7.1 2 .2V5h-1.4c-.8 0-1 .4-1 1v1.5h2.4l-.3 2H9.3V16h2c1.5 0 2.7-1.2 2.7-2.7V2.7Z" />
    </svg>
  );
}
