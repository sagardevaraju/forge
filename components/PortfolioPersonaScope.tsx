'use client';

/**
 * Persona scope for /portfolio. Reads `?persona=` from the URL and hands
 * the parsed value to `PortfolioWhatIfShell` so its ExecCard strip + rail
 * re-shape per archetype. The persona TOGGLE lives in the global
 * LayoutSubBanner; this scope is read-only.
 *
 * The wrapper does NOT fetch — persona only re-shapes already-loaded
 * artifact data (the server component already pulled the optimization,
 * calibration, and treaty objects).
 */

import { useSearchParams } from 'next/navigation';
import { PortfolioWhatIfShell } from '@/components/PortfolioWhatIfShell';
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
