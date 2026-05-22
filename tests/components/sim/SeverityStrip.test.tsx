// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SeverityStrip } from '@/components/sim/SeverityStrip';

afterEach(() => cleanup());

const noop = () => {};

describe('SeverityStrip', () => {
  test('renders a range slider + readout for a continuous peril (earthquake)', () => {
    render(
      <SeverityStrip peril="earthquake" severity={7.0} onSeverityChange={noop}
        effectiveDate="2026-05-22" onDateChange={noop} />,
    );
    expect(screen.getByRole('slider')).toBeInTheDocument();
    expect(screen.getByText(/M7\.0/)).toBeInTheDocument();
  });

  test('renders six EF buttons for a discrete peril (tornado)', () => {
    render(
      <SeverityStrip peril="tornado" severity="ef3" onSeverityChange={noop}
        effectiveDate="2026-05-22" onDateChange={noop} />,
    );
    for (const ef of ['EF0', 'EF1', 'EF2', 'EF3', 'EF4', 'EF5']) {
      expect(screen.getByRole('button', { name: new RegExp(ef) })).toBeInTheDocument();
    }
  });

  test('clicking an EF button calls onSeverityChange with the level id', () => {
    const onSeverityChange = vi.fn();
    render(
      <SeverityStrip peril="tornado" severity="ef3" onSeverityChange={onSeverityChange}
        effectiveDate="2026-05-22" onDateChange={noop} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /EF5/ }));
    expect(onSeverityChange).toHaveBeenCalledWith('ef5');
  });

  test('moving the slider calls onSeverityChange with a number', () => {
    const onSeverityChange = vi.fn();
    render(
      <SeverityStrip peril="hail" severity={45} onSeverityChange={onSeverityChange}
        effectiveDate="2026-05-22" onDateChange={noop} />,
    );
    fireEvent.change(screen.getByRole('slider'), { target: { value: '60' } });
    expect(onSeverityChange).toHaveBeenCalledWith(60);
  });

  test('the card is lifted off the bottom edge and left-anchored (visibility fix)', () => {
    const { container } = render(
      <SeverityStrip peril="flood" severity="moderate" onSeverityChange={noop}
        effectiveDate="2026-05-22" onDateChange={noop} />,
    );
    const card = container.firstChild as HTMLElement;
    expect(card).toHaveClass('bottom-8');
    expect(card).toHaveClass('left-2');
    expect(card.className).not.toContain('right-2');
  });
});
