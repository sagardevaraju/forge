/**
 * /api/sim — list + create.
 *
 *   GET  /api/sim                   list all sims (newest first)
 *   POST /api/sim { name, footprint } create draft + return preview impact
 *
 * Task 9: POST /api/sim (create draft) + GET /api/sim (list)
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db/client';
import { newSimId } from '@/lib/sim/id';
import { validateFootprint, type SimulationFootprint } from '@/lib/sim/footprint';
import { previewImpact, type Policy } from '@/lib/sim/preview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CreateBody {
  name?: string;
  footprint?: SimulationFootprint;
}

async function loadBookPolicies(): Promise<Policy[]> {
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

export async function GET(_req: Request): Promise<Response> {
  const r = await db.execute(
    'SELECT id, name, peril, intensity, promoted, retired, drawn_at, promoted_at, retired_at FROM simulations ORDER BY drawn_at DESC LIMIT 100',
  );
  return NextResponse.json({
    sims: r.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      peril: String(row.peril),
      intensity: String(row.intensity),
      promoted: Number(row.promoted) === 1,
      retired: Number(row.retired) === 1,
      drawn_at: String(row.drawn_at),
      promoted_at: row.promoted_at ? String(row.promoted_at) : null,
      retired_at: row.retired_at ? String(row.retired_at) : null,
    })),
  });
}

export async function POST(req: Request): Promise<Response> {
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const name = body.name?.trim();
  const fp = body.footprint;
  if (!name || !fp) {
    return NextResponse.json({ error: 'name and footprint required' }, { status: 400 });
  }
  const v = validateFootprint(fp);
  if (!v.ok) {
    return NextResponse.json({ error: v.reason }, { status: 400 });
  }

  const id = newSimId();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO simulations
          (id, name, peril, intensity, footprint, effective_date, drawn_by, drawn_at, promoted, retired)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    args: [id, name, fp.peril, fp.intensity, JSON.stringify(fp), fp.effective_date,
           fp.metadata.drawn_by, now],
  });

  // Compute preview impact synchronously so the client gets immediate numbers.
  const policies = await loadBookPolicies();
  const impact = previewImpact(policies, fp);

  return NextResponse.json({ sim_id: id, impact }, { status: 201 });
}
