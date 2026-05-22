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

/**
 * Distinct US state codes that the book has exposure in. Used by the
 * Events + Portfolio pages to scope NWS active-alert lookups to wherever
 * policies actually live, rather than hardcoding Florida. Returns an
 * empty array on a fresh DB (no policies seeded yet) so callers can fall
 * back to a sensible default without throwing.
 *
 * The query is trivial (a single index-friendly distinct on a 10k-row
 * table) so we don't bother with caching — the page is `force-dynamic`
 * and this is cheaper than the alert fetch itself.
 */
export async function getBookStates(): Promise<string[]> {
  const r = await db.execute({
    // SQLite treats double-quoted string literals as identifiers — use
    // single quotes for the empty-string check.
    sql: "SELECT DISTINCT state FROM policies WHERE state IS NOT NULL AND state != '' ORDER BY state",
    args: [],
  });
  return r.rows
    .map((row) => (typeof row.state === 'string' ? row.state.trim().toUpperCase() : ''))
    .filter((s) => s.length > 0);
}
