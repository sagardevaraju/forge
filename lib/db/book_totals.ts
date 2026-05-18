/**
 * Book totals helper for the landing dashboard. Returns DB-only scalars:
 *   - tiv      : sum of policy TIV across the book
 *   - policies : count of policies in the book
 *
 * Both fallback DB paths (Turso remote + local SQLite file) are honored via
 * `lib/db/client.ts`. The COALESCE keeps the response shape stable when the
 * policy table is empty (fresh worktree before seed).
 *
 * Projected cession spend and open advisories used to live here as zeros
 * tagged "wired later"; they now live in app/page.tsx where the optimization
 * artifact and NHC cone tool are actually available.
 */
import { db } from './client';

export interface BookTotals {
  tiv: number;
  policies: number;
}

export async function computeBookTotals(): Promise<BookTotals> {
  const r = await db.execute({
    sql: 'SELECT COUNT(*) AS n, COALESCE(SUM(tiv), 0) AS tiv FROM policies',
    args: [],
  });
  return {
    tiv: Number(r.rows[0]?.tiv ?? 0),
    policies: Number(r.rows[0]?.n ?? 0),
  };
}
