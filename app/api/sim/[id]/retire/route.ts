/**
 * POST /api/sim/[id]/retire — Task 12
 *
 * Soft-deletes a simulation by flipping retired=1 and recording retired_at.
 * Retired sims are excluded from the portfolio reoptimize TVaR-99 computation.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db/client';
import { isValidSimId } from '@/lib/sim/id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!isValidSimId(id)) {
    return NextResponse.json({ error: 'invalid sim_id' }, { status: 400 });
  }
  const now = new Date().toISOString();
  const r = await db.execute({
    sql: 'UPDATE simulations SET retired = 1, retired_at = ? WHERE id = ?',
    args: [now, id],
  });
  if (Number(r.rowsAffected) === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
