import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import { Navbar } from './components/Navbar';
import { TrialBanner } from './components/TrialBanner';
import { VisibilityBadge } from './components/VisibilityBadge';
import { EventToaster } from './components/EventToaster';
import { Footer } from './components/Footer';
import './globals.css';

export const metadata: Metadata = {
  title: 'FocusFlow — focus timer that respects your time',
  description:
    'A Pomodoro-style focus timer with a real subscription paywall powered by @monetize.software/sdk-react.'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <Providers>
          <div className="flex min-h-screen flex-col">
            <Navbar />
            <VisibilityBadge />
            <TrialBanner />
            <main className="flex-1">{children}</main>
            <Footer />
          </div>
          <EventToaster />
        </Providers>
      </body>
    </html>
  );
}
