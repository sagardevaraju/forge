// tests/components/grammar/LiveEventStrip.test.tsx
import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { LiveEventStrip } from '@/components/grammar/LiveEventStrip';

afterEach(cleanup);

describe('LiveEventStrip — alert chips', () => {
  const refreshedAt = new Date('2026-05-18T12:00:00Z');
  const now = new Date('2026-05-18T12:05:00Z');

  test('renders nothing alert-related when alertCounts is omitted', () => {
    render(
      <LiveEventStrip stormId={null} refreshedAt={refreshedAt} now={now} />,
    );
    expect(screen.queryByTestId('live-event-strip-alerts')).toBeNull();
    // Calm state copy is preserved.
    expect(screen.getByText(/atlantic basin quiet/i)).toBeInTheDocument();
  });

  test('quiet state upgrades to alerts-only when warnings exist', () => {
    render(
      <LiveEventStrip
        stormId={null}
        refreshedAt={refreshedAt}
        now={now}
        alertCounts={{ tornado: 2, flood: 1 }}
      />,
    );
    const strip = screen.getByTestId('live-event-strip');
    expect(strip.getAttribute('data-state')).toBe('alerts-only');
    expect(strip.textContent).toMatch(/no active named storms/i);
    expect(screen.getByTestId('live-event-strip-alert-tornado')).toBeInTheDocument();
    expect(screen.getByTestId('live-event-strip-alert-flood')).toBeInTheDocument();
    expect(screen.queryByTestId('live-event-strip-alert-severe_thunderstorm')).toBeNull();
  });

  test('only non-zero categories render chips', () => {
    render(
      <LiveEventStrip
        stormId={null}
        refreshedAt={refreshedAt}
        now={now}
        alertCounts={{
          tornado: 0,
          flood: 0,
          severe_thunderstorm: 3,
        }}
      />,
    );
    expect(
      screen.getByTestId('live-event-strip-alert-severe_thunderstorm'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('live-event-strip-alert-tornado')).toBeNull();
    expect(screen.queryByTestId('live-event-strip-alert-flood')).toBeNull();
  });

  test('active-cone state surfaces chips alongside storm metadata', () => {
    render(
      <LiveEventStrip
        stormId="AL092024"
        advisoryNumber="14A"
        peakWindMph={142}
        refreshedAt={refreshedAt}
        now={now}
        alertCounts={{ tornado: 1 }}
      />,
    );
    const strip = screen.getByTestId('live-event-strip');
    expect(strip.getAttribute('data-state')).toBe('active');
    // Both storm info and alert chip should be present.
    expect(screen.getByText(/AL092024/)).toBeInTheDocument();
    expect(screen.getByTestId('live-event-strip-alert-tornado')).toBeInTheDocument();
  });

  test('chip shows the count and label', () => {
    render(
      <LiveEventStrip
        stormId={null}
        refreshedAt={refreshedAt}
        now={now}
        alertCounts={{ flood: 7 }}
      />,
    );
    const chip = screen.getByTestId('live-event-strip-alert-flood');
    expect(chip.textContent).toContain('7');
    expect(chip.textContent?.toLowerCase()).toContain('flood');
  });
});
