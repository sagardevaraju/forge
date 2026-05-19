/**
 * GET /api/sim/[id] — read a single simulation by id.
 * Task 10: returns 404 if missing, 400 if id format invalid.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db/client';
import { isValidSimId } from '@/lib/sim/id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (!isValidSimId(id)) {
    return NextResponse.json({ error: 'invalid sim_id' }, { status: 400 });
  }
  const r = await db.execute({
    sql: 'SELECT * FROM simulations WHERE id = ?',
    args: [id],
  });
  if (r.rows.length === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const row = r.rows[0];
  return NextResponse.json({
    id: String(row.id),
    name: String(row.name),
    peril: String(row.peril),
    intensity: String(row.intensity),
    footprint: JSON.parse(String(row.footprint)),
    effective_date: String(row.effective_date),
    drawn_by: String(row.drawn_by),
    drawn_at: String(row.drawn_at),
    promoted: Number(row.promoted) === 1,
    promoted_at: row.promoted_at ? String(row.promoted_at) : null,
    retired: Number(row.retired) === 1,
    retired_at: row.retired_at ? String(row.retired_at) : null,
  });
}
