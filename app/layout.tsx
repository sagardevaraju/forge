import type { Metadata } from 'next';
import './globals.css';
import { LayoutSubBanner } from '@/components/grammar/LayoutSubBanner';

export const metadata: Metadata = {
  title: 'FORGE',
  description: 'Forecast-driven Operational Risk Governance Engine',
};

// ThreatBanner is rendered per-page (currently only /events) so the strip
// reflects the page's actual storm state. A global stub with `stormId={null}`
// previously sat here and conflicted with /events' storm-specific banner —
// both were rendered on the same page, the static "Atlantic basin quiet"
// line stacking above the live "advisory 14A, 142 mph" line. See
// app/events/page.tsx for the active-storm callsite.
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen text-zinc-900 antialiased">
        <LayoutSubBanner />
        <main>{children}</main>
      </body>
    </html>
  );
}
