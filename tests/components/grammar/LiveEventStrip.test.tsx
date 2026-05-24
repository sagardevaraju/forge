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

  // ── Trust-tier downgrade (CLAUDE.md "no fictional data") ──
  // A LIVE_FEED-style "Active threat" badge over mock data is a bug.
  // These tests pin the honest fallback: rose treatment + "Active threat"
  // copy is reserved for live cones; mock cones collapse to an amber
  // "Demo scenario" treatment, and mock-source NWS alert chips get a
  // "demo" suffix + zinc desaturation so a synthetic count can't be
  // mistaken for a live warning.

  test('mock-source cone downgrades to a Demo scenario treatment', () => {
    render(
      <LiveEventStrip
        stormId="AL092024"
        advisoryNumber="14A"
        peakWindMph={142}
        refreshedAt={refreshedAt}
        now={now}
        source="mock"
      />,
    );
    const strip = screen.getByTestId('live-event-strip');
    expect(strip.getAttribute('data-state')).toBe('active');
    expect(strip.getAttribute('data-source')).toBe('mock');
    // No "Active threat" copy when the cone is mock.
    expect(strip.textContent).not.toMatch(/active threat/i);
    // Honest demo label is surfaced instead.
    expect(strip.textContent).toMatch(/demo scenario/i);
    // Visual treatment flips from rose to amber.
    expect(strip.className).toContain('amber');
    expect(strip.className).not.toContain('rose');
    // The corner badge still reads "Mock · …" for the freshness chip.
    expect(strip.textContent).toMatch(/mock/i);
  });

  test('live-source cone keeps the rose Active threat treatment', () => {
    render(
      <LiveEventStrip
        stormId="AL092024"
        advisoryNumber="14A"
        peakWindMph={142}
        refreshedAt={refreshedAt}
        now={now}
        source="live"
      />,
    );
    const strip = screen.getByTestId('live-event-strip');
    expect(strip.getAttribute('data-source')).toBe('live');
    expect(strip.textContent).toMatch(/active threat/i);
    expect(strip.textContent).not.toMatch(/demo scenario/i);
    expect(strip.className).toContain('rose');
  });

  test('mock-source alert chips render with a "demo" suffix', () => {
    render(
      <LiveEventStrip
        stormId={null}
        refreshedAt={refreshedAt}
        now={now}
        alertCounts={{ flood: 7, severe_thunderstorm: 8 }}
        alertsSource="mock"
      />,
    );
    const chips = screen.getByTestId('live-event-strip-alerts');
    expect(chips.getAttribute('data-source')).toBe('mock');
    const flood = screen.getByTestId('live-event-strip-alert-flood');
    // Inline "demo" suffix beats a corner-only badge — the chip itself
    // admits the source so a reader scanning chip-by-chip can't miss it.
    expect(flood.textContent?.toLowerCase()).toContain('demo');
    // aria-label spells out the same source for screen-reader users.
    expect(flood.getAttribute('aria-label')?.toLowerCase()).toContain('demo');
  });

  test('alert chips default to alertsSource=cone-source when alertsSource is omitted', () => {
    // When only `source` is set (mock) and `alertsSource` is omitted, the
    // strip infers the alerts share the cone's source so a single
    // FORGE_TOOLS_MODE=mock flag downgrades the whole strip consistently.
    render(
      <LiveEventStrip
        stormId="AL092024"
        advisoryNumber="14A"
        peakWindMph={142}
        refreshedAt={refreshedAt}
        now={now}
        source="mock"
        alertCounts={{ flood: 7 }}
      />,
    );
    const flood = screen.getByTestId('live-event-strip-alert-flood');
    expect(flood.textContent?.toLowerCase()).toContain('demo');
  });
});
