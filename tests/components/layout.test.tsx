import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import RootLayout from '@/app/layout';

afterEach(cleanup);

describe('RootLayout', () => {
  test('renders ThreatBanner and PersonaToggle slots', () => {
    render(<RootLayout><div>child</div></RootLayout>);
    expect(screen.getByTestId('threat-banner')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'persona-toggle' })).toBeInTheDocument();
    expect(screen.getByText('child')).toBeInTheDocument();
  });
});
