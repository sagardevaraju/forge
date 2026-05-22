'use client';
/**
 * Task 22 — SITREP panel (Phase 1, free-form memo).
 * Task P2.24 — Structured SITREP form, 6 named fields (Phase 2 redesign).
 *
 * The Phase-2 redesign replaces the free-form markdown body with a
 * structured 6-row table keyed off the StructuredSitrep returned by the
 * `draft_sitrep` agent tool. Operators get a deterministic surface they
 * can scan in seconds; downstream audit log + PDF export (P2.36) can
 * also index off named fields rather than re-parsing prose.
 *
 * Props:
 *   • sitrep        — the StructuredSitrep payload, or null if not yet drafted.
 *   • dataSource    — discriminator: 'live' (LLM-drafted) or
 *                     'synthetic_fallback' (stub when LLM/keys unavailable).
 *                     Drives the trust-tier badge: RECOMMENDATION vs
 *                     SYNTHETIC_SCAFFOLD.
 *   • context       — active-event context (used to build the LLM prompt
 *                     so clicking Generate produces a relevant memo
 *                     instead of a follow-up "which storm?" question).
 *   • onGenerate    — called after Generate succeeds; the parent stores
 *                     the new payload + data_source. Signature:
 *                     `(sitrep | null, dataSource | null) => void`.
 *
 * The Generate button POSTs to `/api/agent/chat` and listens for the
 * `tool_result` event for `draft_sitrep`; the route attaches the full
 * result object on that event so the panel can pull the structured
 * payload directly without re-parsing the LLM's final-message text.
 */
import { useState } from 'react';
import { readChatStream } from '@/lib/chat-stream';
import { TrustTierBadge } from '@/components/grammar/TrustTierBadge';
import { ProvenanceFootnote } from '@/components/grammar/ProvenanceFootnote';

export type ThreatTier = 'low' | 'medium' | 'high' | 'critical';

export interface StructuredSitrep {
  threat_tier: ThreatTier;
  lead_time_hours: number;
  portfolio_recommendation: string;
  operational_recommendation: string;
  claims_prep_recommendation: string;
  escalation_criteria: string;
}

export type SitrepDataSource = 'live' | 'synthetic_fallback';

export interface SitrepContext {
  storm_id: string;
  advisory_number: string | null;
  peak_wind: number | null;
  fire_count: number;
  source: 'live' | 'mock';
}

interface Props {
  sitrep: StructuredSitrep | null;
  dataSource: SitrepDataSource | null;
  context: SitrepContext | null;
  onGenerate: (sitrep: StructuredSitrep | null, dataSource: SitrepDataSource | null) => void;
}

// Tailwind palette per threat tier. Substring matches (`/red/`, `/orange/`,
// `/amber/`, `/slate/`) are asserted by the unit tests, so any rename of
// the palette tokens must also update the test expectations.
const TIER_CLASSES: Record<ThreatTier, string> = {
  critical: 'bg-red-100 text-red-800 border-red-300',
  high: 'bg-orange-100 text-orange-800 border-orange-300',
  medium: 'bg-amber-100 text-amber-800 border-amber-300',
  low: 'bg-slate-100 text-slate-800 border-slate-300',
};

function buildPrompt(ctx: SitrepContext | null): string {
  if (!ctx) {
    return (
      'Draft a structured SITREP for the carrier book posture in the absence ' +
      'of an active named storm. Call the draft_sitrep tool. Return the 6 ' +
      'fields (threat_tier, lead_time_hours, portfolio_recommendation, ' +
      'operational_recommendation, claims_prep_recommendation, ' +
      'escalation_criteria) as a JSON object.'
    );
  }
  return (
    `Draft a structured SITREP for storm ${ctx.storm_id}` +
    (ctx.advisory_number ? ` (advisory ${ctx.advisory_number})` : '') +
    `. Peak wind ${ctx.peak_wind ?? 'unknown'} mph. ` +
    `${ctx.fire_count} active fires reported in the bbox. ` +
    `Data source: ${ctx.source === 'live' ? 'live NHC feed' : 'demo scenario'}. ` +
    'Use the draft_sitrep tool, return the 6 named fields as JSON.'
  );
}

function tierBadgeClasses(tier: ThreatTier): string {
  return [
    'inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
    TIER_CLASSES[tier],
  ].join(' ');
}

interface RowProps {
  testId: string;
  label: string;
  children: React.ReactNode;
}

function Row({ testId, label, children }: RowProps) {
  return (
    <tr data-testid={testId} className="align-top border-t border-zinc-100">
      <th
        scope="row"
        className="text-left py-1.5 pr-3 text-[11px] font-medium text-zinc-500 uppercase tracking-wide whitespace-nowrap w-[34%]"
      >
        {label}
      </th>
      <td className="py-1.5 text-xs text-zinc-800 leading-snug">{children}</td>
    </tr>
  );
}

function emDashIfEmpty(value: string | undefined | null): React.ReactNode {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed : <span className="text-zinc-400">—</span>;
}

export function SitrepPanel({ sitrep, dataSource, context, onGenerate }: Props) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setStatus('Calling draft_sitrep…');
    setError(null);
    let nextSitrep: StructuredSitrep | null = null;
    let nextDataSource: SitrepDataSource | null = null;
    try {
      const r = await fetch('/api/agent/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: [{ role: 'user', content: buildPrompt(context) }],
        }),
      });
      if (!r.ok) throw new Error(`chat returned ${r.status}`);
      for await (const ev of readChatStream(r)) {
        if (ev.type === 'tool_call') setStatus(`Calling ${ev.name}…`);
        else if (ev.type === 'tool_result') {
          setStatus(ev.ok ? `${ev.name} → ${ev.summary}` : `${ev.name} failed`);
          if (ev.name === 'draft_sitrep' && ev.ok) {
            const payload = (ev as { result?: unknown }).result;
            if (
              typeof payload === 'object' &&
              payload !== null &&
              'sitrep' in payload &&
              'data_source' in payload
            ) {
              const p = payload as {
                sitrep: StructuredSitrep;
                data_source: SitrepDataSource;
              };
              nextSitrep = p.sitrep;
              nextDataSource = p.data_source;
            }
          }
        } else if (ev.type === 'error') throw new Error(ev.message);
      }
      onGenerate(nextSitrep, nextDataSource);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Error drafting sitrep: ${msg}`);
      onGenerate(null, null);
    } finally {
      setBusy(false);
      setStatus('');
    }
  }

  const trustTier = dataSource === 'synthetic_fallback' ? 'SYNTHETIC_SCAFFOLD' : 'RECOMMENDATION';
  const confidence =
    dataSource === 'synthetic_fallback'
      ? 'Stub shown. LLM unavailable or schema validation failed.'
      : dataSource === 'live'
        ? 'Live structured-JSON output, schema-validated server-side.'
        : undefined;

  return (
    <div
      data-testid="sitrep-panel"
      className="border rounded p-3 flex flex-col gap-2 max-h-[50vh] overflow-auto bg-white"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="font-semibold text-sm">SITREP</div>
          <span data-testid="sitrep-trust-badge" className="inline-flex">
            <TrustTierBadge tier={trustTier} />
          </span>
        </div>
        <button
          onClick={generate}
          disabled={busy}
          className="bg-zinc-900 text-white px-2 py-1 rounded text-xs disabled:opacity-50"
        >
          {busy ? 'Drafting…' : 'Generate'}
        </button>
      </div>
      {busy && status && (
        <div className="text-xs italic text-zinc-600" data-testid="sitrep-status">
          {status}
        </div>
      )}
      {error && (
        <div
          data-testid="sitrep-error"
          role="alert"
          className="text-xs text-red-700"
        >
          {error}
        </div>
      )}
      {sitrep ? (
        <table className="w-full border-collapse text-xs">
          <tbody>
            <Row testId="sitrep-row-threat-tier" label="Threat tier">
              <span
                data-testid="sitrep-threat-tier-badge"
                className={tierBadgeClasses(sitrep.threat_tier)}
              >
                {sitrep.threat_tier}
              </span>
            </Row>
            <Row testId="sitrep-row-lead-time" label="Lead time">
              <span data-testid="sitrep-lead-time-value" className="font-mono">
                {`T-${Math.max(0, Math.round(sitrep.lead_time_hours))}h`}
              </span>
            </Row>
            <Row testId="sitrep-row-portfolio-recommendation" label="Portfolio">
              {emDashIfEmpty(sitrep.portfolio_recommendation)}
            </Row>
            <Row testId="sitrep-row-operational-recommendation" label="Operational">
              {emDashIfEmpty(sitrep.operational_recommendation)}
            </Row>
            <Row testId="sitrep-row-claims-prep-recommendation" label="Claims prep">
              {emDashIfEmpty(sitrep.claims_prep_recommendation)}
            </Row>
            <Row testId="sitrep-row-escalation-criteria" label="Escalation">
              {emDashIfEmpty(sitrep.escalation_criteria)}
            </Row>
          </tbody>
        </table>
      ) : !busy ? (
        <div className="text-xs text-zinc-500">No sitrep yet. Click Generate.</div>
      ) : null}
      <ProvenanceFootnote
        source="Generated by the draft_sitrep agent tool (cascading LLM client, GitHub Models PAT primary + OpenRouter fallback)."
        method="Structured JSON output, schema-validated against the 6 named fields."
        confidence={confidence}
      />
    </div>
  );
}
