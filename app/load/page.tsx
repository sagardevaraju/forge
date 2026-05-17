/**
 * /load — upload a carrier book CSV via the three-step wizard
 * (Task P2.39): pick file → review suggested column mapping +
 * PII deny-list → confirm + import. Every imported row carries a
 * lineage record (src_file, src_row, mapped_at, refused_columns)
 * so an auditor can trace where each policy came from and which
 * carrier columns were refused at ingest. After ingestion the
 * Portfolio MIP is re-run and the user is redirected to /portfolio.
 *
 * Phase 3 (Task P3.28) replaces the regex deny-list with a real PII
 * classifier and adds the SOC 2 audit trail.
 */
import { LoadWizard } from '@/components/LoadWizard';

export default function LoadPage() {
  return (
    <main className="min-h-screen p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Load policy book</h1>
      <p className="text-sm text-zinc-600 mb-6">
        Upload a CSV of policies to replace the current book. The wizard
        suggests a column mapping, refuses any column whose name looks like
        PII, and tags every imported row with its source file + row number
        so the lineage is auditable.
      </p>
      <LoadWizard />
    </main>
  );
}
