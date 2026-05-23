// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PerilPicker } from '@/components/sim/PerilPicker';

afterEach(() => cleanup());

describe('PerilPicker', () => {
  test('renders all six perils', () => {
    render(<PerilPicker active="hail" onChange={() => {}} />);
    // Note: "winter" peril id renders as "Winter Storm" (PERIL_LABELS in
    // lib/sim/severity.ts) — disambiguates from blizzard-only reading and
    // matches PCS / AIR / RMS / Verisk industry vocabulary.
    for (const p of ['Tornado', 'Flood', 'Hail', 'Wildfire', 'Earthquake', 'Winter Storm']) {
      expect(screen.getByText(p)).toBeInTheDocument();
    }
  });
  test('marks the active peril with aria-pressed=true', () => {
    render(<PerilPicker active="hail" onChange={() => {}} />);
    const hailBtn = screen.getByRole('button', { name: /^Hail$/ });
    expect(hailBtn).toHaveAttribute('aria-pressed', 'true');
  });
  test('calls onChange with the clicked peril', () => {
    const onChange = vi.fn();
    render(<PerilPicker active="hail" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /^Flood$/ }));
    expect(onChange).toHaveBeenCalledWith('flood');
  });
});
