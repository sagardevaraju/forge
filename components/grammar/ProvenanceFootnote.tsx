/**
 * Task 2 (Redesign Phase 1) — ProvenanceFootnote grammar primitive.
 *
 * A pure, stateless three-line footnote that every chart, panel, and table
 * mounts beneath itself to surface the provenance the brief demands:
 *   • Source — the feed / module the data came from
 *   • Method — the processing pipeline + version
 *   • Confidence — optional calibration line (log-lik, coverage, etc.)
 *
 * The `confidence` row is omitted entirely when the prop is undefined so
 * unmeasured surfaces don't fake a number.
 */

interface ProvenanceFootnoteProps {
  source: string;
  method: string;
  confidence?: string;
}

export function ProvenanceFootnote({ source, method, confidence }: ProvenanceFootnoteProps) {
  return (
    <div data-testid="provenance-footnote" className="text-[10px] text-zinc-500">
      <div>
        <span className="font-medium">Source:</span> {source}
      </div>
      <div>
        <span className="font-medium">Method:</span> {method}
      </div>
      {confidence !== undefined && (
        <div>
          <span className="font-medium">Confidence:</span> {confidence}
        </div>
      )}
    </div>
  );
}
