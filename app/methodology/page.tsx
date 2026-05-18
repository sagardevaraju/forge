/**
 * Task 14 (Redesign Phase 1) — `/methodology` route.
 *
 * Surfaces `docs/methodology.md` as a page so reviewers can read the
 * defense of every magic constant without leaving the running app. The
 * `<pre>` render is an intentional Phase 1 trade-off: `react-markdown`
 * would add ~15kB gzipped for one route. Phase 2's `/calibration` view
 * needs MathJax for CRPS formulas and will swap to a real markdown
 * renderer in one commit (and this page comes along for the ride).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ProvenanceFootnote } from '@/components/grammar/ProvenanceFootnote';

export const dynamic = 'force-dynamic';

export default function Methodology() {
  const md = fs.readFileSync(path.join(process.cwd(), 'docs/methodology.md'), 'utf8');
  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Methodology</h1>
      <pre className="whitespace-pre-wrap text-sm">{md}</pre>
      <ProvenanceFootnote source="docs/methodology.md" method="Phase 1 plan task 14" />
    </div>
  );
}
