'use client';
import { fmtUSD } from '@/lib/sim/format';

export interface LossHistogram {
  bin_edges: number[];
  counts: number[];
}
export interface LossSummary {
  mean: number; p50: number; p90: number; p99: number;
  tvar99: number; min: number; max: number;
}
export interface LossDistributionProps {
  histogram: LossHistogram;
  summary: LossSummary;
}

export function LossDistribution({ histogram, summary }: LossDistributionProps) {
  const counts = histogram.counts;
  const maxCount = Math.max(...counts, 1);
  const W = 240, H = 64;
  const bw = counts.length > 0 ? W / counts.length : W;
  return (
    <div className="mt-4 flex flex-col gap-2">
      <div className="text-xs uppercase tracking-wider text-zinc-500">
        Loss distribution (K=1000)
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
           aria-label="Loss distribution histogram"
           className="bg-zinc-100 rounded">
        {counts.map((c, i) => {
          const h = (c / maxCount) * (H - 4);
          return <rect key={i} x={i * bw} y={H - h} width={Math.max(bw - 1, 1)}
                       height={h} className="fill-blue-500" />;
        })}
      </svg>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <Stat label="Mean" value={fmtUSD(summary.mean)} />
        <Stat label="P99" value={fmtUSD(summary.p99)} />
        <Stat label="TVaR-99" value={fmtUSD(summary.tvar99)} accent />
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
      <span className={`tabular-nums ${accent ? 'text-red-600 font-semibold' : 'text-zinc-900'}`}>
        {value}
      </span>
    </div>
  );
}
