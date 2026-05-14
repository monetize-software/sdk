import { useMemo, useRef, useState } from 'preact/hooks';
import type { BillingClient } from '../core/BillingClient';
import type { AuthSession } from '../core/auth';
import { PaywallError } from '../core/types';

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
    if (!e) next.email = 'Required';
    else if (!EMAIL_RE.test(e.toLowerCase())) next.email = 'Invalid email';
    if (s.length < SUBJECT_MIN || s.length > SUBJECT_MAX) {
      next.subject = `${SUBJECT_MIN}–${SUBJECT_MAX} characters`;
    }
    if (m.length < 1 || m.length > CONTENT_MAX) {
      next.message = `1–${CONTENT_MAX} characters`;
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

  if (submittedEmail) {
    return (
      <div class="flex flex-col items-center gap-4 py-2 text-center">
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
        <div class="text-lg font-semibold tracking-tight text-gray-900">Request submitted</div>
        <div class="max-w-[320px] text-sm leading-relaxed text-gray-500">
          We&apos;ve received your message and will respond to{' '}
          <b class="text-gray-700">{submittedEmail}</b>.
        </div>
        <div class="mt-2 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={onBack}
            class="rounded-xl px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
          >
            {origin === 'standalone' ? 'Done' : 'Back'}
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
            Send another request
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          class="-ml-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
        >
          ← {origin === 'standalone' ? 'Close' : 'Back'}
        </button>
      </div>
      <h2 class="text-lg font-semibold tracking-tight text-gray-900">Contact Support</h2>
      <p class="text-xs leading-relaxed text-gray-500">
        Fill out the form below and we&apos;ll get back to you.
      </p>

      <form onSubmit={onSubmit} class="flex flex-col gap-3">
        {!lockedEmail ? (
          <Field
            type="email"
            label="Your email"
            value={email}
            onInput={setEmail}
            error={errors.email}
            autocomplete="email"
            required
          />
        ) : (
          <div class="rounded-xl border border-gray-200 bg-gray-50/60 px-3 py-2 text-xs text-gray-500">
            Sending as <b class="font-medium text-gray-700">{lockedEmail}</b>
          </div>
        )}
        <Field
          type="text"
          label="Subject"
          value={subject}
          onInput={setSubject}
          error={errors.subject}
          required
        />
        <TextareaField
          label="Message"
          value={message}
          onInput={setMessage}
          error={errors.message}
          required
        />

        <Dropzone files={files} onChange={setFiles} disabled={submitting} />

        {errors.submit && <p class="text-xs text-red-600">{errors.submit}</p>}

        <div class="mt-1 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onBack}
            disabled={submitting}
            class="rounded-xl px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
          >
            {origin === 'standalone' ? 'Close' : 'Back'}
          </button>
          <button
            type="submit"
            disabled={!isValid || submitting}
            class="flex h-10 items-center justify-center rounded-xl px-4 text-sm font-semibold text-white transition-all hover:-translate-y-px hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:brightness-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]"
            style={{
              background:
                'linear-gradient(180deg, color-mix(in srgb, var(--pw-accent) 92%, white), var(--pw-accent))',
              boxShadow:
                '0 1px 2px rgba(15,23,42,0.08), 0 6px 14px -4px color-mix(in srgb, var(--pw-accent) 50%, transparent)'
            }}
          >
            {submitting ? (
              <span class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            ) : (
              'Send'
            )}
          </button>
        </div>
      </form>
    </div>
  );
}

interface FieldProps {
  type: 'email' | 'text';
  label: string;
  value: string;
  onInput: (v: string) => void;
  error?: string;
  autocomplete?: string;
  required?: boolean;
}

function Field({ type, label, value, onInput, error, autocomplete, required }: FieldProps) {
  return (
    <label class="flex flex-col gap-1.5">
      <span class="text-xs font-medium text-gray-700">{label}</span>
      <input
        type={type}
        value={value}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        autocomplete={autocomplete}
        required={required}
        class={`h-11 w-full rounded-xl border bg-white px-3.5 text-sm text-gray-900 shadow-[0_1px_0_rgba(15,23,42,0.02)] outline-none transition-all placeholder:text-gray-400 ${
          error
            ? 'border-red-400 focus:border-red-500 focus:shadow-[0_0_0_3px_rgba(239,68,68,0.18)]'
            : 'border-gray-200 hover:border-gray-300 focus:border-[var(--pw-accent)] focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--pw-accent)_18%,transparent)]'
        }`}
      />
      {error && <span class="text-xs text-red-600">{error}</span>}
    </label>
  );
}

interface TextareaFieldProps {
  label: string;
  value: string;
  onInput: (v: string) => void;
  error?: string;
  required?: boolean;
}

function TextareaField({ label, value, onInput, error, required }: TextareaFieldProps) {
  return (
    <label class="flex flex-col gap-1.5">
      <span class="text-xs font-medium text-gray-700">{label}</span>
      <textarea
        value={value}
        onInput={(e) => onInput((e.target as HTMLTextAreaElement).value)}
        required={required}
        rows={4}
        class={`min-h-[104px] w-full rounded-xl border bg-white px-3.5 py-2.5 text-sm leading-relaxed text-gray-900 shadow-[0_1px_0_rgba(15,23,42,0.02)] outline-none transition-all placeholder:text-gray-400 ${
          error
            ? 'border-red-400 focus:border-red-500 focus:shadow-[0_0_0_3px_rgba(239,68,68,0.18)]'
            : 'border-gray-200 hover:border-gray-300 focus:border-[var(--pw-accent)] focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--pw-accent)_18%,transparent)]'
        }`}
      />
      {error && <span class="text-xs text-red-600">{error}</span>}
    </label>
  );
}

interface DropzoneProps {
  files: File[];
  onChange: (next: File[]) => void;
  disabled?: boolean;
}

function Dropzone({ files, onChange, disabled }: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = (incoming: FileList | null): void => {
    if (!incoming || disabled) return;
    setError(null);
    const arr = Array.from(incoming);
    if (files.length + arr.length > MAX_FILES) {
      setError(`Up to ${MAX_FILES} files`);
      return;
    }
    const valid = arr.filter(
      (f) => ACCEPTED_MIME.includes(f.type) && f.size <= MAX_FILE_SIZE
    );
    if (valid.length !== arr.length) {
      setError('Only JPEG/PNG/WebP, ≤ 10MB each');
      return;
    }
    onChange([...files, ...valid]);
  };

  return (
    <div>
      <span class="text-xs font-medium text-gray-700">Attachments (optional)</span>
      <div
        role="button"
        tabIndex={0}
        aria-label="Attachments upload"
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
        <div class="text-xs text-gray-500">Drop images here or click to select</div>
        <div class="mt-0.5 text-[11px] text-gray-400">
          JPEG/PNG/WebP, up to {MAX_FILES} files, ≤ 10MB each
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
                aria-label={`Remove ${f.name}`}
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
