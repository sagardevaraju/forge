import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import ClaimsPage from '@/app/claims/page';

afterEach(cleanup);

describe('ClaimsPage', () => {
  test('renders SYNTHETIC_SCAFFOLD badge and provenance', async () => {
    const ui = await ClaimsPage();
    render(ui);
    expect(screen.getByTestId('trust-tier-badge')).toBeInTheDocument();
    expect(screen.getByTestId('provenance-footnote')).toBeInTheDocument();
    expect(screen.getAllByText(/heuristic/i).length).toBeGreaterThan(0);
  });
});
