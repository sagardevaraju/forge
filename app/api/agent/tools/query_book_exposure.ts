/**
 * query_book_exposure — aggregate carrier book exposure (TIV + policy count)
 * by ZIP3 for a given list of ZIP3 codes. Reads from the local Turso/SQLite
 * policies table.
 */
import { db } from '@/lib/db/client';

export interface QueryBookExposureArgs {
  zip3_list: string[];
}

export interface QueryBookExposureResult {
  total_tiv: number;
  policies: number;
  by_zip3: Record<string, { tiv: number; policies: number }>;
}

export const queryBookExposure = {
  name: 'query_book_exposure',
  description:
    'Return total insured value (TIV) and policy count in the carrier book, aggregated by the given ZIP3 codes.',
  parameters: {
    type: 'object' as const,
    properties: {
      zip3_list: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of 3-digit ZIP prefixes to aggregate over (e.g., ["330","331"])',
      },
    },
    required: ['zip3_list'],
  },
  handler: async (args: QueryBookExposureArgs): Promise<QueryBookExposureResult> => {
    if (!args?.zip3_list?.length) {
      return { total_tiv: 0, policies: 0, by_zip3: {} };
    }
    const placeholders = args.zip3_list.map(() => '?').join(',');
    const r = await db.execute({
      sql:
        `SELECT zip3, SUM(tiv) AS tiv, COUNT(*) AS policies ` +
        `FROM policies WHERE zip3 IN (${placeholders}) GROUP BY zip3`,
      args: args.zip3_list,
    });
    const by_zip3: Record<string, { tiv: number; policies: number }> = {};
    let total_tiv = 0;
    let total_policies = 0;
    for (const row of r.rows) {
      const zip3 = String(row.zip3);
      const tiv = Number(row.tiv);
      const policies = Number(row.policies);
      by_zip3[zip3] = { tiv, policies };
      total_tiv += tiv;
      total_policies += policies;
    }
    return { total_tiv, policies: total_policies, by_zip3 };
  },
};
