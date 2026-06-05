// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { PromoteButton } from '@/components/sim/PromoteButton';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PromoteButton', () => {
  test('disabled when no sim_id', () => {
    render(<PromoteButton simId={null} promoted={false} onPromoted={() => {}} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });
  test('hidden chip when already promoted', () => {
    render(<PromoteButton simId="abc" promoted={true} onPromoted={() => {}} />);
    expect(screen.getByText(/Already promoted/i)).toBeInTheDocument();
  });
  test('calls promote endpoint on click', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ K: 1000, n_cohorts: 5 }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const onPromoted = vi.fn();
    render(<PromoteButton simId="1234567890123_deadbeef" promoted={false} onPromoted={onPromoted} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(onPromoted).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sim/1234567890123_deadbeef/promote',
      expect.objectContaining({ method: 'POST' }),
    );
  });
  test('passes the returned distribution to onPromoted', async () => {
    const dist = {
      K: 1000, n_cohorts: 3,
      histogram: { bin_edges: [0, 1, 2], counts: [2, 1] },
      summary: { mean: 1, p50: 1, p90: 1, p99: 2, tvar99: 3, min: 0, max: 4 },
    };
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(dist), { status: 200, headers: { 'content-type': 'application/json' } })));
    const onPromoted = vi.fn();
    render(<PromoteButton simId="1234567890123_abcdef00" promoted={false} onPromoted={onPromoted} />);
    fireEvent.click(screen.getByRole('button', { name: /promote to scenario/i }));
    await waitFor(() => expect(onPromoted).toHaveBeenCalledWith(expect.objectContaining({
      summary: expect.objectContaining({ tvar99: 3 }),
    })));
  });
});
