'use client';

/**
 * Task P2.17 (Redesign Phase 2) — Treaty ladder client component.
 *
 * Renders the reinsurance stack from `artifacts/treaty.json` as a vertical
 * SVG bar chart with one horizontal band per layer:
 *
 *   • QS layer  — neutral slate band beneath the XS column. Annotated with
 *                 the QS share ("50% QS share"). Drawn from `$0` up to a
 *                 visual slice of the column so the share is legible
 *                 without claiming the QS itself has an "attachment".
 *   • XS layers — emerald bands stacked from attachment to exhaustion.
 *                 Darker shades higher up the column. Each band is
 *                 annotated with its dollar range, RoL %, and the count
 *                 of reinstatements remaining.
 *
 * A dashed reference line at `book_p99` shows where the carrier's tail
 * exposure sits relative to the placed cover.
 *
 * The component is interactive (hover-tooltips on each band via the
 * native SVG `<title>` element), hence `'use client'`. No new chart deps
 * — inline SVG matches the P2.16 calibration view precedent.
 *
 * TrustTierBadge + ProvenanceFootnote come straight from the Phase 1
 * grammar so the page advertises its `data_source` consistently.
 */

import { TrustTierBadge } from '@/components/grammar/TrustTierBadge';
import { ProvenanceFootnote } from '@/components/grammar/ProvenanceFootnote';
import type { TrustTier } from '@/lib/grammar/trust-tiers';
import type { TreatyStack, XSLayer, QSLayer } from '@/lib/treaty/types';

// ---------------------------------------------------------------------------
// Chart geometry — inline SVG, no chart-library dependency.

const CHART_W = 480;
const CHART_H = 360;
const PAD_L = 64; // wider than the calibration view to fit "$120M" tick labels
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 32;
const PLOT_W = CHART_W - PAD_L - PAD_R;
const PLOT_H = CHART_H - PAD_T - PAD_B;

/** Format dollars as $M with one decimal when < 10M, else integer M. */
function formatMoneyM(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e7) return `$${Math.round(n / 1e6)}M`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

/** Round a dollar value to the nearest $1M for annotation. */
function roundToMillion(n: number): string {
  return `$${Math.round(n / 1e6)}M`;
}

// ---------------------------------------------------------------------------
// Color palette — slate for QS, three emerald shades for XS layers from
// lowest to highest attachment. The Tailwind palette is hard-coded here so
// the SVG can use raw hex values; the visual hierarchy "darker = higher in
// the stack = rarer hit = more capital-protective" is encoded by index.

const QS_FILL = '#cbd5e1'; // slate-300
const XS_FILLS = ['#34d399', '#10b981', '#047857', '#064e3b']; // emerald 400→900

function xsFill(idx: number): string {
  return XS_FILLS[Math.min(idx, XS_FILLS.length - 1)];
}

// ---------------------------------------------------------------------------
// Inner SVG ladder.

interface LadderSvgProps {
  stack: TreatyStack;
  /** Top of the dollar axis. Always >= max(layer exhaustion, book_p99). */
  yMax: number;
}

function dollarsToY(d: number, yMax: number): number {
  if (yMax <= 0) return PAD_T + PLOT_H;
  const clamped = Math.max(0, Math.min(yMax, d));
  // SVG y grows downward, so $0 sits at the bottom of the plot and `yMax`
  // sits at the top.
  return PAD_T + (1 - clamped / yMax) * PLOT_H;
}

function LadderSvg({ stack, yMax }: LadderSvgProps) {
  const xsLayers = stack.layers.filter((l): l is XSLayer => l.type === 'xs');
  const qsLayer = stack.layers.find((l): l is QSLayer => l.type === 'qs') ?? null;

  // QS visual band — drawn as a fixed slice at the bottom of the column so
  // the share is legible. It has no dollar range; the height is the share
  // times a visual budget of 12% of plot height to keep it from dominating
  // the column when there are few XS layers.
  const qsBandHeight = qsLayer ? Math.max(12, PLOT_H * 0.08) : 0;
  const qsY = PAD_T + PLOT_H - qsBandHeight;

  // Sort the XS layers from highest to lowest attachment so darker shades
  // (higher index in XS_FILLS) end up at the top of the column, matching
  // the "darker as attachment grows" colour direction in the brief.
  const xsByAttachment = [...xsLayers].sort((a, b) => a.attachment - b.attachment);

  const refY = dollarsToY(stack.book_p99, yMax);

  // Y-axis tick values — 0, every $25M up to yMax (capped at 6 ticks).
  const tickStep = (() => {
    if (yMax >= 200e6) return 50e6;
    if (yMax >= 100e6) return 25e6;
    if (yMax >= 40e6) return 10e6;
    return 5e6;
  })();
  const ticks: number[] = [];
  for (let t = 0; t <= yMax + 1e-9; t += tickStep) ticks.push(t);

  return (
    <svg
      data-testid="treaty-ladder-svg"
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      className="w-full h-auto"
      role="img"
      aria-label="Treaty ladder — attachment / exhaustion per layer with book p99 reference"
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
      {/* Y-axis ticks */}
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={PAD_L - 4}
            x2={PAD_L}
            y1={dollarsToY(t, yMax)}
            y2={dollarsToY(t, yMax)}
            stroke="#a1a1aa"
            strokeWidth={1}
          />
          <text
            x={PAD_L - 6}
            y={dollarsToY(t, yMax)}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize={10}
            fill="#71717a"
          >
            {formatMoneyM(t)}
          </text>
        </g>
      ))}

      {/* QS band — neutral slate slice at the bottom. Position only depends
          on the chart's geometry, not on the stack's dollar values. */}
      {qsLayer && (
        <g>
          <rect
            data-testid="treaty-band"
            data-band-type="qs"
            data-share={String(qsLayer.share)}
            // Distinct testid for the QS band so tests can find it without
            // walking the band list.
            x={PAD_L + 4}
            y={qsY}
            width={PLOT_W - 8}
            height={qsBandHeight}
            fill={QS_FILL}
            fillOpacity={0.7}
            stroke="#94a3b8"
            strokeWidth={1}
          >
            <title>
              QS — {(qsLayer.share * 100).toFixed(0)}% share
              {qsLayer.rol !== undefined ? ` · RoL ${(qsLayer.rol * 100).toFixed(0)}%` : ''}
            </title>
          </rect>
          {/* Second test handle on the same SVG node would collide; expose
              the QS-specific testid via a transparent overlay rect instead. */}
          <rect
            data-testid="treaty-band-qs"
            data-share={String(qsLayer.share)}
            x={PAD_L + 4}
            y={qsY}
            width={PLOT_W - 8}
            height={qsBandHeight}
            fill="transparent"
            pointerEvents="none"
          />
          {/* QS annotation */}
          <text
            x={PAD_L + PLOT_W / 2}
            y={qsY + qsBandHeight / 2}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={11}
            fill="#0f172a"
            fontWeight={500}
          >
            {`${Math.round(qsLayer.share * 100)}% QS share`}
            {qsLayer.rol !== undefined ? ` · RoL ${Math.round(qsLayer.rol * 100)}%` : ''}
          </text>
        </g>
      )}

      {/* XS bands */}
      {xsByAttachment.map((layer, idx) => {
        const yTop = dollarsToY(layer.exhaustion, yMax);
        const yBottom = dollarsToY(layer.attachment, yMax);
        const h = Math.max(2, yBottom - yTop);
        const fill = xsFill(idx);
        const midY = yTop + h / 2;
        return (
          <g key={`xs-${idx}`}>
            <rect
              data-testid="treaty-band"
              data-band-type="xs"
              data-attachment={String(layer.attachment)}
              data-exhaustion={String(layer.exhaustion)}
              x={PAD_L + 4}
              y={yTop}
              width={PLOT_W - 8}
              height={h}
              fill={fill}
              fillOpacity={0.85}
              stroke="#064e3b"
              strokeWidth={1}
            >
              <title>
                XS {roundToMillion(layer.attachment)} – {roundToMillion(layer.exhaustion)} ·
                RoL {(layer.rol * 100).toFixed(0)}% · {layer.reinstatements_remaining} reinstatement
                {layer.reinstatements_remaining === 1 ? '' : 's'} left
              </title>
            </rect>
            {/* Transparent overlay carrying the xs-specific testid so the
                test suite can grab xs bands without filtering on attrs. */}
            <rect
              data-testid="treaty-band-xs"
              data-attachment={String(layer.attachment)}
              data-exhaustion={String(layer.exhaustion)}
              x={PAD_L + 4}
              y={yTop}
              width={PLOT_W - 8}
              height={h}
              fill="transparent"
              pointerEvents="none"
            />
            <text
              x={PAD_L + PLOT_W / 2}
              y={midY}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={11}
              fill="#ffffff"
              fontWeight={500}
            >
              {`${roundToMillion(layer.attachment)} – ${roundToMillion(layer.exhaustion)}`}
            </text>
            <text
              x={PAD_L + PLOT_W / 2}
              y={midY + 14}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={10}
              fill="#ecfdf5"
            >
              {`RoL ${Math.round(layer.rol * 100)}% · ${layer.reinstatements_remaining} reinstatement${layer.reinstatements_remaining === 1 ? '' : 's'} left`}
            </text>
          </g>
        );
      })}

      {/* book_p99 reference line */}
      <line
        data-testid="book-p99-line"
        data-book-p99={String(stack.book_p99)}
        x1={PAD_L}
        x2={PAD_L + PLOT_W}
        y1={refY}
        y2={refY}
        stroke="#dc2626"
        strokeWidth={1.5}
        strokeDasharray="4 3"
      />
      <text
        x={PAD_L + PLOT_W - 4}
        y={refY - 4}
        textAnchor="end"
        fontSize={10}
        fill="#dc2626"
        fontWeight={500}
      >
        book p99 · {formatMoneyM(stack.book_p99)}
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Layer parameters table — rendered beneath the ladder so operators can
// read off exact terms without hovering.

interface LayerTableProps {
  layers: TreatyStack['layers'];
}

function LayerTable({ layers }: LayerTableProps) {
  if (layers.length === 0) return null;
  return (
    <table data-testid="treaty-layer-table" className="w-full text-xs border-collapse">
      <thead>
        <tr className="text-left text-zinc-600 border-b border-zinc-200">
          <th className="py-1 pr-3">Layer</th>
          <th className="py-1 pr-3">Range / share</th>
          <th className="py-1 pr-3">RoL</th>
          <th className="py-1 pr-3">Reinstatements</th>
          <th className="py-1">Notes</th>
        </tr>
      </thead>
      <tbody>
        {layers.map((layer, idx) => {
          if (layer.type === 'qs') {
            return (
              <tr key={`qs-${idx}`} className="border-b border-zinc-100">
                <td className="py-1 pr-3 font-medium">QS</td>
                <td className="py-1 pr-3">{`${Math.round(layer.share * 100)}% share`}</td>
                <td className="py-1 pr-3">
                  {layer.rol !== undefined ? `${Math.round(layer.rol * 100)}%` : '—'}
                </td>
                <td className="py-1 pr-3">
                  {layer.reinstatements_remaining !== undefined
                    ? layer.reinstatements_remaining
                    : '—'}
                </td>
                <td className="py-1 text-zinc-600">{layer.description ?? ''}</td>
              </tr>
            );
          }
          return (
            <tr key={`xs-${idx}`} className="border-b border-zinc-100">
              <td className="py-1 pr-3 font-medium">XS</td>
              <td className="py-1 pr-3">
                {`${roundToMillion(layer.attachment)} – ${roundToMillion(layer.exhaustion)}`}
              </td>
              <td className="py-1 pr-3">{`${Math.round(layer.rol * 100)}%`}</td>
              <td className="py-1 pr-3">{layer.reinstatements_remaining}</td>
              <td className="py-1 text-zinc-600">{layer.description ?? ''}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Top-level view.

interface TreatyLadderProps {
  stack: TreatyStack;
}

export function TreatyLadder({ stack }: TreatyLadderProps) {
  const trustTier: TrustTier =
    stack.data_source === 'live' ? 'MODEL_OUTPUT' : 'SYNTHETIC_SCAFFOLD';
  const dataSourceLabel = stack.data_source === 'live' ? 'live' : 'synthetic_demo';

  // Compute the dollar axis ceiling: round the max of (top exhaustion,
  // book_p99) up by 10% so neither hugs the top tick.
  const xsLayers = stack.layers.filter((l): l is XSLayer => l.type === 'xs');
  const topExhaustion = xsLayers.length ? Math.max(...xsLayers.map((l) => l.exhaustion)) : 0;
  const yMaxRaw = Math.max(topExhaustion, stack.book_p99, 1);
  const yMax = yMaxRaw * 1.1;

  if (stack.layers.length === 0) {
    // Honest empty-state — render the trust-tier badge so we don't drop the
    // grammar primitive even on empty data, but show a defensible message
    // instead of an empty SVG.
    return (
      <section data-testid="treaty-section" className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Treaty stack</h2>
          <TrustTierBadge tier={trustTier} />
        </div>
        <div className="rounded border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-600">
          No treaty layers in the artifact. Run{' '}
          <span className="font-mono">python -m scripts.precompute_treaty</span> to regenerate.
        </div>
        <ProvenanceFootnote
          source="artifacts/treaty.json"
          method="python -m scripts.precompute_treaty"
          confidence={`data_source: ${dataSourceLabel} · generated ${stack.generated_at}`}
        />
      </section>
    );
  }

  return (
    <section data-testid="treaty-section" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">Treaty stack</h2>
        <TrustTierBadge tier={trustTier} />
      </div>
      <p className="text-xs text-zinc-600">
        Layer ladder — QS at the bottom plus each XS layer drawn from
        attachment to exhaustion. The dashed red line marks the carrier&rsquo;s
        book p99 ({formatMoneyM(stack.book_p99)}); layers above it cover the
        tail, layers below it provide working-loss relief.
      </p>
      <div className="border rounded bg-white p-3">
        <LadderSvg stack={stack} yMax={yMax} />
      </div>
      <LayerTable layers={stack.layers} />
      <ProvenanceFootnote
        source="artifacts/treaty.json"
        method="python -m scripts.precompute_treaty"
        confidence={`data_source: ${dataSourceLabel} · generated ${stack.generated_at}`}
      />
    </section>
  );
}
