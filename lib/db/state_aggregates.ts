/**
 * Task P3.23 — Per-state portfolio aggregates for the choropleth layer.
 *
 * Aggregates the live policy book by state (the policies.state column,
 * USPS two-letter codes seeded by scripts/seed_policy_book.py). Each
 * row exposes total TIV, total annual premium, and policy count — the
 * three quantities the choropleth's paint expression can encode.
 *
 * Both libSQL paths (Turso remote + local SQLite file) are honored
 * via lib/db/client.ts. WHERE filters drop rows with missing state so
 * a fresh-clone DB just yields [].
 */
import { db } from './client';

export interface StateAggregate {
  iso_code: string;        // USPS state code (e.g. 'FL')
  total_tiv: number;       // USD
  total_premium: number;   // USD/yr
  policy_count: number;
}

export async function stateAggregates(): Promise<StateAggregate[]> {
  const r = await db.execute({
    sql: `SELECT state AS iso_code,
                 SUM(tiv) AS total_tiv,
                 SUM(premium_annual) AS total_premium,
                 COUNT(*) AS policy_count
            FROM policies
           WHERE state IS NOT NULL AND state != ''
           GROUP BY state
           ORDER BY state ASC`,
    args: [],
  });
  return r.rows.map((row) => ({
    iso_code: String(row.iso_code ?? '').toUpperCase(),
    total_tiv: Number(row.total_tiv ?? 0),
    total_premium: Number(row.total_premium ?? 0),
    policy_count: Number(row.policy_count ?? 0),
  })).filter((r) => r.iso_code.length > 0);
}
