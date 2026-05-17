/**
 * Task 8 (Redesign Phase 1) — book totals helper for the landing dashboard.
 *
 * Computes the four headline scalars surfaced on `/` via `ExecCard`:
 *   - tiv               : sum of policy TIV across the book
 *   - policies          : count of policies in the book
 *   - cessionSpendYtd   : Phase 2 stub (treaty object not yet landed → 0)
 *   - openAdvisories    : Task 25 stub (NHC cron not yet wired → 0)
 *
 * Both fallback DB paths (Turso remote + local SQLite file) are honored via
 * `lib/db/client.ts`. The COALESCE on `SUM(tiv)` keeps the response shape
 * stable when the policy table is empty (e.g. a fresh worktree before seed).
 */
import { db } from './client';

export interface BookTotals {
  tiv: number;
  policies: number;
  cessionSpendYtd: number;
  openAdvisories: number;
}

export async function computeBookTotals(): Promise<BookTotals> {
  const r = await db.execute({
    sql: 'SELECT COUNT(*) AS n, COALESCE(SUM(tiv), 0) AS tiv FROM policies',
    args: [],
  });
  return {
    tiv: Number(r.rows[0]?.tiv ?? 0),
    policies: Number(r.rows[0]?.n ?? 0),
    cessionSpendYtd: 0, // wired in Phase 2 when the treaty object lands
    openAdvisories: 0, // wired in Task 25 (cron polls NHC)
  };
}
