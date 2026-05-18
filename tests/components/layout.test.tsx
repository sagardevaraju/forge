import { describe, test, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import RootLayout from '@/app/layout';

// The LayoutSubBanner gates the persona toggle on `usePathname()` — it
// only renders on routes whose page actually consumes ?persona=. Each
// test sets `mockedPathname` to the route it wants to exercise.
let mockedPathname = '/portfolio';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => mockedPathname,
  useSearchParams: () => new URLSearchParams(''),
}));

afterEach(cleanup);

describe('RootLayout', () => {
  // ThreatBanner is intentionally NOT rendered at the layout level — it sits
  // inside the page that has an active storm (currently /events) so the
  // strip carries real advisory data instead of a global "no storm" stub.
  test('renders LayoutSubBanner with persona-toggle on a persona-aware route', () => {
    mockedPathname = '/portfolio';
    render(<RootLayout><div>child</div></RootLayout>);
    expect(screen.getByRole('group', { name: 'persona-toggle' })).toBeInTheDocument();
    expect(screen.getByText('child')).toBeInTheDocument();
    expect(screen.queryByTestId('threat-banner')).not.toBeInTheDocument();
  });

  test('hides the persona-toggle on routes that do not consume persona', () => {
    mockedPathname = '/treaty';
    render(<RootLayout><div>child</div></RootLayout>);
    expect(screen.queryByRole('group', { name: 'persona-toggle' })).not.toBeInTheDocument();
    expect(screen.getByText('child')).toBeInTheDocument();
  });
});
