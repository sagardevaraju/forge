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

describe('ExecCard — glossary term prop', () => {
  test('renders an info-icon button when term is provided', () => {
    render(<ExecCard label="Tail exposure" value="$96.7M" tier="MODEL_OUTPUT" term="tail-exposure" />);
    const btn = screen.getByRole('button', { name: /definition of tail exposure/i });
    expect(btn).toBeInTheDocument();
  });

  test('does NOT render an info-icon button when term is omitted', () => {
    // The TrustTierBadge always renders its own glossary button
    // ("Definition of Model" etc.) — so we assert that ExecCard's own
    // label-side info-icon is absent (no "Definition of <label>" button),
    // not that no glossary button exists at all.
    render(<ExecCard label="Random" value="1" tier="MODEL_OUTPUT" />);
    expect(screen.queryByRole('button', { name: /definition of random/i })).toBeNull();
  });
});
