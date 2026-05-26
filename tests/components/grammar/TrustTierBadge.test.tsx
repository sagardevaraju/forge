// @vitest-environment jsdom
import { describe, test, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TrustTierBadge } from '@/components/grammar/TrustTierBadge';

afterEach(() => cleanup());

describe('TrustTierBadge — glossary integration', () => {
  test('renders the tier label', () => {
    render(<TrustTierBadge tier="LIVE_FEED" />);
    expect(screen.getByTestId('trust-tier-badge')).toHaveTextContent(/live/i);
  });

  test('exposes a glossary tooltip for the tier', () => {
    render(<TrustTierBadge tier="LIVE_FEED" />);
    const btn = screen.getByRole('button', { name: /definition of/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-describedby');
  });

  test('does NOT use native HTML title attribute anymore', () => {
    render(<TrustTierBadge tier="MODEL_OUTPUT" />);
    expect(screen.getByTestId('trust-tier-badge')).not.toHaveAttribute('title');
  });
});
