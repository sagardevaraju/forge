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
  if (sim.retired) return { label: 'RETIRED', cls: 'bg-slate-700 text-slate-400' };
  if (sim.promoted) return { label: 'PROMOTED', cls: 'bg-emerald-900 text-emerald-300' };
  return { label: 'DRAFT', cls: 'bg-slate-700 text-slate-300' };
}

export function SimLibrary({ sims, activeId, onSelect }: SimLibraryProps) {
  if (sims.length === 0) {
    return <div className="text-sm text-slate-400">No saved sims yet — pick a peril to start.</div>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs uppercase tracking-wider text-slate-400 mt-4 mb-1">Saved sims ({sims.length})</div>
      {sims.map((s) => {
        const b = badge(s);
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            aria-current={activeId === s.id ? 'true' : undefined}
            className={`text-left px-2 py-1.5 rounded border ${
              activeId === s.id ? 'border-blue-500 bg-slate-800' : 'border-slate-800 hover:border-slate-700'
            }`}
          >
            <div className="text-sm text-slate-200">{s.name}</div>
            <div className="text-xs text-slate-400 mt-1 flex items-center gap-2">
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
