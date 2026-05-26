'use client';

/**
 * Task P2.16 (Redesign Phase 2) — /calibration view client component.
 *
 * Renders three sections off the cached `artifacts/calibration.json` artifact:
 *
 *   1. Reliability diagrams for the XGB quantile heads (p10, p50, p90). Each
 *      chart plots forecast quantile value (mid of bin) on x against observed
 *      frequency on y, with a horizontal reference line at `y = target_prob`
 *      so deviations from perfect calibration are immediately readable.
 *   2. PIT histogram for the scenario generator — bar chart of `counts` per
 *      bin with a uniform reference line at the average count.
 *   3. CV learning curves — an honest placeholder pending P2.37 (weak-label
 *      retraining). The artifact does not yet ship CV head metrics; rather
 *      than fake them we render a SYNTHETIC_SCAFFOLD-tagged stub with a
 *      ProvenanceFootnote citing the deferred task.
 *
 * Each section composes the Phase 1 grammar primitives — TrustTierBadge to
 * advertise the artifact's `data_source`, ProvenanceFootnote to cite the
 * artifact path + precompute command — so the surface honours the same
 * trust-tier vocabulary as every other view in FORGE.
 *
 * Pure presentational: the server component (`app/calibration/page.tsx`)
 * reads the JSON at request time and passes a typed object in.
 */

import { TrustTierBadge } from '@/components/grammar/TrustTierBadge';
import { ProvenanceFootnote } from '@/components/grammar/ProvenanceFootnote';
import { InfoIcon } from '@/components/grammar/InfoTooltip';
import type { TrustTier } from '@/lib/grammar/trust-tiers';

// ---------------------------------------------------------------------------
// Artifact shape — mirrors `scripts/precompute_calibration.py`. The page-level
// loader narrows the raw JSON into this type before passing it down.

export interface ReliabilityBin {
  forecast_prob: number;
  observed_freq: number;
  forecast_value_mid: number;
  n: number;
}

export interface CalibrationData {
  schema_version: number;
  generated_at: string;
  /** `"live"` once the XGB joblibs ship; `"synthetic_demo"` until then. */
  data_source: 'live' | 'synthetic_demo';
  reliability: {
    p10: ReliabilityBin[];
    p50: ReliabilityBin[];
    p90: ReliabilityBin[];
  };
  pit: {
    scenario_generator: {
      n_bins: number;
      counts: number[];
      data_source: string;
      note: string;
    };
  };
}

// ---------------------------------------------------------------------------
// Chart geometry — inline SVG keeps the page dependency-free. The viewBox is
// chosen so 1 unit ≈ 1 pixel at the default Tailwind width.

const CHART_W = 220;
const CHART_H = 160;
const PAD_L = 32; // left padding for y-axis labels
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 24; // bottom padding for x-axis labels
const PLOT_W = CHART_W - PAD_L - PAD_R;
const PLOT_H = CHART_H - PAD_T - PAD_B;

/** Map a probability in [0, 1] to a SVG y-coordinate. Inverted so 0 is at the
 *  bottom of the plot and 1 is at the top — the natural reading order for a
 *  reliability diagram. */
function probToY(p: number): number {
  const clamped = Math.max(0, Math.min(1, p));
  return PAD_T + (1 - clamped) * PLOT_H;
}

/** Map a value to a SVG x-coordinate given the chart's value range. */
function valueToX(v: number, vMin: number, vMax: number): number {
  if (vMax <= vMin) return PAD_L;
  const t = (v - vMin) / (vMax - vMin);
  return PAD_L + t * PLOT_W;
}

function formatMoney(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

// ---------------------------------------------------------------------------
// Reliability diagram — one per quantile head.

interface ReliabilityChartProps {
  label: 'p10' | 'p50' | 'p90';
  bins: ReliabilityBin[];
  targetProb: number;
}

function ReliabilityChart({ label, bins, targetProb }: ReliabilityChartProps) {
  // X-range is the forecast value bin midpoints; pad the right edge by 5% so
  // the rightmost dot doesn't hug the axis line.
  const values = bins.map((b) => b.forecast_value_mid);
  const vMin = values.length ? Math.min(...values) : 0;
  const vMaxRaw = values.length ? Math.max(...values) : 1;
  const vMax = vMaxRaw + (vMaxRaw - vMin) * 0.05;

  const refY = probToY(targetProb);

  return (
    <div
      data-testid="reliability-chart"
      data-chart-label={label}
      className="border rounded bg-white p-3"
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-zinc-700 uppercase tracking-wide">{label}</span>
        <span className="text-[10px] text-zinc-500">target {targetProb.toFixed(1)}</span>
      </div>
      <svg
        data-testid={`reliability-chart-${label}`}
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="w-full h-auto"
        role="img"
        aria-label={`Reliability diagram for ${label} quantile head`}
      >
        {/* Plot frame */}
        <rect
          x={PAD_L}
          y={PAD_T}
          width={PLOT_W}
          height={PLOT_H}
          fill="none"
          stroke="#e4e4e7"
          strokeWidth={1}
        />
        {/* Y-axis ticks at 0, target, 1 */}
        {[0, targetProb, 1].map((p) => (
          <g key={p}>
            <line
              x1={PAD_L - 3}
              x2={PAD_L}
              y1={probToY(p)}
              y2={probToY(p)}
              stroke="#a1a1aa"
              strokeWidth={1}
            />
            <text
              x={PAD_L - 5}
              y={probToY(p)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={8}
              fill="#71717a"
            >
              {p.toFixed(1)}
            </text>
          </g>
        ))}
        {/* X-axis tick labels at vMin and vMax */}
        <text
          x={PAD_L}
          y={CHART_H - PAD_B + 12}
          fontSize={8}
          textAnchor="start"
          fill="#71717a"
        >
          {formatMoney(vMin)}
        </text>
        <text
          x={PAD_L + PLOT_W}
          y={CHART_H - PAD_B + 12}
          fontSize={8}
          textAnchor="end"
          fill="#71717a"
        >
          {formatMoney(vMaxRaw)}
        </text>
        {/* Perfect-calibration reference line (horizontal at y = target_prob) */}
        <line
          data-testid="perfect-calibration-line"
          data-target-prob={String(targetProb)}
          x1={PAD_L}
          x2={PAD_L + PLOT_W}
          y1={refY}
          y2={refY}
          stroke="#94a3b8"
          strokeWidth={1}
          strokeDasharray="3 2"
        />
        {/* Observed-frequency dots — radius scaled by sqrt(n) so small bins
            don't dominate visually. */}
        {bins.map((b, i) => {
          const r = Math.max(2, Math.min(5, Math.sqrt(b.n) / 3));
          return (
            <circle
              key={i}
              data-testid="reliability-point"
              cx={valueToX(b.forecast_value_mid, vMin, vMax)}
              cy={probToY(b.observed_freq)}
              r={r}
              fill="#2563eb"
              fillOpacity={0.85}
            />
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PIT histogram — bar chart with a uniform reference line at the average count.

interface PitHistogramProps {
  counts: number[];
}

function PitHistogram({ counts }: PitHistogramProps) {
  const total = counts.reduce((s, c) => s + c, 0);
  const uniform = counts.length > 0 ? total / counts.length : 0;
  const maxRaw = counts.length ? Math.max(...counts) : 1;
  // Always include the uniform line in the y-range so the dashed reference
  // never gets clipped, and pad the top by 10%.
  const yMax = Math.max(maxRaw, uniform) * 1.1;
  const barW = PLOT_W / Math.max(1, counts.length);
  const refY = PAD_T + (1 - (yMax > 0 ? uniform / yMax : 0)) * PLOT_H;

  return (
    <svg
      data-testid="pit-histogram"
      viewBox={`0 0 ${CHART_W * 1.5} ${CHART_H}`}
      preserveAspectRatio="xMidYMid meet"
      className="w-full h-auto"
      role="img"
      aria-label="PIT histogram for the scenario generator"
    >
      {/* Plot frame */}
      <rect
        x={PAD_L}
        y={PAD_T}
        width={PLOT_W}
        height={PLOT_H}
        fill="none"
        stroke="#e4e4e7"
        strokeWidth={1}
      />
      {/* Y-axis label */}
      <text x={PAD_L - 5} y={PAD_T} textAnchor="end" fontSize={8} fill="#71717a">
        {Math.round(yMax)}
      </text>
      <text x={PAD_L - 5} y={PAD_T + PLOT_H} textAnchor="end" fontSize={8} fill="#71717a">
        0
      </text>
      {/* Uniform reference line — what perfectly calibrated PIT looks like. */}
      <line
        data-testid="pit-uniform-line"
        x1={PAD_L}
        x2={PAD_L + PLOT_W}
        y1={refY}
        y2={refY}
        stroke="#94a3b8"
        strokeWidth={1}
        strokeDasharray="3 2"
      />
      {counts.map((c, i) => {
        const h = yMax > 0 ? (c / yMax) * PLOT_H : 0;
        const x = PAD_L + i * barW;
        const y = PAD_T + (PLOT_H - h);
        return (
          <rect
            key={i}
            data-testid="pit-bar"
            data-bin={i}
            data-count={c}
            x={x + 1}
            y={y}
            width={Math.max(1, barW - 2)}
            height={h}
            fill="#10b981"
            fillOpacity={0.85}
          />
        );
      })}
      {/* X-axis label range */}
      <text
        x={PAD_L}
        y={CHART_H - PAD_B + 12}
        textAnchor="start"
        fontSize={8}
        fill="#71717a"
      >
        0.0
      </text>
      <text
        x={PAD_L + PLOT_W}
        y={CHART_H - PAD_B + 12}
        textAnchor="end"
        fontSize={8}
        fill="#71717a"
      >
        1.0
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Top-level view.

const RELIABILITY_HEADS: { label: 'p10' | 'p50' | 'p90'; target: number }[] = [
  { label: 'p10', target: 0.1 },
  { label: 'p50', target: 0.5 },
  { label: 'p90', target: 0.9 },
];

interface CalibrationViewProps {
  data: CalibrationData;
}

export function CalibrationView({ data }: CalibrationViewProps) {
  const trustTier: TrustTier = data.data_source === 'live' ? 'MODEL_OUTPUT' : 'SYNTHETIC_SCAFFOLD';
  const dataSourceLabel = data.data_source === 'live' ? 'live' : 'synthetic_demo';
  const generatedAt = data.generated_at;

  const pit = data.pit.scenario_generator;
  // PIT artifact carries its own data_source flag (`synthetic_placeholder`
  // until P2.10 / P2.38 land); promote it to a trust tier independent of the
  // reliability source.
  const pitTier: TrustTier =
    pit.data_source === 'live' ? 'MODEL_OUTPUT' : 'SYNTHETIC_SCAFFOLD';

  return (
    <div className="flex flex-col gap-6">
      {/* ---------------- Reliability diagrams (p10 / p50 / p90) ---------------- */}
      <section data-testid="reliability-section" className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">
            <span className="inline-flex items-center gap-1">
              Reliability <InfoIcon term="reliability-diagram" iconSize="sm" />, XGB quantile heads <InfoIcon term="quantile-head" iconSize="sm" />
            </span>
          </h2>
          <TrustTierBadge tier={trustTier} />
        </div>
        <p className="text-xs text-zinc-600">
          Each dot is one forecast-value bin. The dashed line marks the target probability
          (perfect calibration). Dots above the line over-cover, dots below under-cover.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {RELIABILITY_HEADS.map(({ label, target }) => (
            <ReliabilityChart
              key={label}
              label={label}
              bins={data.reliability[label]}
              targetProb={target}
            />
          ))}
        </div>
        <ProvenanceFootnote
          source="artifacts/calibration.json (reliability_curve from api_py/calibration.py)"
          method="python -m scripts.precompute_calibration"
          confidence={`data_source: ${dataSourceLabel} · generated ${generatedAt}`}
        />
      </section>

      {/* ---------------- PIT histogram ---------------- */}
      <section data-testid="pit-section" className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">
            <span className="inline-flex items-center gap-1">PIT histogram <InfoIcon term="pit" iconSize="sm" />, scenario generator</span>
          </h2>
          <TrustTierBadge tier={pitTier} />
        </div>
        <p className="text-xs text-zinc-600">
          Probability-integral-transform bin counts. A flat (uniform) histogram indicates a
          well-calibrated generative model. The dashed line is the uniform reference.
        </p>
        <div className="border rounded bg-white p-3">
          <PitHistogram counts={pit.counts} />
        </div>
        <ProvenanceFootnote
          source="artifacts/calibration.json (pit_histogram from api_py/calibration.py)"
          method="python -m scripts.precompute_calibration"
          confidence={`data_source: ${pit.data_source} · ${pit.note}`}
        />
      </section>

      {/* ---------------- CV learning curves — deferred to P2.37 ---------------- */}
      <section data-testid="cv-section" className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">CV head learning curves</h2>
          <TrustTierBadge tier="SYNTHETIC_SCAFFOLD" />
        </div>
        <div className="border border-dashed rounded bg-white p-6 text-sm text-zinc-500 grid place-items-center text-center">
          <div>
            <div className="font-medium text-zinc-700 mb-1">Awaiting CV training history.</div>
            <div className="text-xs">
              Per-dim learning curves for the CV head land in <span className="font-mono">P2.37</span>{' '}
              (weak-label retraining sub-plan). This section is intentionally empty until then.
              The artifact does not yet carry CV training history.
            </div>
          </div>
        </div>
        <ProvenanceFootnote
          source="artifacts/calibration.json (no CV section in schema_version 1)"
          method="deferred. P2.37 (weak-label retraining sub-plan) will extend the artifact"
          confidence="not yet measured"
        />
      </section>
    </div>
  );
}
