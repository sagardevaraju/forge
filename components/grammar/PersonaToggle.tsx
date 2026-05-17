'use client';

/**
 * Task 6 (Redesign Phase 1) — PersonaToggle grammar primitive.
 *
 * Segmented control surfaced on the sub-banner that lets the operator pin a
 * persona lens onto the page: cat-ops (default), actuary, reinsurance,
 * field-ops, or academic. Phase 1 ships the primitive only — it renders the
 * five buttons and emits `onChange` as a controlled component. The actual
 * persona-driven content swaps land in Phase 2 (Task P2.18). The cat-ops
 * track is the only persona whose downstream content is wired live; the
 * other four labels are real but their content paths are stubbed until then.
 *
 * This is the sole Phase 1 grammar primitive that is a client component:
 * `aria-pressed` + `onClick` need React's event system, so `'use client'` is
 * required.
 */

export type Persona = 'cat-ops' | 'actuary' | 'reinsurance' | 'field-ops' | 'academic';

const PERSONAS: { value: Persona; label: string }[] = [
  { value: 'cat-ops', label: 'Cat-ops' },
  { value: 'actuary', label: 'Actuary' },
  { value: 'reinsurance', label: 'Reinsurance' },
  { value: 'field-ops', label: 'Field-ops' },
  { value: 'academic', label: 'Academic' },
];

interface PersonaToggleProps {
  value: Persona;
  onChange: (next: Persona) => void;
}

export function PersonaToggle({ value, onChange }: PersonaToggleProps) {
  return (
    <div role="group" aria-label="persona-toggle" className="inline-flex border rounded overflow-hidden text-xs">
      {PERSONAS.map((p) => {
        const active = value === p.value;
        const className = active
          ? 'bg-zinc-900 text-white px-2 py-1'
          : 'bg-white text-zinc-700 hover:bg-zinc-100 px-2 py-1';
        return (
          <button
            key={p.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(p.value)}
            className={className}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
