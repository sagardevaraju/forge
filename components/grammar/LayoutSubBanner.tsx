'use client';

/**
 * Global navigation chrome — brand link, the route list, and the persona
 * lens anchored on the right.
 *
 * The persona toggle only renders on routes whose content actually
 * re-shapes per persona (currently `/portfolio` and `/events`). Showing
 * the toggle on routes that ignore persona (e.g. `/treaty`, `/calibration`,
 * `/load`, `/methodology`, `/`) misleads the operator into thinking the
 * lens has an effect when it doesn't. The `?persona=` URL parameter is
 * still preserved across navigation, so a shared link to `/treaty?persona=
 * academic` still works — the toggle simply isn't drawn here.
 *
 * Add a route to `PERSONA_AWARE_ROUTES` once its page reads `?persona=`
 * via `parsePersona` and meaningfully re-shapes content.
 *
 * `PersonaToggleUrl` calls `useSearchParams()` which Next requires inside
 * a Suspense boundary for the static `/404` prerender. The fallback keeps
 * the layout width stable for the brief mount-time gap.
 */

import { Suspense } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PersonaToggleUrl } from './PersonaToggle';

const PERSONA_AWARE_ROUTES = ['/portfolio', '/events'] as const;

function isPersonaAware(pathname: string | null): boolean {
  if (!pathname) return false;
  return PERSONA_AWARE_ROUTES.some(
    (r) => pathname === r || pathname.startsWith(`${r}/`),
  );
}

export function LayoutSubBanner() {
  const pathname = usePathname();
  const showToggle = isPersonaAware(pathname);
  return (
    <div className="bg-white border-b px-4 py-2 flex items-center gap-4 text-xs">
      <Link href="/" className="font-semibold">FORGE</Link>
      <nav className="flex gap-3 text-zinc-600">
        <Link href="/portfolio" className="hover:text-zinc-900">Portfolio</Link>
        <Link href="/events" className="hover:text-zinc-900">Events</Link>
        <Link href="/simulate" className="hover:text-zinc-900">Simulate</Link>
        <Link href="/claims" className="hover:text-zinc-900">Claims</Link>
        <Link href="/calibration" className="hover:text-zinc-900">Calibration</Link>
        <Link href="/treaty" className="hover:text-zinc-900">Treaty</Link>
        <Link href="/load" className="hover:text-zinc-900">Load</Link>
        <Link href="/methodology" className="hover:text-zinc-900">Methodology</Link>
      </nav>
      {showToggle && (
        <div className="ml-auto">
          <Suspense fallback={<div className="inline-block w-[260px] h-[26px]" />}>
            <PersonaToggleUrl />
          </Suspense>
        </div>
      )}
    </div>
  );
}
