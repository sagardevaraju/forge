'use client';

/**
 * Task 7 (Redesign Phase 1) — LayoutSubBanner.
 *
 * The second of three regions in the global layout shell. Sits directly below
 * the ThreatBanner and provides the persistent navigation chrome plus the
 * persona lens for the page. Holds the FORGE brand link, the three view
 * links (Portfolio · Events · Claims), and the PersonaToggle anchored to
 * the right. Persona state is owned locally for now — Phase 2 (Task P2.18)
 * lifts it into a context provider so downstream content swaps follow the
 * selection.
 *
 * Client component because it owns the persona `useState` and feeds the
 * controlled PersonaToggle.
 */

import { useState } from 'react';
import Link from 'next/link';
import { PersonaToggle, type Persona } from './PersonaToggle';

export function LayoutSubBanner() {
  const [persona, setPersona] = useState<Persona>('cat-ops');
  return (
    <div className="bg-white border-b px-4 py-2 flex items-center gap-4 text-xs">
      <Link href="/" className="font-semibold">FORGE</Link>
      <nav className="flex gap-3 text-zinc-600">
        <Link href="/portfolio" className="hover:text-zinc-900">Portfolio</Link>
        <Link href="/events" className="hover:text-zinc-900">Events</Link>
        <Link href="/claims" className="hover:text-zinc-900">Claims</Link>
      </nav>
      <div className="ml-auto"><PersonaToggle value={persona} onChange={setPersona} /></div>
    </div>
  );
}
