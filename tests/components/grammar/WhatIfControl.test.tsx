import { describe, test, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { WhatIfControl } from '@/components/grammar/WhatIfControl';

afterEach(cleanup);

describe('WhatIfControl', () => {
  test('renders label, slider, and numeric input with current value', () => {
    render(
      <WhatIfControl
        label="Capital budget"
        baseline={300}
        current={350}
        min={0}
        max={1000}
        onCommit={() => {}}
      />
    );
    expect(screen.getByText('Capital budget')).toBeInTheDocument();
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('aria-valuenow', '350');
    expect(slider).toHaveAttribute('aria-valuemin', '0');
    expect(slider).toHaveAttribute('aria-valuemax', '1000');
  });

  test('uses label as default aria-label and respects ariaLabel override', () => {
    const { rerender } = render(
      <WhatIfControl label="Capital budget" baseline={300} current={350} min={0} max={1000} onCommit={() => {}} />
    );
    expect(screen.getByRole('slider')).toHaveAttribute('aria-label', 'Capital budget');

    rerender(
      <WhatIfControl
        label="Capital budget"
        baseline={300}
        current={350}
        min={0}
        max={1000}
        ariaLabel="Capital budget ($M)"
        onCommit={() => {}}
      />
    );
    expect(screen.getByRole('slider')).toHaveAttribute('aria-label', 'Capital budget ($M)');
  });

  test('dragging the slider updates the displayed proposed value but does NOT fire onCommit', () => {
    const onCommit = vi.fn();
    render(
      <WhatIfControl
        label="Capital budget"
        baseline={300}
        current={350}
        min={0}
        max={1000}
        onCommit={onCommit}
      />
    );
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '500' } });
    expect(slider).toHaveAttribute('aria-valuenow', '500');
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('releasing the slider fires onCommit with the proposed value', () => {
    const onCommit = vi.fn();
    render(
      <WhatIfControl label="Capital budget" baseline={300} current={350} min={0} max={1000} onCommit={onCommit} />
    );
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '500' } });
    fireEvent.mouseUp(slider);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(500);
  });

  test('touch-end on the slider fires onCommit', () => {
    const onCommit = vi.fn();
    render(
      <WhatIfControl label="Capital budget" baseline={300} current={350} min={0} max={1000} onCommit={onCommit} />
    );
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '420' } });
    fireEvent.touchEnd(slider);
    expect(onCommit).toHaveBeenCalledWith(420);
  });

  test('keyboard key-up on the slider fires onCommit', () => {
    const onCommit = vi.fn();
    render(
      <WhatIfControl label="Capital budget" baseline={300} current={350} min={0} max={1000} onCommit={onCommit} />
    );
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '360' } });
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenCalledWith(360);
  });

  test('numeric input commits on Enter', () => {
    const onCommit = vi.fn();
    render(
      <WhatIfControl label="Capital budget" baseline={300} current={350} min={0} max={1000} onCommit={onCommit} />
    );
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '600' } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(600);
  });

  test('numeric input commits on blur', () => {
    const onCommit = vi.fn();
    render(
      <WhatIfControl label="Capital budget" baseline={300} current={350} min={0} max={1000} onCommit={onCommit} />
    );
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '425' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(425);
  });

  test('numeric input clamps to min/max on commit', () => {
    const onCommit = vi.fn();
    render(
      <WhatIfControl label="Capital budget" baseline={300} current={350} min={0} max={1000} onCommit={onCommit} />
    );
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '5000' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(1000);

    onCommit.mockClear();
    fireEvent.change(input, { target: { value: '-50' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(0);
  });

  test('numeric input does NOT commit when value is non-numeric', () => {
    const onCommit = vi.fn();
    render(
      <WhatIfControl label="Capital budget" baseline={300} current={350} min={0} max={1000} onCommit={onCommit} />
    );
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('disabled prop prevents onCommit on slider release', () => {
    const onCommit = vi.fn();
    render(
      <WhatIfControl
        label="Capital budget"
        baseline={300}
        current={350}
        min={0}
        max={1000}
        onCommit={onCommit}
        disabled
      />
    );
    const slider = screen.getByRole('slider');
    expect(slider).toBeDisabled();
    fireEvent.mouseUp(slider);
    expect(onCommit).not.toHaveBeenCalled();

    const input = screen.getByRole('spinbutton');
    expect(input).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('does not fire onCommit when proposed value equals current (no-op release)', () => {
    const onCommit = vi.fn();
    render(
      <WhatIfControl label="Capital budget" baseline={300} current={350} min={0} max={1000} onCommit={onCommit} />
    );
    const slider = screen.getByRole('slider');
    // No change before release.
    fireEvent.mouseUp(slider);
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('renders baseline tick distinct from current and proposed markers', () => {
    render(
      <WhatIfControl label="Capital budget" baseline={300} current={350} min={0} max={1000} onCommit={() => {}} />
    );
    const baseline = screen.getByTestId('whatif-baseline');
    const current = screen.getByTestId('whatif-current');
    const proposed = screen.getByTestId('whatif-proposed');
    expect(baseline).toBeInTheDocument();
    expect(current).toBeInTheDocument();
    expect(proposed).toBeInTheDocument();
    expect(baseline.className).not.toEqual(current.className);
    expect(current.className).not.toEqual(proposed.className);
  });

  test('uses custom format function for displayed values', () => {
    render(
      <WhatIfControl
        label="Capital budget"
        baseline={300_000_000}
        current={350_000_000}
        min={0}
        max={1_000_000_000}
        format={(v) => `$${(v / 1e6).toFixed(1)}M`}
        onCommit={() => {}}
      />
    );
    expect(screen.getByText(/baseline.*\$300\.0M/i)).toBeInTheDocument();
    expect(screen.getByText(/current.*\$350\.0M/i)).toBeInTheDocument();
  });

  test('falls back to unit suffix when no format provided', () => {
    render(
      <WhatIfControl
        label="Loss ratio"
        baseline={42}
        current={45}
        min={0}
        max={100}
        unit="%"
        onCommit={() => {}}
      />
    );
    expect(screen.getByText(/baseline.*42%/i)).toBeInTheDocument();
    expect(screen.getByText(/current.*45%/i)).toBeInTheDocument();
  });

  test('honours custom step prop on the slider', () => {
    render(
      <WhatIfControl
        label="Capital budget"
        baseline={300}
        current={350}
        min={0}
        max={1000}
        step={25}
        onCommit={() => {}}
      />
    );
    expect(screen.getByRole('slider')).toHaveAttribute('step', '25');
  });

  test('updates internal proposed value when current prop changes externally', () => {
    const { rerender } = render(
      <WhatIfControl label="Capital budget" baseline={300} current={350} min={0} max={1000} onCommit={() => {}} />
    );
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '350');
    rerender(
      <WhatIfControl label="Capital budget" baseline={300} current={500} min={0} max={1000} onCommit={() => {}} />
    );
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '500');
  });
});
