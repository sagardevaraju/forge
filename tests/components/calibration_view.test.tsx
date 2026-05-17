/**
 * Task P2.16 — /calibration view component tests.
 *
 * The view renders three sections: reliability diagrams for the XGB p10/p50/p90
 * heads, a PIT histogram for the scenario generator, and an honest placeholder
 * for the CV learning curves (P2.37 owns the real data). Each section carries
 * a TrustTierBadge + ProvenanceFootnote per the Phase 1 grammar.
 */
import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { CalibrationView, type CalibrationData } from '@/components/CalibrationView';

afterEach(cleanup);

function makeData(overrides: Partial<CalibrationData> = {}): CalibrationData {
  const reliabilityBin = (target: number, mid: number, freq: number, n: number) => ({
    forecast_prob: target,
    observed_freq: freq,
    forecast_value_mid: mid,
    n,
  });
  return {
    schema_version: 1,
    generated_at: '2026-05-17T06:40:13.905883+00:00',
    data_source: 'synthetic_demo',
    reliability: {
      p10: [
        reliabilityBin(0.1, 250_000, 0.07, 57),
        reliabilityBin(0.1, 700_000, 0.13, 80),
        reliabilityBin(0.1, 1_200_000, 0.10, 48),
      ],
      p50: [
        reliabilityBin(0.5, 550_000, 0.54, 57),
        reliabilityBin(0.5, 1_500_000, 0.43, 80),
        reliabilityBin(0.5, 2_600_000, 0.56, 48),
      ],
      p90: [
        reliabilityBin(0.9, 1_200_000, 0.91, 57),
        reliabilityBin(0.9, 3_200_000, 0.90, 80),
        reliabilityBin(0.9, 5_600_000, 0.85, 48),
      ],
    },
    pit: {
      scenario_generator: {
        n_bins: 10,
        counts: [95, 123, 90, 94, 101, 100, 93, 107, 99, 98],
        data_source: 'synthetic_placeholder',
        note: 'Real PIT samples land in P2.10 (HURDAT2) and P2.38 (NHC ensemble swap).',
      },
    },
    ...overrides,
  };
}

describe('CalibrationView', () => {
  test('renders without crashing with a valid artifact shape', () => {
    render(<CalibrationView data={makeData()} />);
    expect(screen.getByRole('heading', { level: 2, name: /reliability/i })).toBeInTheDocument();
  });

  test('renders three reliability charts labeled p10, p50, p90', () => {
    render(<CalibrationView data={makeData()} />);
    const charts = screen.getAllByTestId('reliability-chart');
    expect(charts).toHaveLength(3);
    expect(screen.getByTestId('reliability-chart-p10')).toBeInTheDocument();
    expect(screen.getByTestId('reliability-chart-p50')).toBeInTheDocument();
    expect(screen.getByTestId('reliability-chart-p90')).toBeInTheDocument();
  });

  test('renders the PIT histogram with one bar per bin', () => {
    const data = makeData();
    render(<CalibrationView data={data} />);
    const hist = screen.getByTestId('pit-histogram');
    const bars = within(hist).getAllByTestId('pit-bar');
    expect(bars).toHaveLength(data.pit.scenario_generator.counts.length);
  });

  test('CV section shows the honest deferred-to-P2.37 placeholder', () => {
    render(<CalibrationView data={makeData()} />);
    const cvSection = screen.getByTestId('cv-section');
    // Synthetic-scaffold badge inside the CV section.
    const badges = within(cvSection).getAllByTestId('trust-tier-badge');
    expect(badges.some((b) => b.textContent === 'Demo')).toBe(true);
    // Provenance footnote citing P2.37.
    const footnote = within(cvSection).getByTestId('provenance-footnote');
    expect(footnote.textContent).toMatch(/P2\.37/);
  });

  test('renders SYNTHETIC_SCAFFOLD badges when data_source is synthetic_demo', () => {
    render(<CalibrationView data={makeData({ data_source: 'synthetic_demo' })} />);
    // Both the reliability and PIT sections should advertise demo data.
    const reliabilitySection = screen.getByTestId('reliability-section');
    const pitSection = screen.getByTestId('pit-section');
    expect(
      within(reliabilitySection)
        .getAllByTestId('trust-tier-badge')
        .some((b) => b.textContent === 'Demo')
    ).toBe(true);
    expect(
      within(pitSection)
        .getAllByTestId('trust-tier-badge')
        .some((b) => b.textContent === 'Demo')
    ).toBe(true);
  });

  test('renders MODEL_OUTPUT badge for reliability when data_source is live', () => {
    render(<CalibrationView data={makeData({ data_source: 'live' })} />);
    const reliabilitySection = screen.getByTestId('reliability-section');
    expect(
      within(reliabilitySection)
        .getAllByTestId('trust-tier-badge')
        .some((b) => b.textContent === 'Model')
    ).toBe(true);
  });

  test('reliability chart plots the perfect-calibration reference line at y = target_prob', () => {
    render(<CalibrationView data={makeData()} />);
    // The p50 chart's reference line should sit at the midpoint of the chart
    // body — exposed via a data-target-prob attribute and the SVG y1/y2 attrs
    // mapped through the same transform as the data points.
    const p50 = screen.getByTestId('reliability-chart-p50');
    const refLine = within(p50).getByTestId('perfect-calibration-line');
    expect(refLine.getAttribute('data-target-prob')).toBe('0.5');
    const y1 = Number(refLine.getAttribute('y1'));
    const y2 = Number(refLine.getAttribute('y2'));
    // Reference line must be horizontal (constant y) at the target_prob's
    // mapped position.
    expect(y1).toBe(y2);
    // The p10 line must sit BELOW (higher y in SVG coords) the p90 line,
    // because SVG y grows downward and we plot probability 0→1 top→bottom.
    const p10Ref = within(screen.getByTestId('reliability-chart-p10')).getByTestId(
      'perfect-calibration-line'
    );
    const p90Ref = within(screen.getByTestId('reliability-chart-p90')).getByTestId(
      'perfect-calibration-line'
    );
    expect(Number(p10Ref.getAttribute('y1'))).toBeGreaterThan(Number(p90Ref.getAttribute('y1')));
  });
});
