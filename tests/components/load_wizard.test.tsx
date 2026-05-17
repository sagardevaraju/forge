/**
 * Task P2.39 — /load wizard component tests.
 *
 * Covers the three-step flow:
 *   1. Upload step advances to step 2 once a CSV is picked + parsed.
 *   2. PII-named columns are flagged + disabled (and listed as refused).
 *   3. suggestMapping wires defaults for the standard carrier columns.
 *   4. Confirm step renders a preview table of up to 5 mapped rows.
 *   5. Import POSTs the mapped rows + lineage to /api/book/upload-wizard.
 *
 * next/navigation's useRouter is stubbed so the redirect-on-success path
 * doesn't reach into Next.js internals.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
} from '@testing-library/react';
import { LoadWizard } from '@/components/LoadWizard';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const HEADER = [
  'PolicyID',
  'State',
  'Zip3',
  'Latitude',
  'Longitude',
  'TIV',
  'BuildType',
  'FloodZone',
  'customer_name', // PII
  'email',          // PII
];

const SAMPLE_CSV = [
  HEADER.join(','),
  '101,FL,331,25.7,-80.2,250000,wood_frame,AE,Acme LLC,a@b.com',
  '102,TX,770,29.7,-95.3,180000,masonry,X,Beta Co,b@b.com',
  '103,LA,703,30.1,-91.0,320000,manufactured,VE,Gamma,c@b.com',
  '104,NC,275,35.7,-78.6,210000,wood_frame,A,Delta,d@b.com',
  '105,FL,332,26.2,-80.1,290000,masonry,AE,Epsilon,e@b.com',
  '106,FL,334,27.1,-82.0,150000,wood_frame,X,Zeta,f@b.com',
].join('\n');

function makeCsvFile(name = 'carrier_book.csv') {
  return new File([SAMPLE_CSV], name, { type: 'text/csv' });
}

async function pickFile(file = makeCsvFile()) {
  const input = screen.getByTestId('wizard-file-input') as HTMLInputElement;
  // jsdom doesn't honor `accept`, just assign the file directly.
  fireEvent.change(input, { target: { files: [file] } });
  // Wait for the async parse to flip state to step 2.
  await waitFor(() => expect(screen.getByTestId('wizard-step-2')).toBeTruthy());
}

describe('LoadWizard', () => {
  beforeEach(() => {
    // Default fetch stub for the import POST.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          accepted: 6,
          rejected: 0,
          errors: [],
          refused_columns: ['customer_name', 'email'],
          optimization: 'refreshed',
        }),
      })),
    );
  });

  test('starts on step 1', () => {
    render(<LoadWizard />);
    expect(screen.getByTestId('wizard-step-1')).toBeTruthy();
    expect(screen.queryByTestId('wizard-step-2')).toBeNull();
  });

  test('step 1 → step 2 advances when a CSV is picked', async () => {
    render(<LoadWizard />);
    await pickFile();
    expect(screen.getByTestId('wizard-step-2')).toBeTruthy();
  });

  test('suggestMapping wires defaults for tiv/zip3/build_type', async () => {
    render(<LoadWizard />);
    await pickFile();
    const tivSel = screen.getByTestId('select-tiv') as HTMLSelectElement;
    const zipSel = screen.getByTestId('select-zip3') as HTMLSelectElement;
    const buildSel = screen.getByTestId(
      'select-build_type',
    ) as HTMLSelectElement;
    expect(tivSel.value).toBe('TIV');
    expect(zipSel.value).toBe('Zip3');
    expect(buildSel.value).toBe('BuildType');
  });

  test('PII columns are flagged + non-selectable + listed in refused banner', async () => {
    render(<LoadWizard />);
    await pickFile();

    // The select for `state` (an arbitrary FORGE field) renders BOTH the
    // PII and non-PII column options. The PII ones must be disabled.
    const stateSel = screen.getByTestId('select-state') as HTMLSelectElement;
    const piiCustomer = within(stateSel).getByTestId(
      'option-pii-customer_name',
    ) as HTMLOptionElement;
    const piiEmail = within(stateSel).getByTestId(
      'option-pii-email',
    ) as HTMLOptionElement;
    expect(piiCustomer.disabled).toBe(true);
    expect(piiEmail.disabled).toBe(true);

    // And neither PII column was auto-mapped to any FORGE field.
    const allSelects = screen.getAllByTestId(/^select-/);
    for (const sel of allSelects) {
      expect((sel as HTMLSelectElement).value).not.toBe('customer_name');
      expect((sel as HTMLSelectElement).value).not.toBe('email');
    }

    // Refused banner surfaces them.
    const banner = screen.getByTestId('refused-banner');
    expect(within(banner).getByTestId('refused-customer_name')).toBeTruthy();
    expect(within(banner).getByTestId('refused-email')).toBeTruthy();
  });

  test('step 2 → step 3 renders a preview of at most 5 rows', async () => {
    render(<LoadWizard />);
    await pickFile();
    fireEvent.click(screen.getByTestId('wizard-next'));
    expect(screen.getByTestId('wizard-step-3')).toBeTruthy();
    const table = screen.getByTestId('preview-table');
    // 5 preview rows (file has 6 data rows; cap is 5).
    const previewRows = within(table).getAllByTestId(/^preview-row-/);
    expect(previewRows).toHaveLength(5);
    // src_row column starts at 2 (header is row 1) and increments.
    expect(previewRows[0].textContent).toContain('2');
    expect(previewRows[4].textContent).toContain('6');
  });

  test('import POSTs mapped rows + lineage to /api/book/upload-wizard', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        accepted: 6,
        rejected: 0,
        errors: [],
        refused_columns: ['customer_name', 'email'],
        optimization: 'refreshed',
      }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    render(<LoadWizard />);
    await pickFile();
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-import'));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/book/upload-wizard');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.srcFile).toBe('carrier_book.csv');
    expect(body.rows).toHaveLength(6);
    expect(body.refusedColumns).toEqual(
      expect.arrayContaining(['customer_name', 'email']),
    );

    // Every imported row must carry a parseable lineage JSON.
    for (const r of body.rows) {
      const lineage = JSON.parse(r.lineage);
      expect(lineage.src_file).toBe('carrier_book.csv');
      expect(typeof lineage.src_row).toBe('number');
      expect(lineage.mapped_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(Array.isArray(lineage.refused_columns)).toBe(true);
      expect(lineage.refused_columns).toEqual(
        expect.arrayContaining(['customer_name', 'email']),
      );
    }

    // Result panel renders.
    await waitFor(() => expect(screen.getByTestId('wizard-result')).toBeTruthy());
  });
});
