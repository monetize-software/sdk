'use client';

import { PaywallGate } from '@monetize.software/sdk-react';

const FREE = [
  { id: 'sand', name: 'Sand', from: '#f5f5f4', to: '#e7e5e4' }
];

const PRO = [
  { id: 'ember', name: 'Ember', from: '#fef3f0', to: '#f17048' },
  { id: 'forest', name: 'Forest', from: '#ecfccb', to: '#15803d' },
  { id: 'midnight', name: 'Midnight', from: '#1e293b', to: '#0f172a' },
  { id: 'rose', name: 'Rose', from: '#ffe4e6', to: '#e11d48' },
  { id: 'ocean', name: 'Ocean', from: '#cffafe', to: '#0e7490' }
];

/**
 * Demonstrates PaywallGate with `openOnBlocked`: when a free user
 * tries the Pro themes section, we automatically launch the paywall.
 * The `loading` fallback prevents flash-of-unlocked content on hydration.
 */
export default function ThemesPage() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold">Themes</h1>
        <p className="mt-2 text-stone-600 dark:text-stone-400">
          Personalise your timer. Six Pro themes unlock with a subscription.
        </p>
      </header>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-stone-500">
          Included free
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {FREE.map((t) => (
            <ThemeCard key={t.id} {...t} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-stone-500">
          Pro themes
        </h2>
        <PaywallGate
          loading={
            <div className="grid gap-3 sm:grid-cols-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="h-24 animate-pulse rounded-2xl bg-stone-200 dark:bg-stone-800"
                />
              ))}
            </div>
          }
          fallback={({ open }) => (
            <div className="rounded-2xl border border-dashed border-stone-300 bg-stone-50 p-8 text-center dark:border-stone-700 dark:bg-stone-950/40">
              <h3 className="font-semibold">Theme pack locked</h3>
              <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
                Five hand-picked themes plus custom CSS for the timer face.
              </p>
              <button
                type="button"
                onClick={open}
                className="mt-4 rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
              >
                Unlock themes
              </button>
            </div>
          )}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            {PRO.map((t) => (
              <ThemeCard key={t.id} {...t} />
            ))}
          </div>
        </PaywallGate>
      </section>
    </div>
  );
}

function ThemeCard({ name, from, to }: { name: string; from: string; to: string }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-stone-200 dark:border-stone-800">
      <div
        className="h-20 w-full"
        style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
      />
      <div className="p-3 text-sm font-medium">{name}</div>
    </div>
  );
}
