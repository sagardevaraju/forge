/**
 * loadBookPolicies — read the geocoded policy book for the client-side
 * single-draw preview impact (lib/sim/preview.ts::previewImpact).
 *
 * Shared by POST /api/sim (impact for a freshly-drawn footprint) and the
 * /simulate page (impact for a footprint loaded by ?id=) so the two read
 * the book through one query and can never drift apart.
 */
import { db } from '@/lib/db/client';
import type { Policy } from './preview';

export async function loadBookPolicies(): Promise<Policy[]> {
  const r = await db.execute(
    'SELECT id, lat, lon, tiv, build_type, zip3 FROM policies WHERE lat IS NOT NULL AND lon IS NOT NULL',
  );
  return r.rows.map((row) => ({
    id: Number(row.id),
    lat: Number(row.lat),
    lon: Number(row.lon),
    tiv: Number(row.tiv),
    build_type: String(row.build_type ?? 'wood_frame'),
    zip3: String(row.zip3),
  }));
}
