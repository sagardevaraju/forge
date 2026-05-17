/**
 * Task P2.27 — Claims Pre-Brief loss column comes from the cohort prior.
 *
 * Before P2.27 the page derived `expected_loss = LOSS_FACTOR[severity] × tiv`
 * with a hard-coded flood-zone heuristic and surfaced the column under a
 * `SYNTHETIC_SCAFFOLD` trust tier. After P2.27 the column reads
 * `loss_p50` per cohort from `artifacts/portfolio_optimization.json` and
 * splits it proportionally to each policy's TIV, so the column is now
 * `MODEL_OUTPUT`. The seed policy book itself is still synthetic, so the
 * *page-level* badge stays `SYNTHETIC_SCAFFOLD` — the loss column moves
 * up a tier while the rest of the page does not.
 *
 * Tests mock both the libSQL client (so the test doesn't depend on a
 * migrated `forge-local.db`) and the artifact loader. Each test feeds
 * a deterministic mini-book and a deterministic mini-artifact.
 */
import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

// Mock the libSQL client BEFORE importing the page.
const executeMock = vi.fn();
vi.mock('@/lib/db/client', () => ({
  db: {
    execute: (...args: unknown[]) => executeMock(...args),
  },
}));

// Mock the artifact loader. The page reads `loadPortfolioOptimization()` to
// pull cohort `loss_p50` + `total_tiv`.
const loadOptMock = vi.fn();
vi.mock('@/lib/db/portfolio_optimization', () => ({
  loadPortfolioOptimization: (...args: unknown[]) => loadOptMock(...args),
}));

import ClaimsPage from '@/app/claims/page';

// ────────────────────────────────────────────────────────────────────────
// Fixture builders
// ────────────────────────────────────────────────────────────────────────
type FakeRow = {
  id: number;
  zip3: string;
  tiv: number;
  build_type: string;
  flood_zone: string;
};

/**
 * Wire the db.execute mock so:
 *   - The TIV cut-point query (selects all TIVs) returns the supplied book.
 *   - The FL-coastal subset query returns the filtered + ordered rows.
 *
 * If `extraBookTivs` is supplied, those extra TIVs are appended to the "all
 * TIVs" response only — they are *not* surfaced in the FL coastal subset.
 * The fixture uses this to control which quintile a test policy falls into
 * without affecting the rendered table rows. (Without padding, a 3-row book
 * has 3 TIVs and the quintile cuts place each row in a different bucket.)
 *
 * The page is free to issue these in either order; the mock dispatches on
 * the SQL text.
 */
function wireDb(book: FakeRow[], extraBookTivs: number[] = []) {
  executeMock.mockReset();
  executeMock.mockImplementation(
    async (q: { sql: string; args?: unknown[] } | string) => {
      const sql = typeof q === 'string' ? q : q.sql;
      // The "all TIVs" query for quintile cut-points.
      if (/FROM\s+policies/i.test(sql) && !/flood_zone\s+IN/i.test(sql)) {
        const tivs = [
          ...book.map((p) => ({ tiv: p.tiv })),
          ...extraBookTivs.map((t) => ({ tiv: t })),
        ];
        return { rows: tivs };
      }
      // The FL-coastal subset query.
      const fl = new Set(['332', '334', '335', '337', '338', '339', '341', '342', '346']);
      const filtered = book
        .filter((p) => fl.has(p.zip3) && (p.flood_zone === 'AE' || p.flood_zone === 'VE'))
        .sort((a, b) => b.tiv - a.tiv)
        .slice(0, 500);
      return {
        rows: filtered.map((p) => ({
          id: p.id,
          zip3: p.zip3,
          tiv: p.tiv,
          build_type: p.build_type,
          flood_zone: p.flood_zone,
        })),
      };
    },
  );
}

/** Build a minimal portfolio-optimization artifact with the cohorts the
 *  test cares about. Only `cohorts` is consulted by the page; the rest of
 *  the shape is filled in with zeros to satisfy the TypeScript type. */
function fakeOpt(
  cohorts: { id: string; zip3: string; build_type: string; tiv_quintile: number; total_tiv: number; loss_p50: number }[],
) {
  return {
    schema_version: 3,
    status: 'Optimal',
    objective: 0,
    horizon_start: '2026-07-01',
    horizon_end: '2027-06-30',
    budgets: { capital_budget: 0, max_nonrenew_pct: 0, cession_budget: 0 },
    book_totals: { tiv: 0, premium: 0, loss_p50: 0, loss_p99: 0 },
    action_summary: {
      retain: { count: 0, tiv: 0 },
      reprice_up: { count: 0, tiv: 0 },
      reprice_down: { count: 0, tiv: 0 },
      non_renew: { count: 0, tiv: 0 },
      cede_qs: { count: 0, tiv: 0 },
      cede_xs: { count: 0, tiv: 0 },
    },
    cohorts: cohorts.map((c) => ({
      id: c.id,
      zip3: c.zip3,
      build_type: c.build_type,
      tiv_quintile: c.tiv_quintile,
      policy_count: 1,
      total_tiv: c.total_tiv,
      total_premium: 0,
      modal_flood_zone: 'AE',
      avg_elevation_m: 0,
      loss_p50: c.loss_p50,
      loss_p99: c.loss_p50 * 4,
    })),
    actions: [],
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  executeMock.mockReset();
  loadOptMock.mockReset();
});

describe('ClaimsPage — cohort loss_p50 replaces LOSS_FACTOR heuristic', () => {
  test('renders the loss column with a MODEL_OUTPUT trust tier on the loss section', async () => {
    // Single FL-coastal policy mapped to a single cohort in the artifact.
    const book: FakeRow[] = [
      { id: 1, zip3: '337', tiv: 1_000_000, build_type: 'masonry', flood_zone: 'AE' },
    ];
    wireDb(book);
    loadOptMock.mockResolvedValue(
      fakeOpt([
        { id: '337_masonry_q4', zip3: '337', build_type: 'masonry', tiv_quintile: 4, total_tiv: 1_000_000, loss_p50: 200_000 },
      ]),
    );

    const ui = await ClaimsPage();
    render(ui);

    // The loss column header should be present in the rendered table.
    expect(screen.getByText(/Expected loss/i)).toBeInTheDocument();

    // A dedicated trust-tier marker for the loss column exists and reads MODEL_OUTPUT.
    const lossTier = screen.getByTestId('loss-trust-tier');
    const badge = within(lossTier).getByTestId('trust-tier-badge');
    // `lib/grammar/trust-tiers.ts` renders MODEL_OUTPUT with the label "Model".
    expect(badge).toHaveTextContent(/^Model$/);
  });

  test('loss values are the proportional split of cohort loss_p50 (single-policy cohort)', async () => {
    // Single policy that absorbs the entire cohort -> per-policy loss = loss_p50.
    const book: FakeRow[] = [
      { id: 42, zip3: '337', tiv: 800_000, build_type: 'masonry', flood_zone: 'AE' },
    ];
    wireDb(book);
    loadOptMock.mockResolvedValue(
      fakeOpt([
        { id: '337_masonry_q4', zip3: '337', build_type: 'masonry', tiv_quintile: 4, total_tiv: 800_000, loss_p50: 123_456 },
      ]),
    );

    const ui = await ClaimsPage();
    render(ui);

    // The row should display $123,456 (rounded with locale separators).
    const formatted = (123456).toLocaleString(undefined, { maximumFractionDigits: 0 });
    expect(screen.getByText(`$${formatted}`)).toBeInTheDocument();
  });

  test('ProvenanceFootnote cites the cohort/MIP prior, not the flood-zone heuristic', async () => {
    wireDb([
      { id: 1, zip3: '337', tiv: 500_000, build_type: 'masonry', flood_zone: 'AE' },
    ]);
    loadOptMock.mockResolvedValue(
      fakeOpt([
        { id: '337_masonry_q2', zip3: '337', build_type: 'masonry', tiv_quintile: 2, total_tiv: 500_000, loss_p50: 50_000 },
      ]),
    );

    const ui = await ClaimsPage();
    render(ui);

    const footnote = screen.getByTestId('provenance-footnote');
    // New provenance must mention the MIP/cohort prior.
    expect(footnote.textContent).toMatch(/cohort.*loss_p50|portfolio.*mip|hazus/i);
    // And must NOT mention the old LOSS_FACTOR heuristic.
    expect(footnote.textContent).not.toMatch(/LOSS_FACTOR/);
  });

  test('proportional split sums (approximately) to the cohort loss_p50', async () => {
    // Three policies in the same cohort. Cohort total_tiv from the artifact
    // is the sum across the whole book (3M here). Per-policy loss should sum
    // to the cohort loss_p50 within float tolerance.
    //
    // To force all three test policies into the *same* quintile (q4) we pad
    // the "whole book" TIV query with 40 low-TIV policies so the q4 cut-point
    // sits well below the smallest test policy's 500K TIV.
    const book: FakeRow[] = [
      { id: 1, zip3: '337', tiv: 1_500_000, build_type: 'masonry', flood_zone: 'AE' },
      { id: 2, zip3: '337', tiv: 1_200_000, build_type: 'masonry', flood_zone: 'AE' },
      { id: 3, zip3: '337', tiv: 900_000, build_type: 'masonry', flood_zone: 'AE' },
    ];
    const extraLowTivs = Array.from({ length: 40 }, (_, i) => 10_000 + i * 1_000);
    wireDb(book, extraLowTivs);
    const cohortLoss = 600_000;
    const totalTiv = book.reduce((s, p) => s + p.tiv, 0); // 3.6M
    loadOptMock.mockResolvedValue(
      fakeOpt([
        // total_tiv on the cohort is the sum across the whole book — here
        // equal to the FL-coastal-subset sum because all 3 policies are in
        // cone and share (zip3, build_type, q4).
        { id: '337_masonry_q4', zip3: '337', build_type: 'masonry', tiv_quintile: 4, total_tiv: totalTiv, loss_p50: cohortLoss },
      ]),
    );

    const ui = await ClaimsPage();
    render(ui);

    // Each row renders a $-prefixed loss. We assert all three values appear
    // (in the rounded locale-formatted form) and sum to ~ the cohort loss_p50.
    const expected = book.map((p) => Math.round(cohortLoss * (p.tiv / totalTiv)));
    let total = 0;
    for (const v of expected) {
      const formatted = v.toLocaleString(undefined, { maximumFractionDigits: 0 });
      expect(screen.getByText(`$${formatted}`)).toBeInTheDocument();
      total += v;
    }
    // Sum of per-policy losses ≈ cohort loss_p50 (within rounding tolerance).
    expect(Math.abs(total - cohortLoss)).toBeLessThanOrEqual(3);
  });

  test('policy with no matching cohort displays "—" rather than zero', async () => {
    // The artifact has a cohort for `337_masonry_q?` but the policy lives in
    // a (zip3, build_type) pair the artifact doesn't cover. We expect "—".
    const book: FakeRow[] = [
      { id: 99, zip3: '337', tiv: 700_000, build_type: 'masonry', flood_zone: 'AE' },
    ];
    wireDb(book);
    loadOptMock.mockResolvedValue(
      fakeOpt([
        // Different zip3 + build_type — won't match the FL coastal policy.
        { id: '275_wood_frame_q0', zip3: '275', build_type: 'wood_frame', tiv_quintile: 0, total_tiv: 500_000, loss_p50: 5_000 },
      ]),
    );

    const ui = await ClaimsPage();
    render(ui);

    // The row should display "—" (em-dash) in the loss column, not $0.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });

  test('missing / empty artifact → page renders without crashing, all losses "—"', async () => {
    wireDb([
      { id: 1, zip3: '337', tiv: 800_000, build_type: 'masonry', flood_zone: 'AE' },
      { id: 2, zip3: '342', tiv: 600_000, build_type: 'manufactured', flood_zone: 'VE' },
    ]);
    // Artifact missing entirely.
    loadOptMock.mockResolvedValue(null);

    const ui = await ClaimsPage();
    render(ui);

    // Page mounted; loss column is rendered; every loss cell is "—".
    expect(screen.getByText(/Expected loss/i)).toBeInTheDocument();
    // Two policies → two "—" cells in the loss column.
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  test('page-level SYNTHETIC_SCAFFOLD badge is preserved (the seed book is still synthetic)', async () => {
    wireDb([
      { id: 1, zip3: '337', tiv: 800_000, build_type: 'masonry', flood_zone: 'AE' },
    ]);
    loadOptMock.mockResolvedValue(
      fakeOpt([
        { id: '337_masonry_q4', zip3: '337', build_type: 'masonry', tiv_quintile: 4, total_tiv: 800_000, loss_p50: 50_000 },
      ]),
    );
    const ui = await ClaimsPage();
    render(ui);
    // Two badges total: a page-level SYNTHETIC_SCAFFOLD on the seed book,
    // and the per-column MODEL_OUTPUT on the loss column. Confirm both
    // labels are present in the document.
    const badges = screen.getAllByTestId('trust-tier-badge');
    const labels = badges.map((b) => b.textContent);
    expect(labels).toContain('Demo'); // SYNTHETIC_SCAFFOLD label
    expect(labels).toContain('Model'); // MODEL_OUTPUT label
  });
});
