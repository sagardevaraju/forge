/**
 * GET /api/policies/points — returns lightweight policy records for map overlay.
 *
 * Returns { policies: [{ id, lat, lon, tiv, build_type, zip3 }] } filtered to
 * rows that have both lat and lon populated. Capped at 20,000 rows (the seeded
 * book is ~10k, so this is a safety limit only).
 *
 * Used by SimMap's "Policies" overlay toggle to show which policies fall inside
 * or outside a drawn footprint.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request): Promise<Response> {
  const r = await db.execute(
    'SELECT id, lat, lon, tiv, build_type, zip3 FROM policies WHERE lat IS NOT NULL AND lon IS NOT NULL LIMIT 20000',
  );
  const policies = r.rows.map((row) => ({
    id: Number(row.id),
    lat: Number(row.lat),
    lon: Number(row.lon),
    tiv: Number(row.tiv),
    build_type: String(row.build_type ?? 'wood_frame'),
    zip3: String(row.zip3),
  }));
  return NextResponse.json({ policies });
}
