/**
 * Server-side reader for the cached Portfolio MIP optimization from
 * `artifacts/portfolio_optimization.json` (refreshed by
 * `scripts/precompute_portfolio_optimization.py`).
 *
 * Types and client-safe helpers live in `lib/portfolio-actions.ts` so the
 * client bundle can `import type` without dragging Node fs APIs in.
 */
import { readFile, stat } from 'fs/promises';
import path from 'path';
import type { PortfolioOptimization } from '@/lib/portfolio-actions';

let cached: { mtime: number; value: PortfolioOptimization } | null = null;

export async function loadPortfolioOptimization(): Promise<PortfolioOptimization | null> {
  const p = path.join(process.cwd(), 'artifacts', 'portfolio_optimization.json');
  try {
    const s = await stat(p);
    if (cached && cached.mtime === s.mtimeMs) return cached.value;
    const raw = await readFile(p, 'utf-8');
    const value = JSON.parse(raw) as PortfolioOptimization;
    cached = { mtime: s.mtimeMs, value };
    return value;
  } catch {
    return null;
  }
}

// Re-export types so existing imports `from '@/lib/db/portfolio_optimization'`
// keep working transparently.
export type {
  ActionName,
  OptimizedAction,
  OptimizedCohort,
  PortfolioOptimization,
} from '@/lib/portfolio-actions';
export {
  indexByZip3,
  ACTION_LABELS,
  ACTION_COLORS,
} from '@/lib/portfolio-actions';
