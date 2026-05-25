import { useMemo, useRef, useState } from 'preact/hooks';
import type { BillingClient } from '../core/BillingClient';
import type { AuthSession } from '../core/auth';
import { PaywallError } from '../core/types';
import { useI18n } from './i18n';

export interface SupportGateProps {
  client: BillingClient;
  authSession: AuthSession | null;
  // 'standalone' — модалка открыта только для саппорта (paywall.openSupport()),
  // Back/Done закрывают её. 'layout' — пришли из current_session-блока,
  // Back/Done возвращают в layout (и пейвол с тарифами остаётся открытым).
  origin: 'layout' | 'standalone';
  onBack: () => void;
}

const SUBJECT_MIN = 3;
const SUBJECT_MAX = 200;
const CONTENT_MAX = 5000;
const MAX_FILES = 5;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const EMAIL_RE = /.+@.+\..+/;

export function SupportGate({ client, authSession, origin, onBack }: SupportGateProps) {
  const { t } = useI18n();
  const sessionEmail = authSession?.user.email ?? '';
  // Если есть сессия — email фиксируем из неё, форма его не редактирует.
  const lockedEmail = sessionEmail ? sessionEmail : null;
  const [email, setEmail] = useState<string>(sessionEmail);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  const [errors, setErrors] = useState<{
    subject?: string;
    email?: string;
    message?: string;
    files?: string;
    submit?: string;
  }>({});

  const isValid = useMemo(() => {
    const e = (lockedEmail ?? email).trim().toLowerCase();
    const s = subject.trim();
    const m = message.trim();
    return (
      EMAIL_RE.test(e) &&
      s.length >= SUBJECT_MIN &&
      s.length <= SUBJECT_MAX &&
      m.length >= 1 &&
      m.length <= CONTENT_MAX
    );
  }, [lockedEmail, email, subject, message]);

  const validate = (): boolean => {
    const next: typeof errors = {};
    const e = (lockedEmail ?? email).trim();
    const s = subject.trim();
    const m = message.trim();
    if (!e) next.email = t('support.required', 'Required');
    else if (!EMAIL_RE.test(e.toLowerCase())) next.email = t('support.invalid_email', 'Invalid email');
    if (s.length < SUBJECT_MIN || s.length > SUBJECT_MAX) {
      next.subject = t('support.subject_length', '{min}–{max} characters', {
        min: SUBJECT_MIN,
        max: SUBJECT_MAX
      });
    }
    if (m.length < 1 || m.length > CONTENT_MAX) {
      next.message = t('support.message_length', '{min}–{max} characters', {
        min: 1,
        max: CONTENT_MAX
      });
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const onSubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    if (!validate()) return;
    setSubmitting(true);
    setErrors((prev) => ({ ...prev, submit: undefined }));
    try {
      const finalEmail = (lockedEmail ?? email).trim();
      await client.createSupportTicket({
        subject: subject.trim(),
        content: message.trim(),
        email: finalEmail || undefined,
        files: files.length > 0 ? files : undefined
      });
      setSubmittedEmail(finalEmail);
    } catch (err) {
      const msg =
        err instanceof PaywallError
          ? err.message || 'Failed to send. Please try again.'
          : 'Failed to send. Please try again.';
      setErrors((prev) => ({ ...prev, submit: msg }));
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = (): void => {
    setSubject('');
    setMessage('');
    setFiles([]);
    setErrors({});
    setSubmittedEmail(null);
  };

  // Footer-shadow + scroll-area pattern идентичен Renderer.tsx — кнопки
  // прибиты к низу dialog'а и читабельны на коротких viewport'ах (extension
  // popup ≤600px), скроллится только контент над ними.
  const footerClass = 'flex flex-col gap-3 bg-white px-6 pb-6 pt-3 sm:px-8';
  const footerStyle = { boxShadow: '0 -4px 12px -4px rgba(15,23,42,0.06)' };

  if (submittedEmail) {
    return (
      <div class="relative flex-1 min-h-0 flex flex-col">
        <div class="flex-1 min-h-0 overflow-y-auto flex flex-col items-center gap-4 px-6 pb-3 pt-6 sm:px-8 sm:pb-4 sm:pt-8 text-center">
          <div
            class="flex h-14 w-14 items-center justify-center rounded-full"
            style={{
              background:
                'linear-gradient(135deg, color-mix(in srgb, var(--pw-accent) 85%, white), var(--pw-accent))',
              color: '#fff',
              boxShadow:
                '0 0 0 8px color-mix(in srgb, var(--pw-accent) 12%, transparent), 0 8px 20px -6px color-mix(in srgb, var(--pw-accent) 45%, transparent)'
            }}
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 24" class="h-7 w-7">
              <path
                fill="currentColor"
                d="M12 0a12 12 0 1 0 0 24 12 12 0 0 0 0-24Zm6.93 8.2-6.85 9.29a1.01 1.01 0 0 1-1.43.19L5.76 13.77a1 1 0 1 1 1.25-1.56l4.08 3.26 6.23-8.45a1 1 0 1 1 1.61 1.18Z"
              />
            </svg>
          </div>
          <div class="text-lg font-semibold tracking-tight text-gray-900">
            {t('support.success_heading', 'Request submitted')}
          </div>
          <div class="max-w-[320px] text-sm leading-relaxed text-gray-500">
            {/* email рендерим отдельным <b>, prefix-only ключ — для языков с
               порядком "received message will be sent to X" этого хватает. */}
            {t(
              'support.success_message_prefix',
              "We've received your message and will respond to"
            )}{' '}
            <b class="text-gray-700">{submittedEmail}</b>.
          </div>
        </div>
        <div class={footerClass} style={footerStyle}>
          <div class="flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={onBack}
              class="rounded-xl px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
            >
              {origin === 'standalone'
                ? t('support.done_button', 'Done')
                : t('nav.back_aria', 'Back')}
            </button>
            <button
              type="button"
              onClick={resetForm}
              class="flex h-10 items-center justify-center rounded-xl px-4 text-sm font-semibold text-white transition-all hover:-translate-y-px hover:brightness-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]"
              style={{
                background:
                  'linear-gradient(180deg, color-mix(in srgb, var(--pw-accent) 92%, white), var(--pw-accent))',
                boxShadow:
                  '0 1px 2px rgba(15,23,42,0.08), 0 6px 14px -4px color-mix(in srgb, var(--pw-accent) 50%, transparent)'
              }}
            >
              {t('support.send_another', 'Send another request')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} class="relative flex-1 min-h-0 flex flex-col">
      <BackArrowButton onClick={onBack} ariaLabel={t('nav.back_aria', 'Back')} />
      <div class="flex-1 min-h-0 overflow-y-auto px-6 pb-3 pt-6 sm:px-8 sm:pb-4 sm:pt-8">
        <div class="flex flex-col gap-5">
          <div class="flex flex-col gap-2 pr-10">
            <h2 class="text-3xl font-bold tracking-tight text-gray-900">
              {t('support.heading', 'Support')}
            </h2>
            <p class="text-base leading-relaxed text-gray-600">
              {t('support.instruction', 'Please fill out the form below to submit your support request.')}
            </p>
          </div>

          <div class="flex flex-col gap-3">
            {!lockedEmail ? (
              <FilledField
                type="email"
                placeholder={t('support.email_placeholder', 'Enter your email *')}
                value={email}
                onInput={setEmail}
                error={errors.email}
                autocomplete="email"
                required
              />
            ) : (
              <div class="rounded-2xl bg-gray-100 px-5 py-3 text-sm text-gray-600">
                {t('support.sending_as', 'Sending as')}{' '}
                <b class="font-medium text-gray-900">{lockedEmail}</b>
              </div>
            )}
            <FilledField
              type="text"
              placeholder={t('support.subject_placeholder', 'Enter your subject *')}
              value={subject}
              onInput={setSubject}
              error={errors.subject}
              required
            />
            <FilledTextarea
              placeholder={t('support.message_placeholder', 'Enter your message *')}
              value={message}
              onInput={setMessage}
              error={errors.message}
              required
            />
            <Dropzone files={files} onChange={setFiles} disabled={submitting} />
          </div>
        </div>
      </div>

      <div class={footerClass} style={footerStyle}>
        {errors.submit && <p class="text-sm text-red-600">{errors.submit}</p>}
        <div class="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onBack}
            disabled={submitting}
            class="rounded-full px-4 py-2 text-base font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
          >
            {origin === 'standalone'
              ? t('support.close_button', 'Close')
              : t('nav.back_aria', 'Back')}
          </button>
          <button
            type="submit"
            disabled={!isValid || submitting}
            class="pw-cta-shimmer relative flex h-12 items-center justify-center overflow-hidden rounded-full px-8 text-base font-semibold text-white transition-transform duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]"
            style={{
              background:
                'linear-gradient(135deg, color-mix(in srgb, var(--pw-accent) 55%, white) 0%, var(--pw-accent) 55%, color-mix(in srgb, var(--pw-accent) 90%, black) 100%)',
              boxShadow:
                '0 0 20px 0 color-mix(in srgb, var(--pw-accent) 25%, transparent), inset 0 0 8px 0 color-mix(in srgb, white 25%, transparent)'
            }}
          >
            {submitting ? (
              <span class="relative z-10 inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            ) : (
              <span class="relative z-10">{t('support.send_button', 'Send')}</span>
            )}
          </button>
        </div>
      </div>
    </form>
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

interface FilledFieldProps {
  type: 'email' | 'text';
  placeholder: string;
  value: string;
  onInput: (v: string) => void;
  error?: string;
  autocomplete?: string;
  required?: boolean;
}

function FilledField({
  type,
  placeholder,
  value,
  onInput,
  error,
  autocomplete,
  required
}: FilledFieldProps) {
  return (
    <div>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        autocomplete={autocomplete}
        required={required}
        class={`h-14 w-full rounded-2xl bg-gray-100 px-5 text-base text-gray-900 outline-none transition-all placeholder:text-gray-500 hover:bg-gray-200/60 focus:bg-gray-200/60 ${
          error
            ? 'shadow-[0_0_0_2px_rgba(239,68,68,0.5)]'
            : 'focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--pw-accent)_30%,transparent)]'
        }`}
      />
      {error && <span class="mt-1 ml-2 block text-sm text-red-600">{error}</span>}
    </div>
  );
}

interface FilledTextareaProps {
  placeholder: string;
  value: string;
  onInput: (v: string) => void;
  error?: string;
  required?: boolean;
}

function FilledTextarea({
  placeholder,
  value,
  onInput,
  error,
  required
}: FilledTextareaProps) {
  return (
    <div>
      <textarea
        value={value}
        placeholder={placeholder}
        onInput={(e) => onInput((e.target as HTMLTextAreaElement).value)}
        required={required}
        rows={5}
        class={`min-h-[120px] w-full rounded-2xl bg-gray-100 px-5 py-3.5 text-base leading-relaxed text-gray-900 outline-none transition-all placeholder:text-gray-500 hover:bg-gray-200/60 focus:bg-gray-200/60 ${
          error
            ? 'shadow-[0_0_0_2px_rgba(239,68,68,0.5)]'
            : 'focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--pw-accent)_30%,transparent)]'
        }`}
      />
      {error && <span class="mt-1 ml-2 block text-sm text-red-600">{error}</span>}
    </div>
  );
}

interface DropzoneProps {
  files: File[];
  onChange: (next: File[]) => void;
  disabled?: boolean;
}

function Dropzone({ files, onChange, disabled }: DropzoneProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = (incoming: FileList | null): void => {
    if (!incoming || disabled) return;
    setError(null);
    const arr = Array.from(incoming);
    if (files.length + arr.length > MAX_FILES) {
      setError(t('support.too_many_files', 'Up to {max} files', { max: MAX_FILES }));
      return;
    }
    const valid = arr.filter(
      (f) => ACCEPTED_MIME.includes(f.type) && f.size <= MAX_FILE_SIZE
    );
    if (valid.length !== arr.length) {
      setError(t('support.invalid_file', 'Only JPEG/PNG/WebP, ≤ 10MB each'));
      return;
    }
    onChange([...files, ...valid]);
  };

  return (
    <div>
      <span class="text-xs font-medium text-gray-700">
        {t('support.attachments_label', 'Attachments (optional)')}
      </span>
      <div
        role="button"
        tabIndex={0}
        aria-label={t('support.attachments_aria', 'Attachments upload')}
        onClick={() => !disabled && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer?.files ?? null);
        }}
        class={`mt-1.5 cursor-pointer rounded-2xl border border-dashed p-3.5 text-center transition-all ${
          dragOver
            ? 'border-[var(--pw-accent)] bg-[color-mix(in_srgb,var(--pw-accent)_6%,white)]'
            : 'border-gray-300 hover:border-gray-400 hover:bg-gray-50/60'
        } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
      >
        <div class="text-xs text-gray-500">
          {t('support.dropzone_text', 'Drop images here or click to select')}
        </div>
        <div class="mt-0.5 text-[11px] text-gray-400">
          {t('support.file_requirements', 'JPEG/PNG/WebP, up to {max} files, ≤ 10MB each', {
            max: MAX_FILES
          })}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPTED_MIME.join(',')}
        class="hidden"
        onChange={(e) => {
          handleFiles((e.target as HTMLInputElement).files);
          (e.currentTarget as HTMLInputElement).value = '';
        }}
      />
      {error && <p class="mt-1 text-xs text-red-600">{error}</p>}
      {files.length > 0 && (
        <ul class="mt-2 flex flex-col gap-1">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${f.size}-${i}`}
              class="flex items-center justify-between gap-2 rounded bg-gray-50 px-2 py-1 text-xs"
            >
              <span class="truncate text-gray-700">{f.name}</span>
              <button
                type="button"
                onClick={() => {
                  const next = [...files];
                  next.splice(i, 1);
                  onChange(next);
                }}
                disabled={disabled}
                class="text-gray-500 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-60"
                aria-label={t('support.remove_file_aria', 'Remove {filename}', { filename: f.name })}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
