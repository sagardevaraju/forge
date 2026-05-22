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

const ROUTES: { href: string; label: string }[] = [
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/events', label: 'Events' },
  { href: '/simulate', label: 'Simulate' },
  { href: '/claims', label: 'Claims' },
  { href: '/calibration', label: 'Calibration' },
  { href: '/treaty', label: 'Treaty' },
  { href: '/load', label: 'Load' },
  { href: '/methodology', label: 'Methodology' },
];

function isPersonaAware(pathname: string | null): boolean {
  if (!pathname) return false;
  return PERSONA_AWARE_ROUTES.some(
    (r) => pathname === r || pathname.startsWith(`${r}/`),
  );
}

function isActive(href: string, pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function LayoutSubBanner() {
  const pathname = usePathname();
  const showToggle = isPersonaAware(pathname);
  return (
    <div className="sticky top-0 z-30 bg-white/85 backdrop-blur supports-[backdrop-filter]:bg-white/70 border-b hairline">
      <div className="mx-auto max-w-[1400px] px-6 h-12 flex items-center gap-6 text-[12.5px]">
        <Link
          href="/"
          className="font-semibold tracking-[0.04em] text-zinc-900 hover:text-zinc-700"
        >
          FORGE
        </Link>
        <nav className="flex items-center gap-1 text-zinc-500" aria-label="Primary">
          {ROUTES.map((r) => {
            const active = isActive(r.href, pathname);
            return (
              <Link
                key={r.href}
                href={r.href}
                aria-current={active ? 'page' : undefined}
                className={
                  active
                    ? 'rounded-md px-2 py-1 text-zinc-900 bg-zinc-100/80 font-medium'
                    : 'rounded-md px-2 py-1 hover:text-zinc-900 hover:bg-zinc-100/60 transition-colors'
                }
              >
                {r.label}
              </Link>
            );
          })}
        </nav>
        {showToggle && (
          <div className="ml-auto">
            <Suspense fallback={<div className="inline-block w-[260px] h-[26px]" />}>
              <PersonaToggleUrl />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}
