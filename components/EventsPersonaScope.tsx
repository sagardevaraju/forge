'use client';

/**
 * Task P2.18 (Redesign Phase 2) — Persona scope for /events.
 *
 * Renders the URL-backed `PersonaToggleUrl` and surfaces persona-specific
 * quick-links above the EventConsole. The EventConsole itself doesn't
 * re-shape per persona for P2.18 — its map, sitrep, and chat panels are
 * the same across lenses. What changes is the supporting drill-in surface
 * the persona reaches for: an Actuary jumps to /calibration, a
 * Reinsurance lead to /treaty, a Field-ops manager to /claims, etc.
 *
 * State source: `?persona=<id>` from the URL. Mounting this component on
 * /events means a shared link with `?persona=reinsurance` lands a treaty
 * lead on the storm view with /treaty already one click away.
 */

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { PersonaToggleUrl } from '@/components/grammar/PersonaToggle';
import { parsePersona, getPersonaConfig } from '@/lib/persona/config';

export function EventsPersonaScope() {
  const searchParams = useSearchParams();
  const persona = parsePersona(searchParams?.get('persona'));
  const config = getPersonaConfig(persona);
  return (
    <div
      data-testid="events-persona-scope"
      data-persona={persona}
      className="flex items-center justify-end gap-3 px-4 py-2 bg-white border-b text-xs"
    >
      {config.quickLinks.length > 0 && (
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
      )}
      <PersonaToggleUrl />
    </div>
  );
}
