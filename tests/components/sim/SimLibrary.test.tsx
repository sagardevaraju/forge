// @vitest-environment jsdom
import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SimLibrary } from '@/components/sim/SimLibrary';

afterEach(() => cleanup());

const SIMS = [
  { id: 'a', name: 'Tampa hail', peril: 'hail', intensity: 'severe', promoted: false, retired: false, drawn_at: '2026-05-18T12:00:00Z' },
  { id: 'b', name: 'ATL tornado', peril: 'tornado', intensity: 'moderate', promoted: true, retired: false, drawn_at: '2026-05-17T12:00:00Z' },
];

describe('SimLibrary', () => {
  test('renders DRAFT / PROMOTED badges', () => {
    render(<SimLibrary sims={SIMS} activeId={null} onSelect={() => {}} />);
    expect(screen.getByText('DRAFT')).toBeInTheDocument();
    expect(screen.getByText('PROMOTED')).toBeInTheDocument();
  });
  test('shows empty state when no sims', () => {
    render(<SimLibrary sims={[]} activeId={null} onSelect={() => {}} />);
    expect(screen.getByText(/No saved sims/i)).toBeInTheDocument();
  });
});
