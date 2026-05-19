// @vitest-environment jsdom
import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ImpactPanel } from '@/components/sim/ImpactPanel';

afterEach(() => cleanup());

const IMPACT = {
  policies_in_footprint: 847,
  tiv_in_footprint: 284_000_000,
  gross_loss_estimate: 11_400_000,
  mean_damage_ratio: 0.04,
  cohorts_affected: 12,
  top_cohorts: [
    { cohort_id: '337_wood_frame', loss: 2_100_000, tiv: 50_000_000, policies: 120 },
    { cohort_id: '335_masonry',    loss: 1_800_000, tiv: 60_000_000, policies: 95 },
  ],
};

describe('ImpactPanel', () => {
  test('renders the gross loss prominently', () => {
    render(<ImpactPanel impact={IMPACT} />);
    expect(screen.getByText(/\$11\.4M/)).toBeInTheDocument();
  });
  test('empty footprint shows placeholder', () => {
    render(<ImpactPanel impact={null} />);
    expect(screen.getByText(/Draw a footprint/i)).toBeInTheDocument();
  });
  test('zero-policy footprint shows "promote anyway?" chip', () => {
    render(<ImpactPanel impact={{ ...IMPACT, policies_in_footprint: 0, gross_loss_estimate: 0 }} />);
    expect(screen.getByText(/promote anyway/i)).toBeInTheDocument();
  });
});
