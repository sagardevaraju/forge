// @vitest-environment node
/**
 * Task P2.30 — Print-to-PDF route for the Portfolio view.
 *
 * The route renders a static "board-deck" PDF from the cached
 * `artifacts/portfolio_optimization.json` artifact. Implementation uses
 * `@react-pdf/renderer` (path (b) from the task brief) — a declarative,
 * server-side React → PDF compiler. No chromium, no playwright cold-start.
 *
 * Coverage:
 *   1. Happy path — 200, Content-Type application/pdf, magic bytes %PDF-.
 *   2. Filename header carries the current ISO date.
 *   3. Missing artifact → 503 with a clear error JSON.
 *   4. Empty cohort list does not crash; route still returns 200 PDF.
 *   5. Rendered PDF body mentions the artifact's schema_version + objective.
 *   6. Rendered PDF body lists the six action-set rows.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/db/portfolio_optimization', () => ({
  loadPortfolioOptimization: vi.fn(),
}));

import { GET } from '@/app/portfolio/export/route';
import { loadPortfolioOptimization } from '@/lib/db/portfolio_optimization';

const loaderMock = loadPortfolioOptimization as unknown as ReturnType<typeof vi.fn>;

const SAMPLE_OPT = {
  schema_version: 3,
  status: 'Optimal',
  objective: 44_483_580.88,
  horizon_start: '2026-07-01',
  horizon_end: '2027-06-30',
  budgets: {
    capital_budget: 23_520_237.04,
    max_nonrenew_pct: 0.15,
    cession_budget: 5_274_104.19,
  },
  book_totals: {
    tiv: 3_185_865_814.46,
    premium: 52_741_041.93,
    loss_p50: 19_600_197.53,
    loss_p99: 78_400_790.13,
  },
  action_summary: {
    retain: { count: 100, tiv: 500_000_000 },
    reprice_up: { count: 197, tiv: 1_067_874_157.26 },
    reprice_down: { count: 50, tiv: 200_000_000 },
    non_renew: { count: 10, tiv: 50_000_000 },
    cede_qs: { count: 5, tiv: 25_000_000 },
    cede_xs: { count: 373, tiv: 2_117_991_657.20 },
  },
  cohorts: [
    {
      id: '275_wood_frame_q0',
      zip3: '275',
      build_type: 'wood_frame',
      tiv_quintile: 0,
      policy_count: 5,
      total_tiv: 500_000,
      total_premium: 5_000,
      modal_flood_zone: 'X',
      avg_elevation_m: 3,
      loss_p50: 2_500,
      loss_p99: 10_000,
    },
  ],
  actions: [],
};

function decodePdf(buf: Uint8Array): string {
  // PDF content streams are typically FlateDecode-compressed. Inside the
  // decompressed content, text shows up as PDF text-showing operators —
  // most commonly:
  //   (literal string) Tj
  //   [(part) kern (part)] TJ
  //   <hex bytes> Tj
  //   [<hex> kern <hex>] TJ
  // @react-pdf emits hex strings with single-byte glyph IDs (subset font),
  // and for standard PDF fonts those glyph IDs are PDFDocEncoding code
  // points — which collapse to ASCII for the printable subset we care
  // about. So we inflate every stream and translate hex strings to ASCII.
  const latin1 = Buffer.from(buf).toString('latin1');
  const parts: string[] = [latin1];
  const zlib = require('node:zlib') as typeof import('node:zlib');
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  const inflatedChunks: string[] = [];
  while ((m = streamRe.exec(latin1))) {
    try {
      const inflated = zlib.inflateSync(Buffer.from(m[1], 'latin1'));
      inflatedChunks.push(inflated.toString('latin1'));
    } catch {
      // ignore — some streams are images / other binary
    }
  }
  function hexToAscii(hex: string): string {
    const cleaned = hex.replace(/\s+/g, '');
    if (cleaned.length % 2 !== 0) return '';
    let out = '';
    for (let i = 0; i < cleaned.length; i += 2) {
      const code = parseInt(cleaned.slice(i, i + 2), 16);
      if (code >= 0x20 && code <= 0x7e) out += String.fromCharCode(code);
    }
    return out;
  }
  for (const chunk of inflatedChunks) {
    parts.push(chunk);
    // Decode TJ arrays: `[<hex> kern <hex> kern …] TJ` — concatenate every
    // hex token in order, ignoring numeric kerning. This is what makes the
    // word "Retain" reassemble even though @react-pdf emits glyph runs as
    // `<5265746169> 0 <6e>`.
    const tjArrayRe = /\[([^\]]+)\]\s*TJ/g;
    let tj: RegExpExecArray | null;
    while ((tj = tjArrayRe.exec(chunk))) {
      const inner = tj[1];
      const hexRe = /<([0-9a-fA-F\s]+)>/g;
      let h: RegExpExecArray | null;
      let assembled = '';
      while ((h = hexRe.exec(inner))) {
        assembled += hexToAscii(h[1]);
      }
      if (assembled) parts.push(assembled);
    }
    // Also decode bare `<hex> Tj` outputs and standalone hex segments.
    const tjBareRe = /<([0-9a-fA-F\s]+)>\s*Tj/g;
    let tb: RegExpExecArray | null;
    while ((tb = tjBareRe.exec(chunk))) {
      parts.push(hexToAscii(tb[1]));
    }
    // Decode `(literal) Tj` operands too — they're already ASCII.
    const litRe = /\(([^()\\]+)\)\s*Tj/g;
    let l: RegExpExecArray | null;
    while ((l = litRe.exec(chunk))) {
      parts.push(l[1]);
    }
  }
  return parts.join('\n');
}

beforeEach(() => {
  loaderMock.mockReset();
  loaderMock.mockResolvedValue(SAMPLE_OPT);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /portfolio/export', () => {
  test('happy path — 200, application/pdf, %PDF- magic bytes', async () => {
    const r = await GET();
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/application\/pdf/i);
    const body = new Uint8Array(await r.arrayBuffer());
    expect(body.length).toBeGreaterThan(0);
    // ASCII '%PDF-' magic.
    expect(body[0]).toBe(0x25);
    expect(body[1]).toBe(0x50);
    expect(body[2]).toBe(0x44);
    expect(body[3]).toBe(0x46);
    expect(body[4]).toBe(0x2d);
  });

  test('Content-Disposition includes ISO date in filename', async () => {
    const r = await GET();
    expect(r.status).toBe(200);
    const cd = r.headers.get('content-disposition');
    expect(cd).toBeTruthy();
    expect(cd).toMatch(/attachment/i);
    // ISO date prefix yyyy-mm-dd.
    const iso = new Date().toISOString().slice(0, 10);
    expect(cd).toContain(`forge-portfolio-${iso}.pdf`);
  });

  test('missing artifact — 503 with clear error JSON', async () => {
    loaderMock.mockResolvedValueOnce(null);
    const r = await GET();
    expect(r.status).toBe(503);
    expect(r.headers.get('content-type')).toMatch(/application\/json/i);
    const body = await r.json();
    expect(body.error).toBeTruthy();
    expect(String(body.error)).toMatch(/artifact|portfolio_optimization|not found/i);
  });

  test('empty cohort list — still renders without crashing', async () => {
    loaderMock.mockResolvedValueOnce({ ...SAMPLE_OPT, cohorts: [], actions: [] });
    const r = await GET();
    expect(r.status).toBe(200);
    const body = new Uint8Array(await r.arrayBuffer());
    expect(body.length).toBeGreaterThan(0);
    // Still a valid PDF.
    expect(Buffer.from(body.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
  });

  test('PDF body mentions the schema_version and objective', async () => {
    const r = await GET();
    const body = new Uint8Array(await r.arrayBuffer());
    const text = decodePdf(body);
    // schema_version 3 from artifact.
    expect(text).toMatch(/schema_version\s*3/i);
    // Objective shows up as a formatted millions figure ($44 with M suffix).
    expect(text).toMatch(/44/);
    // Provenance footer reference.
    expect(text).toMatch(/portfolio_optimization\.json/);
  });

  test('PDF body includes the action-mix rows', async () => {
    const r = await GET();
    const body = new Uint8Array(await r.arrayBuffer());
    const text = decodePdf(body);
    // P2.8 swapped the two reprice scalars for a 7-bucket rate grid; the
    // canonical action labels now read "Reprice -20%" through "Reprice
    // +20%" plus the four non-reprice ids (Retain, Non-renew, Cede QS,
    // Cede XS).
    expect(text).toMatch(/Retain/i);
    expect(text).toMatch(/Reprice/i);
    expect(text).toMatch(/Non-renew/i);
    expect(text).toMatch(/Cede.*quota share/i);
    expect(text).toMatch(/Cede.*excess of loss/i);
  });
});
