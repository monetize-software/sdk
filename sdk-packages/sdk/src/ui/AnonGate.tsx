import { useEffect, useRef, useState } from 'preact/hooks';
import type { AuthClient, AuthSession } from '../core/auth';

// Anonymous sign-in gate. После удаления Turnstile-iframe'а (captcha в Supabase
// выключена, защита держится на Supabase rate-limit per real-IP + CF Bot Fight
// Mode) экран превратился в индикатор прогресса:
//   1. Mount → auth.signInAnonymously() — внутри AuthClient'а сначала проверит
//      idempotent (если уже анон — instant return) и resume (если есть
//      сохранённый refresh_token — silent restore), потом fresh signin.
//   2. Success → onSuccess(session). Gate схлопывается через PaywallRoot.
//   3. Error → отображаем сообщение + кнопку «Try again».
//
// `forceCaptcha` имя сохранили в API ради host backward-compat (на самом деле
// — «принудительно создать нового anon-юзера, не resume'ить»).

export interface AnonGateProps {
  auth: AuthClient;
  /** Вызывается после успешного signin'а (любым путём — idempotent / resume / fresh). */
  onSuccess: (session: AuthSession) => void;
  /** Кнопка «← Back». Опциональна — когда AnonGate смонтирован как
   *  standalone (paywallUI.openAnonGate()), `onBack` приведёт к закрытию
   *  модалки целиком; для inline-варианта в layout — возврат к тарифам. */
  onBack?: () => void;
  heading?: string;
  description?: string;
}

type Phase =
  | { kind: 'signing-in' }
  | { kind: 'error'; message: string };

export function AnonGate({
  auth,
  onSuccess,
  onBack,
  heading = 'Continue as guest',
  description = 'Setting up your guest session…'
}: AnonGateProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'signing-in' });
  // Защита от race: если юзер закрыл модалку посреди signin'а, не зовём
  // onSuccess из устаревшего промиса.
  const aliveRef = useRef(true);
  useEffect(() => {
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const run = (): void => {
    setPhase({ kind: 'signing-in' });
    void (async () => {
      try {
        const session = await auth.signInAnonymously();
        if (!aliveRef.current) return;
        onSuccess(session);
      } catch (e) {
        if (!aliveRef.current) return;
        setPhase({
          kind: 'error',
          message: e instanceof Error ? e.message : 'Anonymous sign-in failed'
        });
      }
    })();
  };

  // Один автозапуск на mount. Зависимости — пустые: повторное срабатывание
  // привело бы к лишним сетевым запросам на каждом ре-рендере родителя.
  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div class="flex flex-col gap-3">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          class="-ml-1 self-start rounded-md px-1.5 py-0.5 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
        >
          ← Back
        </button>
      ) : null}

      <div class="flex flex-col gap-1">
        <h2 class="text-xl font-semibold text-gray-900">{heading}</h2>
        <p class="text-sm text-gray-500">{description}</p>
      </div>

      {phase.kind === 'signing-in' ? (
        <div class="flex items-center justify-center py-6">
          <Spinner />
        </div>
      ) : null}

      {phase.kind === 'error' ? (
        <div class="flex flex-col gap-3">
          <div class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {phase.message}
          </div>
          <button
            type="button"
            onClick={run}
            class="self-start rounded-md bg-[var(--pw-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)] focus-visible:ring-offset-2"
          >
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Spinner() {
  return (
    <svg class="h-5 w-5 animate-spin text-[var(--pw-accent)]" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" stroke-opacity="0.2" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
    </svg>
  );
}
