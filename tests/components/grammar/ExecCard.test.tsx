import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ExecCard } from '@/components/grammar/ExecCard';

afterEach(cleanup);

describe('ExecCard', () => {
  test('renders headline scalar and label', () => {
    render(<ExecCard label="Total TIV" value="$3.1B" tier="MODEL_OUTPUT" />);
    expect(screen.getByText('Total TIV')).toBeInTheDocument();
    expect(screen.getByText('$3.1B')).toBeInTheDocument();
  });

  test('renders delta-vs-baseline when provided', () => {
    render(
      <ExecCard label="Margin" value="$44.5M" delta="+$3.2M vs current" tier="RECOMMENDATION" />
    );
    expect(screen.getByText(/\+\$3\.2M vs current/i)).toBeInTheDocument();
  });

  test('renders trust badge for tier', () => {
    render(<ExecCard label="Capital used" value="$8M" tier="MODEL_OUTPUT" />);
    expect(screen.getByTestId('trust-tier-badge')).toBeInTheDocument();
  });

  test('renders confidence band when provided', () => {
    render(<ExecCard label="Margin" value="$44.5M" band="p10 $38.2M – p90 $49.1M" tier="MODEL_OUTPUT" />);
    expect(screen.getByText(/p10 \$38\.2M/)).toBeInTheDocument();
  });
});
