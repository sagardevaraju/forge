// tests/components/grammar/SimulationBanner.test.tsx
// @vitest-environment jsdom
import { describe, test, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SimulationBanner } from '@/components/grammar/SimulationBanner';

afterEach(() => cleanup());

describe('SimulationBanner', () => {
  test('hidden when no unresolved sims', () => {
    const { container } = render(<SimulationBanner unresolved={[]} />);
    expect(container.firstChild).toBeNull();
  });
  test('shows count + buttons for one unresolved sim', () => {
    render(<SimulationBanner unresolved={[{ id: 'a', name: 'Tampa hail', peril: 'hail', promoted_at: '2026-05-18T12:00:00Z' }]} />);
    expect(screen.getByText(/1 unresolved simulation/i)).toBeInTheDocument();
    expect(screen.getByText(/Tampa hail/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-optimize portfolio/i })).toBeInTheDocument();
  });
  test('collapses multiple sims into a single count', () => {
    render(<SimulationBanner unresolved={[
      { id: 'a', name: 'A', peril: 'hail', promoted_at: '2026-05-18T12:00:00Z' },
      { id: 'b', name: 'B', peril: 'flood', promoted_at: '2026-05-18T13:00:00Z' },
    ]} />);
    expect(screen.getByText(/2 unresolved simulations/i)).toBeInTheDocument();
  });
});
