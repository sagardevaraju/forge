'use client';

export interface SimListItem {
  id: string;
  name: string;
  peril: string;
  intensity: string;
  promoted: boolean;
  retired: boolean;
  drawn_at: string;
}

export interface SimLibraryProps {
  sims: SimListItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

function badge(sim: SimListItem): { label: string; cls: string } {
  if (sim.retired) return { label: 'RETIRED', cls: 'bg-zinc-100 text-zinc-400' };
  if (sim.promoted) return { label: 'PROMOTED', cls: 'bg-emerald-100 text-emerald-800' };
  return { label: 'DRAFT', cls: 'bg-zinc-100 text-zinc-600' };
}

export function SimLibrary({ sims, activeId, onSelect }: SimLibraryProps) {
  if (sims.length === 0) {
    return <div className="text-sm text-zinc-500">No saved sims yet — pick a peril to start.</div>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs uppercase tracking-wider text-zinc-500 mt-4 mb-1">Saved sims ({sims.length})</div>
      {sims.map((s) => {
        const b = badge(s);
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            aria-current={activeId === s.id ? 'true' : undefined}
            className={`text-left px-2 py-1.5 rounded border ${
              activeId === s.id ? 'border-blue-500 bg-blue-50' : 'border-zinc-200 hover:border-zinc-300'
            }`}
          >
            <div className="text-sm text-zinc-900">{s.name}</div>
            <div className="text-xs text-zinc-500 mt-1 flex items-center gap-2">
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${b.cls}`}>{b.label}</span>
              <span aria-hidden>·</span>
              <span>{new Date(s.drawn_at).toLocaleDateString()}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
