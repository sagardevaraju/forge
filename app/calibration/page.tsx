/**
 * Task P2.16 — /calibration view route.
 *
 * Server component: reads the cached `artifacts/calibration.json` artifact
 * written by `scripts/precompute_calibration.py` (Task P2.2) at request time
 * and hands the typed payload to the client view. We do not invoke the
 * precompute on the request path — Vercel functions ship a read-only
 * filesystem and the artifact is tracked in git.
 *
 * `force-dynamic` matches the other Phase 1 view pages — the artifact may
 * be updated between deploys, so we never want Next to ISR-cache the page.
 *
 * Regenerate locally:
 *   python -m scripts.precompute_calibration
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CalibrationView, type CalibrationData } from '@/components/CalibrationView';
import { TrustTierBadge } from '@/components/grammar/TrustTierBadge';

export const dynamic = 'force-dynamic';

const ARTIFACT_PATH = path.join(process.cwd(), 'artifacts', 'calibration.json');

async function loadCalibrationArtifact(): Promise<CalibrationData | null> {
  try {
    const raw = await readFile(ARTIFACT_PATH, 'utf-8');
    // Trust the precompute script's schema — it is committed to git and
    // versioned via `schema_version`. We narrow to the TS type at the boundary
    // and let downstream code rely on it.
    return JSON.parse(raw) as CalibrationData;
  } catch {
    return null;
  }
}

export default async function CalibrationPage() {
  const data = await loadCalibrationArtifact();
  return (
    <div className="p-6">
      <div className="flex items-center gap-2 mb-1">
        <h1 className="text-2xl font-bold">Calibration</h1>
        {data && (
          <TrustTierBadge
            tier={data.data_source === 'live' ? 'MODEL_OUTPUT' : 'SYNTHETIC_SCAFFOLD'}
          />
        )}
      </div>
      <p className="text-sm text-zinc-600 mb-4">
        Reliability diagrams for the XGB quantile heads, the scenario generator&rsquo;s PIT
        histogram, and per-dim learning curves for the CV head. All three live downstream of
        the same scenario set the Portfolio MIP and Operational LP consume — calibration here
        is what the Decision Reconciler relies on.
      </p>
      {data ? (
        <CalibrationView data={data} />
      ) : (
        <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="font-semibold mb-1">Calibration artifact missing.</div>
          <div>
            Run <span className="font-mono">python -m scripts.precompute_calibration</span> to
            regenerate <span className="font-mono">artifacts/calibration.json</span>.
          </div>
        </div>
      )}
    </div>
  );
}
