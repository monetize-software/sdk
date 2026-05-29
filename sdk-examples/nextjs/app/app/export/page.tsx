'use client';

import { PaywallGate } from '@monetize.software/sdk-react';

/**
 * Demonstrates PaywallGate with auto-open — going to /app/export
 * as a free user pops the paywall straight away.
 */
export default function ExportPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold">Export</h1>
        <p className="mt-2 text-stone-600 dark:text-stone-400">
          Download your focus history. Auto-opens the paywall for free users.
        </p>
      </header>

      <PaywallGate
        openOnBlocked
        loading={
          <div className="h-40 animate-pulse rounded-2xl bg-stone-200 dark:bg-stone-800" />
        }
        fallback={
          <div className="rounded-2xl border border-stone-200 bg-white p-6 dark:border-stone-800 dark:bg-stone-900">
            <p className="text-sm text-stone-600 dark:text-stone-400">
              Export is a Pro feature. Pick a plan in the paywall to continue.
            </p>
          </div>
        }
      >
        <div className="rounded-2xl border border-stone-200 bg-white p-6 dark:border-stone-800 dark:bg-stone-900">
          <h2 className="text-base font-semibold">Download your data</h2>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
            Choose a format and we'll generate a file on the fly.
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800"
            >
              Download CSV
            </button>
            <button
              type="button"
              className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800"
            >
              Download JSON
            </button>
          </div>
        </div>
      </PaywallGate>
    </div>
  );
}
