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
});
