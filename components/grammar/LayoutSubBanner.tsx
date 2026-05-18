'use client';

/**
 * Global navigation chrome — brand link, the route list, and the persona
 * lens anchored on the right.
 *
 * The persona toggle is URL-backed (`PersonaToggleUrl`) so this single
 * instance is the source of truth: the page-scoped persona scopes
 * (PortfolioPersonaScope / EventsPersonaScope) only read `?persona=` and
 * re-shape their content, they no longer render a second toggle.
 *
 * `PersonaToggleUrl` calls `useSearchParams()` which Next requires to sit
 * inside a Suspense boundary for the static `/404` prerender. The fallback
 * keeps the layout width stable for the brief mount-time gap.
 */

import { Suspense } from 'react';
import Link from 'next/link';
import { PersonaToggleUrl } from './PersonaToggle';

export function LayoutSubBanner() {
  return (
    <div className="bg-white border-b px-4 py-2 flex items-center gap-4 text-xs">
      <Link href="/" className="font-semibold">FORGE</Link>
      <nav className="flex gap-3 text-zinc-600">
        <Link href="/portfolio" className="hover:text-zinc-900">Portfolio</Link>
        <Link href="/events" className="hover:text-zinc-900">Events</Link>
        <Link href="/claims" className="hover:text-zinc-900">Claims</Link>
        <Link href="/calibration" className="hover:text-zinc-900">Calibration</Link>
        <Link href="/treaty" className="hover:text-zinc-900">Treaty</Link>
        <Link href="/load" className="hover:text-zinc-900">Load</Link>
        <Link href="/methodology" className="hover:text-zinc-900">Methodology</Link>
      </nav>
      <div className="ml-auto">
        <Suspense fallback={<div className="inline-block w-[260px] h-[26px]" />}>
          <PersonaToggleUrl />
        </Suspense>
      </div>
    </div>
  );
}
