/**
 * Task 22 — ClaimsTable filter + CSV export.
 *
 * Covers two pieces:
 *   1. The severity-tier filter narrows rendered rows correctly.
 *   2. The CSV export builds a Blob with the right header + the visible rows.
 *      We mock URL.createObjectURL to capture the Blob and assert on its
 *      contents — jsdom doesn't actually trigger downloads, but the data
 *      passed to URL.createObjectURL is the load-bearing part.
 */
import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ClaimsTable, type PreflagPolicy } from '@/components/ClaimsTable';

const policies: PreflagPolicy[] = [
  { policy_id: 1, zip3: '332', tiv: 1_000_000, build_type: 'masonry', flood_zone: 'AE', severity: 'medium', expected_loss: 150_000 },
  { policy_id: 2, zip3: '334', tiv: 800_000, build_type: 'manufactured', flood_zone: 'VE', severity: 'high', expected_loss: 320_000 },
  { policy_id: 3, zip3: '335', tiv: 500_000, build_type: 'wood_frame', flood_zone: 'X', severity: 'low', expected_loss: 25_000 },
  { policy_id: 4, zip3: '337', tiv: 600_000, build_type: 'wood_frame', flood_zone: 'VE', severity: 'high', expected_loss: 240_000 },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ClaimsTable', () => {
  test('severity filter narrows rows to the chosen tier', () => {
    render(<ClaimsTable policies={policies} />);
    // Initially all four are shown.
    expect(screen.getByTestId('filtered-count')).toHaveTextContent('Showing 4');

    fireEvent.change(screen.getByLabelText('severity-filter'), { target: { value: 'high' } });
    expect(screen.getByTestId('filtered-count')).toHaveTextContent('Showing 2');
    // Filter selected option counts match input.
    expect(screen.getByText('High (2)')).toBeInTheDocument();
    expect(screen.getByText('Medium (1)')).toBeInTheDocument();
    expect(screen.getByText('Low (1)')).toBeInTheDocument();
  });

  test('CSV export builds a Blob with header + visible rows', async () => {
    const captured: Blob[] = [];
    const createUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation((b: Blob | MediaSource) => {
        captured.push(b as Blob);
        return 'blob:mock';
      });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    // jsdom doesn't implement HTMLAnchorElement#click downloads — stub it.
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    render(<ClaimsTable policies={policies} />);
    fireEvent.change(screen.getByLabelText('severity-filter'), { target: { value: 'high' } });
    fireEvent.click(screen.getByText('Export CSV'));

    await waitFor(() => expect(createUrl).toHaveBeenCalledTimes(1));
    expect(captured).toHaveLength(1);
    const text = await captured[0].text();
    expect(text).toMatch(/^policy_id,zip3,tiv,build_type,flood_zone,severity,expected_loss/);
    // Only the two high-severity rows.
    expect(text).toMatch(/2,334,800000,manufactured,VE,high,320000/);
    expect(text).toMatch(/4,337,600000,wood_frame,VE,high,240000/);
    expect(text).not.toMatch(/,medium,/);
    expect(text).not.toMatch(/,low,/);

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:mock');
  });

  test('groups by ZIP3 with county header rows', () => {
    render(<ClaimsTable policies={[
      { policy_id: 1, zip3: '337', tiv: 1e6, build_type: 'wood_frame', flood_zone: 'AE', severity: 'medium', expected_loss: 150_000 },
      { policy_id: 2, zip3: '337', tiv: 2e6, build_type: 'masonry', flood_zone: 'AE', severity: 'medium', expected_loss: 300_000 },
      { policy_id: 3, zip3: '342', tiv: 1.5e6, build_type: 'manufactured', flood_zone: 'VE', severity: 'high', expected_loss: 600_000 },
    ]} />);
    expect(screen.getByText(/Pinellas, FL/)).toBeInTheDocument();
    expect(screen.getByText(/Sarasota, FL/)).toBeInTheDocument();
  });
});

// Some jsdom builds (and Node 20+) don't have a global Blob.prototype.text fast-path,
// but the @testing-library/react jsdom setup includes one. Guard against the
// rare environment where it's absent so this test fails loudly rather than hanging.
beforeEach(() => {
  if (typeof (Blob.prototype as unknown as { text?: unknown }).text !== 'function') {
    throw new Error('Blob.prototype.text is required for this test');
  }
});
