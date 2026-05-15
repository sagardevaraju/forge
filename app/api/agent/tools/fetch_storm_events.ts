/**
 * fetch_storm_events — query the local Turso storm_events table.
 *
 * Real DB read, no mocks; the table is seeded by scripts/ingest_storm_events.py.
 */
import { db } from '@/lib/db/client';

export interface FetchStormEventsArgs {
  state: string;
  since?: string; // 'YYYY' or 'YYYY-MM-DD' — only the year is used (we store year only).
}

export interface StormEventRow {
  event_id: string;
  year: number;
  state: string;
  county: string | null;
  event_type: string;
  peak_wind: number | null;
  damage_property: number | null;
}

export const fetchStormEvents = {
  name: 'fetch_storm_events',
  description:
    'Query historical storm events for a state (and optionally since a given year) from the local NOAA Storm Events ingest. Returns event_id, year, state, county, event_type, peak_wind, and damage_property.',
  parameters: {
    type: 'object' as const,
    properties: {
      state: { type: 'string', description: '2-letter US state code (e.g., FL)' },
      since: {
        type: 'string',
        description: "Optional year filter; either 'YYYY' or 'YYYY-MM-DD' — only the year is used.",
      },
    },
    required: ['state'],
  },
  handler: async (args: FetchStormEventsArgs): Promise<StormEventRow[]> => {
    if (!args?.state) throw new Error('state required');
    const sqlParts = ['SELECT event_id, year, state, county, event_type, peak_wind, damage_property FROM storm_events WHERE state = ?'];
    const sqlArgs: (string | number)[] = [args.state];
    if (args.since) {
      const year = Number(String(args.since).slice(0, 4));
      if (Number.isFinite(year)) {
        sqlParts.push('AND year >= ?');
        sqlArgs.push(year);
      }
    }
    sqlParts.push('ORDER BY year DESC, event_id LIMIT 500');
    const r = await db.execute({ sql: sqlParts.join(' '), args: sqlArgs });
    return r.rows.map((row) => ({
      event_id: String(row.event_id),
      year: Number(row.year),
      state: String(row.state),
      county: row.county == null ? null : String(row.county),
      event_type: String(row.event_type),
      peak_wind: row.peak_wind == null ? null : Number(row.peak_wind),
      damage_property: row.damage_property == null ? null : Number(row.damage_property),
    }));
  },
};
