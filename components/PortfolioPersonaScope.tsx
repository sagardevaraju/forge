'use client';

/**
 * Task P2.18 (Redesign Phase 2) — Persona scope for /portfolio.
 *
 * Thin client wrapper that:
 *   1. Reads `?persona=<id>` from the URL (single source of truth).
 *   2. Renders the URL-backed `PersonaToggleUrl` so the operator can pin
 *      the lens.
 *   3. Hands the parsed persona down to `PortfolioWhatIfShell` so the
 *      headline ExecCard strip + quick-links + what-if rail re-shape
 *      themselves for the selected archetype.
 *
 * All persona-driven data is passed in as props from the server component
 * (which already loaded the optimization, calibration, and treaty
 * artifacts). The wrapper does NOT fetch — that's a deliberate constraint
 * of P2.18: persona is RE-SHAPING, not RE-FETCHING.
 */

import { useSearchParams } from 'next/navigation';
import { PortfolioWhatIfShell } from '@/components/PortfolioWhatIfShell';
import { PersonaToggleUrl } from '@/components/grammar/PersonaToggle';
import { parsePersona } from '@/lib/persona/config';
import type { PortfolioOptimization } from '@/lib/portfolio-actions';

interface Props {
  initialOptimization: PortfolioOptimization;
  totalTiv: number;
  rolLayers?: { type: string; rol: number; attachment?: number }[];
  crps?: number;
  saaGap?: number;
  vrpDemand?: number;
}

export function PortfolioPersonaScope({
  initialOptimization,
  totalTiv,
  rolLayers,
  crps,
  saaGap,
  vrpDemand,
}: Props) {
  const searchParams = useSearchParams();
  const persona = parsePersona(searchParams?.get('persona'));
  return (
    <div data-testid="portfolio-persona-scope" data-persona={persona}>
      <div className="flex justify-end mb-3">
        <PersonaToggleUrl />
      </div>
      <PortfolioWhatIfShell
        initialOptimization={initialOptimization}
        totalTiv={totalTiv}
        persona={persona}
        rolLayers={rolLayers}
        crps={crps}
        saaGap={saaGap}
        vrpDemand={vrpDemand}
      />
    </div>
  );
}
