import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ProvenanceFootnote } from '@/components/grammar/ProvenanceFootnote';

afterEach(cleanup);

describe('ProvenanceFootnote', () => {
  test('renders Source / Method / Confidence rows', () => {
    render(
      <ProvenanceFootnote
        source="NHC advisory 18 (2026-05-15T11:00Z)"
        method="lib/scenarios/generate@v0.3.1"
        confidence="log-lik −3.01 over 5 events"
      />
    );
    expect(screen.getByText(/Source:/i)).toBeInTheDocument();
    expect(screen.getByText(/Method:/i)).toBeInTheDocument();
    expect(screen.getByText(/Confidence:/i)).toBeInTheDocument();
    expect(screen.getByText(/advisory 18/i)).toBeInTheDocument();
    expect(screen.getByText(/log-lik/i)).toBeInTheDocument();
  });

  test('omits Confidence row when not provided', () => {
    render(<ProvenanceFootnote source="x" method="y" />);
    expect(screen.queryByText(/Confidence:/i)).toBeNull();
  });
});
