import type { Metadata } from 'next';
import './globals.css';
import { ThreatBanner } from '@/components/grammar/ThreatBanner';
import { LayoutSubBanner } from '@/components/grammar/LayoutSubBanner';

export const metadata: Metadata = {
  title: 'FORGE',
  description: 'Forecast-driven Operational Risk Governance Engine',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-50 text-zinc-900">
        <ThreatBanner stormId={null} />
        <LayoutSubBanner />
        <main>{children}</main>
      </body>
    </html>
  );
}
