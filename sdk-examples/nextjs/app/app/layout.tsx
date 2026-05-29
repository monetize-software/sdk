'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { usePaywallAccess } from '@monetize.software/sdk-react';

const tabs = [
  { href: '/app', label: 'Timer' },
  { href: '/app/stats', label: 'Stats', pro: true },
  { href: '/app/themes', label: 'Themes', pro: true },
  { href: '/app/export', label: 'Export', pro: true }
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const access = usePaywallAccess();
  const isPro =
    access.status === 'ready' && access.result.access === 'granted';

  return (
    <div className="mx-auto flex max-w-6xl flex-col px-6 py-8 sm:flex-row sm:gap-8">
      <aside className="mb-6 sm:mb-0 sm:w-48 sm:flex-shrink-0">
        <nav className="flex flex-row gap-1 overflow-x-auto sm:flex-col">
          {tabs.map((tab) => {
            const active =
              tab.href === '/app'
                ? pathname === '/app'
                : pathname.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={
                  'flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-medium ' +
                  (active
                    ? 'bg-stone-900 text-white dark:bg-white dark:text-stone-950'
                    : 'text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-900')
                }
              >
                <span>{tab.label}</span>
                {tab.pro && !isPro && (
                  <span className="rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-800">
                    Pro
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </aside>
      <section className="flex-1">{children}</section>
    </div>
  );
}
