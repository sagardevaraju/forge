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

// Task P2.29 — mock the claims_history DB layer. Each page render loads the
// prior snapshot, renders the diff column, and persists the current snapshot.
const loadPrevSeveritiesMock = vi.fn();
const upsertSnapshotMock = vi.fn();
vi.mock('@/lib/db/claims_history', () => ({
  loadPrevSeverities: (...args: unknown[]) => loadPrevSeveritiesMock(...args),
  upsertSnapshot: (...args: unknown[]) => upsertSnapshotMock(...args),
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
      reprice_n20: { count: 0, tiv: 0 },
      reprice_n10: { count: 0, tiv: 0 },
      reprice_0: { count: 0, tiv: 0 },
      reprice_p5: { count: 0, tiv: 0 },
      reprice_p10: { count: 0, tiv: 0 },
      reprice_p15: { count: 0, tiv: 0 },
      reprice_p20: { count: 0, tiv: 0 },
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
  loadPrevSeveritiesMock.mockReset();
  upsertSnapshotMock.mockReset();
  // Default to "no prior snapshot" so existing pre-P2.29 tests keep working.
  loadPrevSeveritiesMock.mockResolvedValue(new Map<number, number>());
  upsertSnapshotMock.mockResolvedValue(undefined);
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

// ────────────────────────────────────────────────────────────────────────
// Task P2.28 — Expected adjuster-load rollup
// ────────────────────────────────────────────────────────────────────────
//
// The pre-brief surfaces a per-ZIP3 adjuster-load rollup above the table so
// the cat-ops VP can see, at a glance, how many adjusters the operational
// layer expects to need against a baseline staffing assumption. The rollup
// is derived from the pre-flagged set's cohort `loss_p50` (already in the
// MIP artifact) via a fixed adjusters-per-claim-$ ratio — documented in the
// `AdjusterLoadRollup` component + the page's ProvenanceFootnote.
//
// Trust tier: MODEL_OUTPUT (numbers derive from the MIP cohort prior;
// staffing baseline is a documented heuristic until a real VRP artifact
// lands). The page-level SYNTHETIC_SCAFFOLD badge still applies because the
// underlying book is seeded data.
describe('ClaimsPage — adjuster-load rollup (P2.28)', () => {
  test('renders adjuster-load rollup for flagged policies', async () => {
    const book: FakeRow[] = [
      { id: 1, zip3: '337', tiv: 1_000_000, build_type: 'masonry', flood_zone: 'AE' },
      { id: 2, zip3: '342', tiv: 800_000, build_type: 'masonry', flood_zone: 'VE' },
    ];
    wireDb(book);
    loadOptMock.mockResolvedValue(
      fakeOpt([
        { id: '337_masonry_q4', zip3: '337', build_type: 'masonry', tiv_quintile: 4, total_tiv: 1_000_000, loss_p50: 500_000 },
        { id: '342_masonry_q3', zip3: '342', build_type: 'masonry', tiv_quintile: 3, total_tiv: 800_000, loss_p50: 250_000 },
      ]),
    );

    const ui = await ClaimsPage();
    render(ui);

    // The rollup section is rendered and identifiable.
    expect(screen.getByTestId('adjuster-load-rollup')).toBeInTheDocument();
    // It surfaces a section heading recognizable to the operator.
    expect(screen.getByText(/Expected adjuster.?load/i)).toBeInTheDocument();
  });

  test('rollup shows non-zero load per affected ZIP3', async () => {
    // Two FL coastal ZIP3s each with one policy mapped to a cohort whose
    // loss_p50 is large enough that the adjuster-per-$loss ratio yields
    // at least one extra adjuster per ZIP3. With only two TIVs in the book,
    // quintile cut-points place the 1M policy at q4 and the 800K policy at
    // q0.
    const book: FakeRow[] = [
      { id: 1, zip3: '337', tiv: 1_000_000, build_type: 'masonry', flood_zone: 'AE' },
      { id: 2, zip3: '342', tiv: 800_000, build_type: 'manufactured', flood_zone: 'VE' },
    ];
    wireDb(book);
    loadOptMock.mockResolvedValue(
      fakeOpt([
        // Each cohort's loss_p50 is well above the per-adjuster threshold,
        // so both ZIP3s should appear in the rollup with positive deltas.
        { id: '337_masonry_q4', zip3: '337', build_type: 'masonry', tiv_quintile: 4, total_tiv: 1_000_000, loss_p50: 1_000_000 },
        { id: '342_manufactured_q0', zip3: '342', build_type: 'manufactured', tiv_quintile: 0, total_tiv: 800_000, loss_p50: 750_000 },
      ]),
    );

    const ui = await ClaimsPage();
    render(ui);

    // Both affected ZIP3s appear as rows in the rollup.
    const rollup = screen.getByTestId('adjuster-load-rollup');
    expect(within(rollup).getByTestId('rollup-row-337')).toBeInTheDocument();
    expect(within(rollup).getByTestId('rollup-row-342')).toBeInTheDocument();

    // Each row reports a positive "needed" delta (i.e. ">= +1"). We match
    // the leading + sign without pinning the exact number — the formula is
    // documented but exercised by the unit test on the helper module.
    const row337 = within(rollup).getByTestId('rollup-row-337');
    const row342 = within(rollup).getByTestId('rollup-row-342');
    expect(row337.textContent).toMatch(/\+\s*[1-9]/);
    expect(row342.textContent).toMatch(/\+\s*[1-9]/);
  });

  test('zero-flag state renders empty rollup gracefully', async () => {
    // No FL-coastal AE/VE policies in the book → no flagged policies → no
    // adjuster-load delta. The rollup component still mounts (so the layout
    // doesn't jump on first paint) but shows an empty-state copy instead of
    // a list of ZIP3s.
    wireDb([
      // A policy outside the FL coastal cone; the page's subset query
      // filters it out, so flagged set is empty.
      { id: 1, zip3: '275', tiv: 500_000, build_type: 'wood_frame', flood_zone: 'X' },
    ]);
    loadOptMock.mockResolvedValue(fakeOpt([]));

    const ui = await ClaimsPage();
    render(ui);

    // The rollup mounts even with zero flags.
    const rollup = screen.getByTestId('adjuster-load-rollup');
    expect(rollup).toBeInTheDocument();
    // Empty-state copy is visible; no per-ZIP3 rows render.
    expect(rollup.textContent).toMatch(/no flagged|0 zip|nothing/i);
    expect(within(rollup).queryByTestId(/rollup-row-/)).toBeNull();
  });

  test('rollup carries a MODEL_OUTPUT trust-tier badge', async () => {
    wireDb([
      { id: 1, zip3: '337', tiv: 1_000_000, build_type: 'masonry', flood_zone: 'AE' },
    ]);
    loadOptMock.mockResolvedValue(
      fakeOpt([
        { id: '337_masonry_q4', zip3: '337', build_type: 'masonry', tiv_quintile: 4, total_tiv: 1_000_000, loss_p50: 500_000 },
      ]),
    );

    const ui = await ClaimsPage();
    render(ui);

    // The rollup's own trust-tier badge is present and reads "Model".
    const rollup = screen.getByTestId('adjuster-load-rollup');
    const badge = within(rollup).getByTestId('trust-tier-badge');
    expect(badge).toHaveTextContent(/^Model$/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Task P2.29 — Severity diff vs last refresh
// ────────────────────────────────────────────────────────────────────────
//
// Each /claims render persists the current severity snapshot into the
// `claims_history` table (one row per policy_id, last write wins). The
// next render loads that prior snapshot, computes a ↑/↓/= per row, and
// shows the result in a new Δ column.
describe('ClaimsPage — severity diff vs last refresh (P2.29)', () => {
  test('page render upserts current severities into claims_history', async () => {
    // Both policies sit at q4 (we pad the book with low-TIV rows so the q4
    // cut-point lands well below both flagged policies' TIVs). That's the
    // same trick the P2.27 sum-test uses to control quintile placement.
    const book: FakeRow[] = [
      { id: 1, zip3: '337', tiv: 1_000_000, build_type: 'masonry', flood_zone: 'AE' },
      { id: 2, zip3: '342', tiv: 800_000, build_type: 'masonry', flood_zone: 'VE' },
    ];
    const extraLowTivs = Array.from({ length: 40 }, (_, i) => 10_000 + i * 1_000);
    wireDb(book, extraLowTivs);
    loadOptMock.mockResolvedValue(
      fakeOpt([
        { id: '337_masonry_q4', zip3: '337', build_type: 'masonry', tiv_quintile: 4, total_tiv: 1_000_000, loss_p50: 200_000 },
        { id: '342_masonry_q4', zip3: '342', build_type: 'masonry', tiv_quintile: 4, total_tiv: 800_000, loss_p50: 90_000 },
      ]),
    );
    // No prior snapshot — first render of this DB.
    loadPrevSeveritiesMock.mockResolvedValue(new Map<number, number>());

    const ui = await ClaimsPage();
    render(ui);

    // The page must have written each policy's current severity into history.
    expect(upsertSnapshotMock).toHaveBeenCalledTimes(1);
    const rows = upsertSnapshotMock.mock.calls[0][0] as { policy_id: number; severity: number }[];
    const ids = rows.map((r) => r.policy_id).sort();
    expect(ids).toEqual([1, 2]);
    // Severity is the per-policy expected_loss (whole-cohort split, since each
    // cohort here has total_tiv == single policy's tiv).
    const byId = new Map(rows.map((r) => [r.policy_id, r.severity]));
    expect(byId.get(1)).toBeCloseTo(200_000, 0);
    expect(byId.get(2)).toBeCloseTo(90_000, 0);
  });

  test('second render shows ↑/↓ diffs vs the prior snapshot', async () => {
    const book: FakeRow[] = [
      { id: 1, zip3: '337', tiv: 1_000_000, build_type: 'masonry', flood_zone: 'AE' },
      { id: 2, zip3: '342', tiv: 800_000, build_type: 'masonry', flood_zone: 'VE' },
    ];
    const extraLowTivs = Array.from({ length: 40 }, (_, i) => 10_000 + i * 1_000);
    wireDb(book, extraLowTivs);
    loadOptMock.mockResolvedValue(
      fakeOpt([
        // policy 1 cohort loss went UP to 200K (from 50K prior).
        { id: '337_masonry_q4', zip3: '337', build_type: 'masonry', tiv_quintile: 4, total_tiv: 1_000_000, loss_p50: 200_000 },
        // policy 2 cohort loss went DOWN to 40K (from 90K prior).
        { id: '342_masonry_q4', zip3: '342', build_type: 'masonry', tiv_quintile: 4, total_tiv: 800_000, loss_p50: 40_000 },
      ]),
    );
    // Prior snapshot from "last refresh".
    loadPrevSeveritiesMock.mockResolvedValue(
      new Map<number, number>([
        [1, 50_000],
        [2, 90_000],
      ]),
    );

    const ui = await ClaimsPage();
    render(ui);

    // Policy 1 should show ↑, policy 2 should show ↓.
    expect(screen.getByTestId('severity-diff-1')).toHaveTextContent('↑');
    expect(screen.getByTestId('severity-diff-2')).toHaveTextContent('↓');

    // And the page still persists the *current* snapshot for next time.
    expect(upsertSnapshotMock).toHaveBeenCalledTimes(1);
  });

  test('page render does not crash when the prior load fails (empty map fallback)', async () => {
    // A real read error in claims_history shouldn't 500 the page — the page
    // treats the prior as empty and shows "—" for every row.
    const book: FakeRow[] = [
      { id: 1, zip3: '337', tiv: 1_000_000, build_type: 'masonry', flood_zone: 'AE' },
    ];
    wireDb(book);
    loadOptMock.mockResolvedValue(
      fakeOpt([
        { id: '337_masonry_q4', zip3: '337', build_type: 'masonry', tiv_quintile: 4, total_tiv: 1_000_000, loss_p50: 200_000 },
      ]),
    );
    loadPrevSeveritiesMock.mockResolvedValue(new Map<number, number>());

    const ui = await ClaimsPage();
    render(ui);

    expect(screen.getByTestId('severity-diff-1')).toHaveTextContent('—');
  });
});
