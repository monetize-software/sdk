'use client';

import { useEffect, useRef, useState } from 'react';
import {
  PaywallGate,
  PaywallButton,
  usePaywall,
  usePaywallAccess
} from '@monetize.software/sdk-react';

const FREE_PRESETS = [
  { id: 'classic', label: 'Classic 25/5', focusMin: 25, breakMin: 5 },
  { id: 'long', label: 'Long 50/10', focusMin: 50, breakMin: 10 },
  { id: 'sprint', label: 'Sprint 15/3', focusMin: 15, breakMin: 3 }
];

/**
 * Demonstrates:
 *  - usePaywall      — direct handle; tracks custom analytics events.
 *  - usePaywallAccess — read-only gate decision for inline UI.
 *  - PaywallGate     — wraps premium-only features (custom timer).
 */
export default function AppHome() {
  const [presetId, setPresetId] = useState('classic');
  const preset = FREE_PRESETS.find((p) => p.id === presetId) ?? FREE_PRESETS[0];
  const paywall = usePaywall();
  const access = usePaywallAccess();
  const isPro = access.status === 'ready' && access.result.access === 'granted';

  const [secondsLeft, setSecondsLeft] = useState(preset.focusMin * 60);
  const [running, setRunning] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setSecondsLeft(preset.focusMin * 60);
    setRunning(false);
  }, [presetId, preset.focusMin]);

  useEffect(() => {
    if (!running) return;
    intervalRef.current = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [running]);

  const start = () => {
    paywall?.track('host:focus_session_started', { preset: preset.id });
    setRunning(true);
  };
  const pause = () => setRunning(false);
  const reset = () => {
    setRunning(false);
    setSecondsLeft(preset.focusMin * 60);
  };

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss = String(secondsLeft % 60).padStart(2, '0');

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl font-bold">Focus session</h1>
        <p className="mt-2 text-stone-600 dark:text-stone-400">
          {isPro
            ? "You're on Pro — build any preset you like."
            : 'Free tier: pick one of three presets to start a session.'}
        </p>
      </header>

      <section className="rounded-3xl border border-stone-200 bg-white p-10 text-center shadow-sm dark:border-stone-800 dark:bg-stone-900">
        <div className="text-sm uppercase tracking-wide text-stone-500">
          {preset.label}
        </div>
        <div className="mt-2 font-mono text-7xl font-bold tabular-nums sm:text-8xl">
          {mm}:{ss}
        </div>
        <div className="mt-6 flex items-center justify-center gap-3">
          {running ? (
            <button
              type="button"
              onClick={pause}
              className="rounded-full bg-stone-900 px-6 py-2 text-sm font-semibold text-white dark:bg-white dark:text-stone-950"
            >
              Pause
            </button>
          ) : (
            <button
              type="button"
              onClick={start}
              className="rounded-full bg-brand-500 px-6 py-2 text-sm font-semibold text-white hover:bg-brand-600"
            >
              {secondsLeft === preset.focusMin * 60 ? 'Start focus' : 'Resume'}
            </button>
          )}
          <button
            type="button"
            onClick={reset}
            className="rounded-full border border-stone-300 px-6 py-2 text-sm font-semibold hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-900"
          >
            Reset
          </button>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Presets</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {FREE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPresetId(p.id)}
              className={
                'rounded-xl border p-4 text-left text-sm transition ' +
                (p.id === presetId
                  ? 'border-brand-500 bg-brand-50 text-brand-900 dark:bg-brand-900/30 dark:text-brand-100'
                  : 'border-stone-200 bg-white hover:border-stone-400 dark:border-stone-800 dark:bg-stone-900')
              }
            >
              <div className="font-semibold">{p.label}</div>
              <div className="text-xs text-stone-500">
                {p.focusMin}m focus · {p.breakMin}m break
              </div>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Custom presets</h2>
        <PaywallGate
          loading={
            <div className="h-32 animate-pulse rounded-2xl bg-stone-200 dark:bg-stone-800" />
          }
          fallback={({ open }) => (
            <div className="rounded-2xl border border-dashed border-stone-300 bg-stone-50 p-8 text-center dark:border-stone-700 dark:bg-stone-950/40">
              <div className="text-base font-semibold">Build your own timing</div>
              <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
                Pro unlocks unlimited presets and a 5-second granularity.
              </p>
              <button
                type="button"
                onClick={open}
                className="mt-4 rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
              >
                Upgrade to Pro
              </button>
            </div>
          )}
        >
          <CustomPresets />
        </PaywallGate>
      </section>

      {!isPro && (
        <section className="rounded-2xl bg-stone-100 p-6 text-sm dark:bg-stone-900">
          <p className="text-stone-600 dark:text-stone-400">
            FocusFlow Pro unlocks unlimited presets, themes, full history and CSV
            export.
          </p>
          <PaywallButton className="mt-3 inline-flex rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white dark:bg-white dark:text-stone-950">
            See what's in Pro
          </PaywallButton>
        </section>
      )}
    </div>
  );
}

function CustomPresets() {
  return (
    <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-6 dark:border-emerald-800 dark:bg-emerald-950/30">
      <div className="text-sm font-semibold text-emerald-900 dark:text-emerald-100">
        Pro — custom presets
      </div>
      <p className="mt-1 text-sm text-emerald-800 dark:text-emerald-200">
        Add focus blocks down to the second. (Editor stubbed for the demo.)
      </p>
    </div>
  );
}
