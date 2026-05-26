/**
 * Task P2.17 — /treaty view route.
 *
 * Server component: reads the cached `artifacts/treaty.json` artifact
 * written by `scripts/precompute_treaty.py` at request time and hands the
 * typed payload to the client view. We do not invoke the precompute on
 * the request path — Vercel functions ship a read-only filesystem and the
 * artifact is tracked in git.
 *
 * `force-dynamic` matches the other Phase 1/2 view pages — the artifact
 * may be regenerated between deploys, so we never want Next to ISR-cache
 * the page.
 *
 * Regenerate locally:
 *   python -m scripts.precompute_treaty
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { TreatyLadder } from '@/components/TreatyLadder';
import { Term } from '@/components/grammar/InfoTooltip';
import type { TreatyStack } from '@/lib/treaty/types';

export const dynamic = 'force-dynamic';

const ARTIFACT_PATH = path.join(process.cwd(), 'artifacts', 'treaty.json');

async function loadTreatyArtifact(): Promise<TreatyStack | null> {
  try {
    const raw = await readFile(ARTIFACT_PATH, 'utf-8');
    // Trust the precompute script's schema — it's committed to git and
    // versioned via `schema_version`. Narrow to the TS type at the
    // boundary and let downstream code rely on it.
    return JSON.parse(raw) as TreatyStack;
  } catch {
    return null;
  }
}

export default async function TreatyPage() {
  const stack = await loadTreatyArtifact();
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-1">
        <Term term="treaty">Treaty</Term>
      </h1>
      <p className="text-sm text-zinc-600 mb-4">
        The placed reinsurance stack,{' '}
        <Term term="quota-share">quota share</Term> at the bottom plus each{' '}
        <Term term="excess-of-loss">excess-of-loss</Term> layer.{' '}
        <Term term="attachment">Attachment</Term>,{' '}
        <Term term="exhaustion">exhaustion</Term>,{' '}
        <Term term="rate-on-line">rate-on-line</Term>, and{' '}
        <Term term="reinstatement">reinstatements</Term> remaining are surfaced
        per layer so the ops desk can see at a glance where the carrier&rsquo;s{' '}
        <Term term="tail-exposure">tail exposure</Term> sits relative to the
        cover.
      </p>
      {stack ? (
        <TreatyLadder stack={stack} />
      ) : (
        <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="font-semibold mb-1">Treaty data unavailable.</div>
          <div>
            Run <span className="font-mono">python -m scripts.precompute_treaty</span> to
            regenerate <span className="font-mono">artifacts/treaty.json</span>.
          </div>
        </div>
      )}
    </div>
  );
}
