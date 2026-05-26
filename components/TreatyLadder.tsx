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

import { useState } from 'react';
import { TrustTierBadge } from '@/components/grammar/TrustTierBadge';
import { ProvenanceFootnote } from '@/components/grammar/ProvenanceFootnote';
import { InfoIcon, Term } from '@/components/grammar/InfoTooltip';
import type { TrustTier } from '@/lib/grammar/trust-tiers';
import type {
  TreatyStack,
  XSLayer,
  QSLayer,
  FrontingLayer,
  CaptiveLayer,
  ILSLayer,
} from '@/lib/treaty/types';

// ---------------------------------------------------------------------------
// Task P3.20 — captive trapped-vs-free helper. Mirrors the python
// `captive_state` math in api_py/treaty.py so the UI doesn't depend on
// a server round-trip for a derived quantity.

function captiveDerived(layer: CaptiveLayer): {
  total: number;
  trapped: number;
  free: number;
  trapped_share: number;
} {
  const total = Math.max(0, layer.total_capital_usd);
  const reserves = Math.max(0, layer.outstanding_reserves_usd);
  const collateral = Math.max(0, layer.collateral_pledged_usd);
  const upr = Math.max(0, layer.unearned_premium_reserve_usd);
  const trapped = reserves + collateral + upr;
  const free = Math.max(0, total - trapped);
  const rawShare = total > 0 ? trapped / total : 0;
  return { total, trapped, free, trapped_share: Math.min(1, rawShare) };
}

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
// Task P3.19 — fronting band: violet to distinguish from QS slate and
// XS emerald. One color regardless of capital_provider; the data table
// surfaces the provider tag explicitly.
const FRONTING_FILL = '#a78bfa'; // violet-400
// Task P3.21 — ILS / cat-bond band: cyan to distinguish from the
// traditional-reinsurance XS column (emerald). Single color regardless
// of trigger type; the data table surfaces the trigger explicitly.
const ILS_FILL = '#0891b2';     // cyan-600

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
  // Task P3.19 — fronting layer (at most one in the synthetic-demo
  // ladder; the renderer would support multiple but the typed
  // precompute emits at most one).
  const frontingLayer =
    stack.layers.find((l): l is FrontingLayer => l.type === 'fronting') ?? null;
  // Task P3.21 — ILS / cat-bond layers occupy a dollar range like XS
  // but render in a distinct color so the operator can see the
  // capital-markets cover apart from traditional XS layers.
  const ilsLayers = stack.layers.filter((l): l is ILSLayer => l.type === 'ils');

  // Fronting visual band — bottom of the column when present, beneath
  // the QS. Same fixed-band convention as QS: no dollar range, just a
  // visible slice so the operator can see it.
  const frontingBandHeight = frontingLayer ? Math.max(10, PLOT_H * 0.06) : 0;
  const frontingY = PAD_T + PLOT_H - frontingBandHeight;

  // QS visual band — drawn as a fixed slice ABOVE the fronting band so
  // the share is legible. It has no dollar range; the height is the share
  // times a visual budget of 12% of plot height to keep it from dominating
  // the column when there are few XS layers.
  const qsBandHeight = qsLayer ? Math.max(12, PLOT_H * 0.08) : 0;
  const qsY = frontingY - qsBandHeight;

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
      aria-label="Treaty ladder, attachment / exhaustion per layer with book p99 reference"
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

      {/* Fronting band — violet slice at the very bottom, beneath QS. */}
      {frontingLayer && (
        <g>
          <rect
            data-testid="treaty-band"
            data-band-type="fronting"
            data-residual-retention={String(frontingLayer.residual_retention_share)}
            data-fronting-fee={String(frontingLayer.fronting_fee_share)}
            data-capital-provider={String(frontingLayer.capital_provider)}
            x={PAD_L + 4}
            y={frontingY}
            width={PLOT_W - 8}
            height={frontingBandHeight}
            fill={FRONTING_FILL}
            fillOpacity={0.7}
            stroke="#7c3aed"
            strokeWidth={1}
          >
            <title>{`Fronting — ${Math.round(
              (1 - frontingLayer.residual_retention_share) * 100,
            )}% ceded to ${frontingLayer.capital_provider}, ${Math.round(
              frontingLayer.residual_retention_share * 100,
            )}% retained · ${Math.round(
              frontingLayer.fronting_fee_share * 100,
            )}% fronting fee`}</title>
          </rect>
          {/* Distinct testid overlay so tests can grab the fronting band
              without filtering on attrs. */}
          <rect
            data-testid="treaty-band-fronting"
            data-residual-retention={String(frontingLayer.residual_retention_share)}
            data-fronting-fee={String(frontingLayer.fronting_fee_share)}
            data-capital-provider={String(frontingLayer.capital_provider)}
            x={PAD_L + 4}
            y={frontingY}
            width={PLOT_W - 8}
            height={frontingBandHeight}
            fill="transparent"
            pointerEvents="none"
          />
          <text
            x={PAD_L + PLOT_W / 2}
            y={frontingY + frontingBandHeight / 2}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={11}
            fill="#1e1b4b"
            fontWeight={500}
          >
            {`Fronting · ${Math.round(
              (1 - frontingLayer.residual_retention_share) * 100,
            )}% to ${frontingLayer.capital_provider} · fee ${Math.round(
              frontingLayer.fronting_fee_share * 100,
            )}%`}
          </text>
        </g>
      )}

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
            {/*
              Title text is composed in JS rather than as multi-line JSX so
              React emits a single text child. Multi-line JSX with embedded
              expressions becomes a sequence of text nodes whose whitespace
              normalization can differ between server and client, which
              produced the QS-band hydration mismatch on /treaty.
            */}
            <title>{`QS, ${(qsLayer.share * 100).toFixed(0)}% share${
              qsLayer.rol !== undefined
                ? ` · RoL ${(qsLayer.rol * 100).toFixed(0)}%`
                : ''
            }`}</title>
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
              <title>{`XS ${roundToMillion(layer.attachment)} to ${roundToMillion(
                layer.exhaustion,
              )} · RoL ${(layer.rol * 100).toFixed(0)}% · ${
                layer.reinstatements_remaining
              } reinstatement${
                layer.reinstatements_remaining === 1 ? '' : 's'
              } left`}</title>
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
              {`${roundToMillion(layer.attachment)} to ${roundToMillion(layer.exhaustion)}`}
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

      {/* ILS / cat-bond bands — same coordinate system as XS but cyan
          so the operator can distinguish capital-markets cover from
          traditional XS layers. */}
      {ilsLayers.map((layer, idx) => {
        const yTop = dollarsToY(layer.exhaustion, yMax);
        const yBottom = dollarsToY(layer.attachment, yMax);
        const h = Math.max(2, yBottom - yTop);
        const midY = yTop + h / 2;
        const principal = layer.exhaustion - layer.attachment;
        return (
          <g key={`ils-${idx}`}>
            <rect
              data-testid="treaty-band"
              data-band-type="ils"
              data-attachment={String(layer.attachment)}
              data-exhaustion={String(layer.exhaustion)}
              data-trigger={String(layer.trigger)}
              data-coupon-rate={String(layer.coupon_rate)}
              x={PAD_L + 4}
              y={yTop}
              width={PLOT_W - 8}
              height={h}
              fill={ILS_FILL}
              fillOpacity={0.85}
              stroke="#155e75"
              strokeWidth={1}
            >
              <title>{`ILS ${roundToMillion(layer.attachment)} to ${roundToMillion(
                layer.exhaustion,
              )} · ${layer.trigger} trigger · coupon ${(layer.coupon_rate * 100).toFixed(
                1,
              )}% · ${layer.term_years}yr term`}</title>
            </rect>
            <rect
              data-testid="treaty-band-ils"
              data-attachment={String(layer.attachment)}
              data-exhaustion={String(layer.exhaustion)}
              data-trigger={String(layer.trigger)}
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
              {`ILS · ${roundToMillion(layer.attachment)} to ${roundToMillion(layer.exhaustion)}`}
            </text>
            <text
              x={PAD_L + PLOT_W / 2}
              y={midY + 14}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={10}
              fill="#cffafe"
            >
              {`${layer.trigger} · coupon ${(layer.coupon_rate * 100).toFixed(1)}% · ${layer.term_years}yr`}
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
// Task P3.20 — Captive vehicle trapped-vs-free panel. Rendered beneath
// the ladder (the captive sits *outside* the cession waterfall; it's
// the destination of the fronted cession, not another reinsurance
// layer). A single horizontal bar shows the trapped split, color-coded
// by composition (red = outstanding reserves; amber = collateral
// pledged; yellow = unearned premium reserve; green = free).

interface CaptivePanelProps {
  layer: CaptiveLayer | null;
}

const RESERVES_FILL = '#dc2626';   // red-600 — open claim liabilities
const COLLATERAL_FILL = '#f59e0b'; // amber-500 — pledged to fronter
const UPR_FILL = '#fde047';        // yellow-300 — unearned premium reserve
const FREE_FILL = '#22c55e';       // green-500 — free / redeployable

function CaptivePanel({ layer }: CaptivePanelProps) {
  if (layer === null) return null;
  const { total, trapped, free, trapped_share } = captiveDerived(layer);
  const reserves = Math.max(0, layer.outstanding_reserves_usd);
  const collateral = Math.max(0, layer.collateral_pledged_usd);
  const upr = Math.max(0, layer.unearned_premium_reserve_usd);
  // Visual segment fractions — segments don't have to sum to 1 because
  // trapped can exceed total (over-reserved captive). Defensive divisor
  // uses max(total, trapped) so the bar is always inside [0, 1].
  const denom = Math.max(total, trapped) || 1;
  const segR = reserves / denom;
  const segC = collateral / denom;
  const segU = upr / denom;
  const segF = free / denom;

  // Risk tier: ≥ 95% trapped is a "fully-reserved" badge — operator
  // should know new underwriting needs parent capital injection.
  const tierLabel =
    trapped_share >= 0.95
      ? 'fully reserved'
      : trapped_share >= 0.80
        ? 'heavily reserved'
        : trapped_share >= 0.50
          ? 'moderately reserved'
          : 'redeployable';

  const fmt = (n: number) => formatMoneyM(n);
  return (
    <div
      data-testid="captive-panel"
      data-trapped-share={String(trapped_share.toFixed(4))}
      className="rounded border border-zinc-200 bg-white p-3 flex flex-col gap-2"
    >
      <div className="flex items-center justify-between text-sm">
        <span className="inline-flex items-center gap-1 font-medium">
          <Term term="captive">Captive vehicle</Term>
        </span>
        <span
          data-testid="captive-trapped-share"
          className="text-xs text-zinc-600 tabular-nums"
        >
          {`${Math.round(trapped_share * 100)}% trapped · ${tierLabel}`}
        </span>
      </div>
      <div
        data-testid="captive-bar"
        className="relative w-full h-5 rounded overflow-hidden border border-zinc-200 bg-zinc-50"
      >
        <div
          data-testid="captive-bar-reserves"
          className="absolute top-0 left-0 h-full"
          style={{ width: `${segR * 100}%`, backgroundColor: RESERVES_FILL }}
          title={`Outstanding reserves · ${fmt(reserves)}`}
        />
        <div
          data-testid="captive-bar-collateral"
          className="absolute top-0 h-full"
          style={{
            left: `${segR * 100}%`,
            width: `${segC * 100}%`,
            backgroundColor: COLLATERAL_FILL,
          }}
          title={`Collateral pledged · ${fmt(collateral)}`}
        />
        <div
          data-testid="captive-bar-upr"
          className="absolute top-0 h-full"
          style={{
            left: `${(segR + segC) * 100}%`,
            width: `${segU * 100}%`,
            backgroundColor: UPR_FILL,
          }}
          title={`Unearned premium reserve · ${fmt(upr)}`}
        />
        <div
          data-testid="captive-bar-free"
          className="absolute top-0 h-full"
          style={{
            left: `${(segR + segC + segU) * 100}%`,
            width: `${segF * 100}%`,
            backgroundColor: FREE_FILL,
          }}
          title={`Free capital · ${fmt(free)}`}
        />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: RESERVES_FILL }} />
          <span className="text-zinc-700">Reserves {fmt(reserves)}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: COLLATERAL_FILL }} />
          <span className="text-zinc-700">Collateral {fmt(collateral)}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: UPR_FILL }} />
          <span className="inline-flex items-center gap-1 text-zinc-700">
            <Term term="upr">UPR</Term> {fmt(upr)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: FREE_FILL }} />
          <span data-testid="captive-free-label" className="text-zinc-700">Free {fmt(free)}</span>
        </div>
      </div>
      {layer.description && (
        <p className="text-xs text-zinc-600">{layer.description}</p>
      )}
    </div>
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
  // Track which layer types have already rendered their glossary icon so we
  // attach an InfoIcon to the FIRST row of each type only — keeps the table
  // legible when several XS / ILS rows stack up.
  const iconShown = new Set<string>();
  const firstFor = (key: string): boolean => {
    if (iconShown.has(key)) return false;
    iconShown.add(key);
    return true;
  };
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
            const showIcon = firstFor('qs');
            return (
              <tr key={`qs-${idx}`} className="border-b border-zinc-100">
                <td className="py-1 pr-3 font-medium">
                  <span className="inline-flex items-center gap-1">
                    QS
                    {showIcon && <InfoIcon term="quota-share" iconSize="sm" />}
                  </span>
                </td>
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
          if (layer.type === 'ils') {
            // Task P3.21 — cat-bond table row. "RoL" surfaces the
            // coupon rate (the cat-bond analogue of rate-on-line);
            // "Reinstatements" stays empty (cat-bonds are
            // collateralized one-shot — exhaustion = end of life,
            // not a reinstatement).
            const showIcon = firstFor('ils');
            return (
              <tr
                key={`ils-${idx}`}
                data-testid="treaty-table-row-ils"
                className="border-b border-zinc-100"
              >
                <td className="py-1 pr-3 font-medium">
                  <span className="inline-flex items-center gap-1">
                    ILS
                    {showIcon && <InfoIcon term="ils" iconSize="sm" />}
                  </span>
                </td>
                <td className="py-1 pr-3">
                  {`${roundToMillion(layer.attachment)} to ${roundToMillion(layer.exhaustion)}`}
                </td>
                <td className="py-1 pr-3">
                  {`${(layer.coupon_rate * 100).toFixed(1)}% coupon`}
                </td>
                <td className="py-1 pr-3">
                  {`${layer.term_years}yr · ${layer.trigger}`}
                </td>
                <td className="py-1 text-zinc-600">{layer.description ?? ''}</td>
              </tr>
            );
          }
          if (layer.type === 'captive') {
            // Task P3.20 — render a single row that points at the
            // captive panel above (the trapped/free split lives there).
            const d = captiveDerived(layer);
            const showIcon = firstFor('captive');
            return (
              <tr
                key={`captive-${idx}`}
                data-testid="treaty-table-row-captive"
                className="border-b border-zinc-100"
              >
                <td className="py-1 pr-3 font-medium">
                  <span className="inline-flex items-center gap-1">
                    Captive
                    {showIcon && <InfoIcon term="captive" iconSize="sm" />}
                  </span>
                </td>
                <td className="py-1 pr-3">
                  {`${formatMoneyM(d.total)} total · ${Math.round(
                    d.trapped_share * 100,
                  )}% trapped`}
                </td>
                <td className="py-1 pr-3">—</td>
                <td className="py-1 pr-3">—</td>
                <td className="py-1 text-zinc-600">{layer.description ?? ''}</td>
              </tr>
            );
          }
          if (layer.type === 'fronting') {
            // Task P3.19 — fronting row. "Range / share" surfaces the
            // cession share (1 - residual); "RoL" surfaces the
            // fronting fee (the analogous premium-side rate);
            // "Reinstatements" stays empty (fronting layers are
            // continuous, not per-event-reinstating).
            const showIcon = firstFor('fronting');
            const showFeeIcon = firstFor('fronting-fee');
            return (
              <tr
                key={`fronting-${idx}`}
                data-testid="treaty-table-row-fronting"
                className="border-b border-zinc-100"
              >
                <td className="py-1 pr-3 font-medium">
                  <span className="inline-flex items-center gap-1">
                    Fronting
                    {showIcon && <InfoIcon term="fronting" iconSize="sm" />}
                  </span>
                </td>
                <td className="py-1 pr-3">
                  {`${Math.round(
                    (1 - layer.residual_retention_share) * 100,
                  )}% ceded to ${layer.capital_provider}`}
                </td>
                <td className="py-1 pr-3">
                  <span className="inline-flex items-center gap-1">
                    {`${Math.round(layer.fronting_fee_share * 100)}% fee`}
                    {showFeeIcon && <InfoIcon term="fronting-fee" iconSize="sm" />}
                  </span>
                </td>
                <td className="py-1 pr-3">—</td>
                <td className="py-1 text-zinc-600">{layer.description ?? ''}</td>
              </tr>
            );
          }
          // Task P3.22 — per-occurrence remaining capacity. Surface
          // as part of the reinstatements cell so the operator can see
          // how much layer width is consumed without a separate column.
          const reinstatementsCell = (() => {
            const n = layer.reinstatements_remaining;
            const initial = layer.initial_capacity_usd;
            const remaining = layer.remaining_capacity_usd;
            if (initial === undefined || remaining === undefined) {
              return String(n);
            }
            return (
              <span
                data-testid="xs-remaining-capacity"
                data-initial-capacity={String(initial)}
                data-remaining-capacity={String(remaining)}
              >
                {`${n} · ${roundToMillion(remaining)} of ${roundToMillion(initial)} left`}
              </span>
            );
          })();
          const showXsIcon = firstFor('xs');
          return (
            <tr key={`xs-${idx}`} className="border-b border-zinc-100">
              <td className="py-1 pr-3 font-medium">
                <span className="inline-flex items-center gap-1">
                  XS
                  {showXsIcon && <InfoIcon term="excess-of-loss" iconSize="sm" />}
                </span>
              </td>
              <td className="py-1 pr-3">
                {`${roundToMillion(layer.attachment)} to ${roundToMillion(layer.exhaustion)}`}
              </td>
              <td className="py-1 pr-3">{`${Math.round(layer.rol * 100)}%`}</td>
              <td className="py-1 pr-3">{reinstatementsCell}</td>
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

  // Task P3.19 — fronting toggle. Operators sometimes want to see the
  // ladder *as if* the fronting layer didn't exist (e.g. to compare
  // gross-of-fronting versus net-of-fronting capital position). The
  // toggle is client-side only — the underlying artifact is unchanged.
  const hasFronting = stack.layers.some((l) => l.type === 'fronting');
  const [showFronting, setShowFronting] = useState(true);
  const visibleStack: TreatyStack = showFronting
    ? stack
    : { ...stack, layers: stack.layers.filter((l) => l.type !== 'fronting') };

  // Compute the dollar axis ceiling: round the max of (top exhaustion,
  // book_p99) up by 10% so neither hugs the top tick. `Math.round` collapses
  // the float artifact (e.g. 132_000_000.00000001 → 132_000_000) so server
  // and client agree on the SVG `<rect y=...>` attribute strings — without
  // it, React reports a hydration mismatch on the LadderSvg subtree.
  const xsLayers = visibleStack.layers.filter((l): l is XSLayer => l.type === 'xs');
  // Task P3.21 — include ILS layer exhaustions in the y-axis range so
  // the cat-bond layer is always visible above the cat XS column.
  const ilsLayers = visibleStack.layers.filter((l): l is ILSLayer => l.type === 'ils');
  const allExhaustions = [...xsLayers, ...ilsLayers].map((l) => l.exhaustion);
  const topExhaustion = allExhaustions.length ? Math.max(...allExhaustions) : 0;
  const yMaxRaw = Math.max(topExhaustion, visibleStack.book_p99, 1);
  const yMax = Math.round(yMaxRaw * 1.1);

  if (visibleStack.layers.length === 0) {
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
        {hasFronting && (
          <label
            data-testid="fronting-toggle"
            className="ml-auto inline-flex items-center gap-1 text-xs text-zinc-700 cursor-pointer select-none"
          >
            <input
              type="checkbox"
              checked={showFronting}
              onChange={(e) => setShowFronting(e.target.checked)}
              data-testid="fronting-toggle-input"
              className="accent-violet-500"
            />
            Show fronting
          </label>
        )}
      </div>
      <p className="text-xs text-zinc-600">
        Layer ladder, QS at the bottom plus each XS layer drawn from
        attachment to exhaustion. The dashed red line marks the carrier&rsquo;s{' '}
        <Term term="p99">book p99</Term> ({formatMoneyM(visibleStack.book_p99)});
        layers above it cover the tail, layers below it provide working-loss
        relief.
      </p>
      <div className="border rounded bg-white p-3">
        <LadderSvg stack={visibleStack} yMax={yMax} />
      </div>
      <CaptivePanel
        layer={
          visibleStack.layers.find((l): l is CaptiveLayer => l.type === 'captive') ?? null
        }
      />
      <LayerTable layers={visibleStack.layers} />
      <ProvenanceFootnote
        source="artifacts/treaty.json"
        method="python -m scripts.precompute_treaty"
        confidence={`data_source: ${dataSourceLabel} · generated ${visibleStack.generated_at}`}
      />
    </section>
  );
}
