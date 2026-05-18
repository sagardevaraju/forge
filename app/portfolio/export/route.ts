/**
 * Task P2.30 — Print-to-PDF route for the Portfolio view (board-deck export).
 *
 * GET /portfolio/export returns a static PDF rendering of the cached
 * Portfolio MIP decision, with timestamps and provenance inline. The
 * implementation uses `@react-pdf/renderer` (path (b) from the task brief):
 * a declarative server-side React → PDF compiler. We chose this over the
 * playwright-aws-lambda path because:
 *
 *   - The deliverable is a static "board-deck" document, not a screenshot
 *     of the running page — so we don't need browser-fidelity rendering.
 *   - Chromium-in-Vercel-function has ~15s cold starts and pushes us against
 *     the 50 MB function size limit. react-pdf is ~3 MB direct, well under.
 *   - The output is type-safe and deterministic from a JSON artifact.
 *
 * Document layout (see `./document.tsx`):
 *   1. Cover headline + ISO date + objective + horizon.
 *   2. Book scalars row (TIV, premium, loss p50, loss p99).
 *   3. Budget triple (capital, max non-renew, cession).
 *   4. Action mix table (six canonical actions × count / TIV / share).
 *   5. Provenance footer (artifact path, schema_version, ISO timestamp,
 *      cohort prior pointer to docs/methodology.md).
 *
 * Filename: `forge-portfolio-{ISO_DATE}.pdf` so analysts can stash multiple
 * exports without name collisions.
 *
 * Error model:
 *   - Artifact missing  → 503 JSON (the page lives or dies by the artifact,
 *     and a fake stub PDF would be more confusing than a clean error).
 *   - Renderer crash    → propagates as 500. We don't try to recover —
 *     the renderer is deterministic so a crash means a genuine bug.
 */
import { loadPortfolioOptimization } from '@/lib/db/portfolio_optimization';
import { PortfolioExportDocument } from './document';
import { renderToBuffer, type DocumentProps } from '@react-pdf/renderer';
import * as React from 'react';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(): Promise<Response> {
  const optimizationRaw = await loadPortfolioOptimization();
  if (!optimizationRaw) {
    return new Response(
      JSON.stringify({
        error:
          'Portfolio artifact not found. Run `python -m scripts.precompute_portfolio_optimization` to generate artifacts/portfolio_optimization.json.',
      }),
      {
        status: 503,
        headers: { 'content-type': 'application/json' },
      },
    );
  }

  // Strip loss_scenarios to keep the document — and the worker memory —
  // small. The PDF doesn't render the K=1000 draw arrays anyway.
  const optimization = {
    ...optimizationRaw,
    cohorts: optimizationRaw.cohorts.map((c) => {
      const { loss_scenarios: _stripped, ...rest } = c;
      return rest;
    }),
  };

  const now = new Date();
  const isoTimestamp = now.toISOString();
  const isoDate = isoTimestamp.slice(0, 10);

  // The renderer wants `ReactElement<DocumentProps>`; our typed component
  // returns the same Document tree so the cast is structurally sound — TS
  // just can't infer it through the generic wrapper.
  const element = React.createElement(PortfolioExportDocument, {
    optimization,
    isoTimestamp,
    isoDate,
  }) as unknown as React.ReactElement<DocumentProps>;
  const buf = await renderToBuffer(element);

  // `renderToBuffer` returns a Node Buffer; convert to a fresh Uint8Array so
  // the Web `Response` constructor in the Next.js runtime accepts it without
  // any platform-specific surprises.
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="forge-portfolio-${isoDate}.pdf"`,
      'cache-control': 'no-store',
    },
  });
}
