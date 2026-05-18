'use client';

/**
 * Persona scope for /events. Reads `?persona=` from the URL and surfaces
 * the persona's quick-links band above the EventConsole. The EventConsole
 * itself doesn't re-shape per persona — what changes is the supporting
 * drill-in surface (Actuary → /calibration, Reinsurance → /treaty, etc).
 *
 * The persona TOGGLE lives in the global LayoutSubBanner; this scope is
 * read-only. When the persona has no configured quick-links the band
 * collapses to nothing.
 */

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { parsePersona, getPersonaConfig } from '@/lib/persona/config';

export function EventsPersonaScope() {
  const searchParams = useSearchParams();
  const persona = parsePersona(searchParams?.get('persona'));
  const config = getPersonaConfig(persona);
  if (config.quickLinks.length === 0) return null;
  return (
    <div
      data-testid="events-persona-scope"
      data-persona={persona}
      className="flex items-center gap-3 px-4 py-2 bg-white border-b text-xs"
    >
      <div
        data-testid="persona-quick-links"
        className="flex flex-wrap gap-2"
        aria-label="Persona quick-links"
      >
        <span className="text-zinc-500 uppercase tracking-wide">Drill-in:</span>
        {config.quickLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="text-blue-700 hover:text-blue-900 underline"
          >
            {link.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
