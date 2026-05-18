'use client';

/**
 * Task 6 (Redesign Phase 1) — PersonaToggle grammar primitive.
 * Task P2.18 (Phase 2) — URL-backed sibling `PersonaToggleUrl`.
 *
 * Segmented control surfaced on the sub-banner that lets the operator pin a
 * persona lens onto the page: cat-ops (default), actuary, reinsurance,
 * field-ops, or academic.
 *
 * Two shapes are exported from this module:
 *
 *   - `PersonaToggle` is the controlled grammar primitive — it renders the
 *     five buttons and emits `onChange`. Parents own the `value`. This is
 *     the original Phase 1 API and remains unchanged so the sub-banner and
 *     the existing test suite keep working.
 *   - `PersonaToggleUrl` (Task P2.18) is the URL-backed wrapper. It reads
 *     `?persona=<id>` via `useSearchParams`, writes back via `useRouter`,
 *     and preserves the rest of the query string + the current `pathname`.
 *     The URL is the single source of truth — refreshing or sharing the
 *     link replays the same view. We intentionally don't mirror into
 *     localStorage; persistence by URL is the value.
 *
 * Both components stay client-only (`'use client'`) because the toggle owns
 * click handlers + URL writes that need React's event system.
 *
 * The `Persona` type is re-exported from `lib/persona/config.ts`, the
 * single source of truth for the persona vocabulary + per-persona ExecCard
 * config. Importing from here remains backwards compatible.
 */

import { useCallback } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import {
  type Persona as PersonaT,
  PERSONAS as PERSONA_META,
  parsePersona,
} from '@/lib/persona/config';

export type Persona = PersonaT;

interface PersonaToggleProps {
  value: Persona;
  onChange: (next: Persona) => void;
  /** Optional class hook so callers can size / pad the segmented control. */
  className?: string;
}

export function PersonaToggle({ value, onChange, className }: PersonaToggleProps) {
  const wrapperClass = [
    'inline-flex border rounded overflow-hidden text-xs',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div role="group" aria-label="persona-toggle" className={wrapperClass}>
      {PERSONA_META.map((p) => {
        const active = value === p.value;
        const buttonClass = active
          ? 'bg-zinc-900 text-white px-2 py-1'
          : 'bg-white text-zinc-700 hover:bg-zinc-100 px-2 py-1';
        return (
          <button
            key={p.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(p.value)}
            className={buttonClass}
            title={p.blurb}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Task P2.18 — URL-backed PersonaToggle. Reads `?persona=` from the URL and
 * writes back through Next's router so a shared link preserves the lens.
 *
 * Implementation notes:
 *   - `parsePersona` falls back to `cat-ops` when the query is missing or
 *     invalid — so the toggle always has a button marked active and the
 *     view never blank-renders.
 *   - We use `router.replace(...)` rather than `router.push(...)` so a
 *     casual lens-flip doesn't bloat the history stack with five entries.
 *   - `scroll: false` keeps the page from snapping to the top when the
 *     operator switches lens mid-scroll.
 */
export function PersonaToggleUrl({ className }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = parsePersona(searchParams?.get('persona'));

  const onChange = useCallback(
    (next: Persona) => {
      // Clone the search params so we preserve other query keys (e.g.
      // ?storm=X) the page might be using alongside ?persona=.
      const params = new URLSearchParams(searchParams?.toString() ?? '');
      if (next === 'cat-ops') {
        // Cat-ops is the default; clear the param rather than persisting it
        // so the URL stays clean for the canonical view.
        params.delete('persona');
      } else {
        params.set('persona', next);
      }
      const qs = params.toString();
      const href = qs ? `${pathname}?${qs}` : pathname;
      router.replace(href, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  return <PersonaToggle value={current} onChange={onChange} className={className} />;
}
