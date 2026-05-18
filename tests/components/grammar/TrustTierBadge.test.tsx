import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TrustTierBadge } from '@/components/grammar/TrustTierBadge';

afterEach(cleanup);

describe('TrustTierBadge', () => {
  test('renders the tier label', () => {
    render(<TrustTierBadge tier="LIVE_FEED" />);
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  test('applies green styling for LIVE_FEED', () => {
    render(<TrustTierBadge tier="LIVE_FEED" />);
    const el = screen.getByTestId('trust-tier-badge');
    expect(el.className).toMatch(/bg-green/);
  });

  test('applies amber styling for SYNTHETIC_SCAFFOLD', () => {
    render(<TrustTierBadge tier="SYNTHETIC_SCAFFOLD" />);
    const el = screen.getByTestId('trust-tier-badge');
    expect(el.className).toMatch(/bg-amber/);
  });

  test('renders all five tiers without crashing', () => {
    const tiers = ['LIVE_FEED', 'MODEL_OUTPUT', 'SYNTHETIC_SCAFFOLD', 'RECOMMENDATION', 'MANUAL_OVERRIDE'] as const;
    for (const t of tiers) {
      render(<TrustTierBadge tier={t} />);
    }
  });

  test('exposes tier tooltip via title attribute', () => {
    render(<TrustTierBadge tier="MODEL_OUTPUT" />);
    expect(screen.getByTestId('trust-tier-badge').getAttribute('title')).toMatch(/model output/i);
  });
});
