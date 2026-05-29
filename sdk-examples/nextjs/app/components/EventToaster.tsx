'use client';

import { useEffect, useState } from 'react';
import { usePaywallEvent } from '@monetize.software/sdk-react';

interface Toast {
  id: number;
  tone: 'success' | 'error' | 'info';
  text: string;
}

let nextId = 1;

/**
 * Demonstrates usePaywallEvent: surfaces purchase/checkout
 * results as ephemeral toasts. Same pattern can be wired to
 * any analytics provider (Mixpanel, PostHog, GA4).
 */
export function EventToaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = (tone: Toast['tone'], text: string) => {
    setToasts((prev) => [...prev, { id: nextId++, tone, text }]);
  };

  usePaywallEvent('purchase_completed', (e) => {
    push(
      'success',
      e.restored
        ? 'Your existing subscription was restored.'
        : 'Welcome to FocusFlow Pro! Your subscription is active.'
    );
  });

  usePaywallEvent('purchase_failed', (e) => {
    push('error', e.reason ? `Checkout cancelled: ${e.reason}` : 'Checkout cancelled.');
  });

  usePaywallEvent('checkout_started', (e) => {
    push('info', `Opening checkout (${e.acquiring ?? 'provider'})…`);
  });

  usePaywallEvent('trial_blocked', () => {
    push('info', 'Trial still active — paywall skipped.');
  });

  usePaywallEvent('visibility_blocked', () => {
    push('info', 'Paywall is hidden in your region.');
  });

  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setTimeout(() => {
      setToasts((prev) => prev.slice(1));
    }, 5000);
    return () => clearTimeout(timer);
  }, [toasts]);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={
            'pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-lg ' +
            tone(t.tone)
          }
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

function tone(t: Toast['tone']): string {
  switch (t) {
    case 'success':
      return 'border-emerald-300 bg-emerald-50 text-emerald-900';
    case 'error':
      return 'border-rose-300 bg-rose-50 text-rose-900';
    default:
      return 'border-stone-300 bg-white text-stone-900';
  }
}
