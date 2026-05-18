import { describe, test, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import RootLayout from '@/app/layout';

// The LayoutSubBanner mounts a URL-backed PersonaToggleUrl which calls into
// next/navigation hooks. Stub them with a stable empty query so the toggle
// renders without a real Next router.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(''),
}));

afterEach(cleanup);

describe('RootLayout', () => {
  // ThreatBanner is intentionally NOT rendered at the layout level — it sits
  // inside the page that has an active storm (currently /events) so the
  // strip carries real advisory data instead of a global "no storm" stub.
  test('renders LayoutSubBanner with persona-toggle and the page body', () => {
    render(<RootLayout><div>child</div></RootLayout>);
    expect(screen.getByRole('group', { name: 'persona-toggle' })).toBeInTheDocument();
    expect(screen.getByText('child')).toBeInTheDocument();
    expect(screen.queryByTestId('threat-banner')).not.toBeInTheDocument();
  });
});
