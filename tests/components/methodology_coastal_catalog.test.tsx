/**
 * AUDIT.3 Phase 4 follow-up — `CoastalZip3Catalog` component tests.
 *
 * The view is a pure render of the cached `artifacts/coastal_zip3s.json`
 * payload. We pin:
 *   - Row count matches `n_zip3s` (so the loader's count reconciles with
 *     the dictionary it ships).
 *   - Elevation-descending sort (the inland-mountain → coastal-flat
 *     gradient is the read at a glance).
 *   - Sub-meter elevation formatting (Naples 341 at -1.25 m must read as
 *     "-1.3 m", not get rounded to 0).
 *   - Provenance footer carries the EPQS URL + the regen command (the
 *     LIVE_FEED chip on the section heading is only honest if the user
 *     can see how to refresh the snapshot).
 *   - Coastal-states list and min_policies threshold surface in the
 *     header strip.
 */
import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { CoastalZip3Catalog } from '@/components/methodology/CoastalZip3Catalog';
import type { CoastalZip3Catalog as CoastalZip3CatalogPayload } from '@/lib/methodology/coastal_zip3s';

afterEach(cleanup);

function makePayload(
  overrides: Partial<CoastalZip3CatalogPayload> = {},
): CoastalZip3CatalogPayload {
  return {
    catalog: {
      // Three rows spanning the realistic elevation range:
      // mountain inland (NC 287), mid-coastal (FL 320), barrier-island flat (FL 341).
      '287': { elev_m: 631.48, lat: 35.331276, lon: -82.460137, n_policies: 157 },
      '320': { elev_m: 8.7, lat: 30.32, lon: -81.65, n_policies: 284 },
      '341': { elev_m: -1.25, lat: 26.142174, lon: -81.789921, n_policies: 344 },
    },
    n_zip3s: 3,
    notes: 'test fixture',
    source: {
      centroid: 'AVG(lat,lon) over policies in coastal-state set',
      coastal_states: ['FL', 'TX', 'LA', 'AL', 'MS', 'GA', 'SC', 'NC'],
      elevation: 'USGS EPQS at the ZIP3 centroid',
      epqs_url: 'https://epqs.nationalmap.gov/v1/json',
      min_policies_per_zip3: 50,
    },
    ...overrides,
  };
}

describe('CoastalZip3Catalog', () => {
  test('renders one row per catalog entry', () => {
    render(<CoastalZip3Catalog payload={makePayload()} />);
    const table = screen.getByTestId('coastal-zip3-table');
    // -1 for the thead row.
    const bodyRows = within(table).getAllByRole('row').length - 1;
    expect(bodyRows).toBe(3);
  });

  test('sorts rows elevation-descending (mountain → coast)', () => {
    render(<CoastalZip3Catalog payload={makePayload()} />);
    const table = screen.getByTestId('coastal-zip3-table');
    const rows = within(table).getAllByRole('row').slice(1); // drop thead
    const zip3s = rows.map((r) => within(r).getAllByRole('cell')[0].textContent);
    expect(zip3s).toEqual(['287', '320', '341']);
  });

  test('renders sub-meter negative elevations honestly (no zero rounding)', () => {
    render(<CoastalZip3Catalog payload={makePayload()} />);
    // Naples 341 at -1.25 m must surface, not be rounded to "0.0 m".
    expect(screen.getByText('-1.3 m')).toBeTruthy();
    expect(screen.getByText('631.5 m')).toBeTruthy();
  });

  test('header strip surfaces coastal-states + min_policies', () => {
    render(<CoastalZip3Catalog payload={makePayload()} />);
    // The eight-state coastal set is part of the catalog's contract;
    // the threshold drives which ZIP3s qualify.
    expect(
      screen.getByText(/FL · TX · LA · AL · MS · GA · SC · NC/),
    ).toBeTruthy();
    expect(screen.getByText(/min 50 policies/)).toBeTruthy();
  });

  test('provenance footer cites EPQS + regen command', () => {
    render(<CoastalZip3Catalog payload={makePayload()} />);
    // EPQS URL is the single anchor a reviewer would click to verify
    // the underlying source of every elev_m on the table.
    const epqsLink = screen.getByRole('link', {
      name: 'https://epqs.nationalmap.gov/v1/json',
    });
    expect(epqsLink.getAttribute('href')).toBe(
      'https://epqs.nationalmap.gov/v1/json',
    );
    // The regen command is the only way a reader can refresh the snapshot
    // — the LIVE_FEED badge upstream is only honest if this is visible.
    expect(
      screen.getByText(/python -m scripts\.precompute_coastal_zip3s/),
    ).toBeTruthy();
  });

  test('policy counts render with locale separators for legibility', () => {
    const payload = makePayload({
      catalog: {
        '999': { elev_m: 10, lat: 30, lon: -81, n_policies: 1234 },
      },
      n_zip3s: 1,
    });
    render(<CoastalZip3Catalog payload={payload} />);
    expect(screen.getByText('1,234')).toBeTruthy();
  });
});
