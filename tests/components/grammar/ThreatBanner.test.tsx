// tests/components/grammar/ThreatBanner.test.tsx
import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ThreatBanner } from '@/components/grammar/ThreatBanner';

afterEach(cleanup);

describe('ThreatBanner', () => {
  test('renders storm id + advisory + age + peak wind', () => {
    render(
      <ThreatBanner
        stormId="AL092024"
        advisoryNumber="18"
        peakWind={142}
        coneRefreshedAt={new Date('2026-05-15T11:50:00Z')}
        now={new Date('2026-05-15T12:00:00Z')}
        exposureUnderConeTiv={812_000_000}
      />
    );
    expect(screen.getByText(/AL092024/)).toBeInTheDocument();
    expect(screen.getByText(/advisory 18/i)).toBeInTheDocument();
    expect(screen.getByText(/142/)).toBeInTheDocument();
    expect(screen.getByText(/10m ago/i)).toBeInTheDocument();
    expect(screen.getByText(/\$812\.0M/i)).toBeInTheDocument();
  });

  test('renders no-storm placeholder when stormId is null', () => {
    render(<ThreatBanner stormId={null} />);
    expect(screen.getByText(/no active named storm/i)).toBeInTheDocument();
  });

  test('renders delta-since-last when provided', () => {
    render(
      <ThreatBanner
        stormId="AL092024"
        advisoryNumber="18"
        peakWind={142}
        deltaPeakWind={+7}
        coneRefreshedAt={new Date('2026-05-15T11:50:00Z')}
        now={new Date('2026-05-15T12:00:00Z')}
        exposureUnderConeTiv={812_000_000}
      />
    );
    expect(screen.getByText(/\+7 mph/i)).toBeInTheDocument();
  });
});
