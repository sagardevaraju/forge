/**
 * Task P2.18 — Persona toggle modes wired across /portfolio.
 *
 * Five-persona toggle (Cat-ops · Actuary · Reinsurance · Field-ops ·
 * Academic) backed by `?persona=<id>` in the URL. Each persona renders a
 * tuned ExecCard set on /portfolio. The tests below mock `next/navigation`
 * so the URL-backed components observe a controlled query string and
 * assert against the rendered cards. (Phase 3 cleanup removed the `/events`
 * surface — EventsPersonaScope was deleted along with `/events` being
 * dropped from PERSONA_AWARE_ROUTES because it never reshaped that page.)
 */
import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

import { PersonaToggle, PersonaToggleUrl } from '@/components/grammar/PersonaToggle';
import { PortfolioPersonaScope } from '@/components/PortfolioPersonaScope';
import {
  PERSONAS,
  PERSONA_VALUES,
  parsePersona,
  getPersonaConfig,
  DEFAULT_PERSONA,
} from '@/lib/persona/config';
import type { PortfolioOptimization } from '@/lib/portfolio-actions';

// --- next/navigation mock --------------------------------------------------
// `useSearchParams`, `usePathname`, `useRouter` are mocked module-level so
// each test can stage a different URL state before mounting the component.
// `router.replace` is captured by the spy so we can assert click → URL.
const replaceSpy = vi.fn();
let mockedQuery = '';
let mockedPathname = '/portfolio';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceSpy, push: replaceSpy }),
  usePathname: () => mockedPathname,
  useSearchParams: () => new URLSearchParams(mockedQuery),
}));

beforeEach(() => {
  replaceSpy.mockReset();
  mockedQuery = '';
  mockedPathname = '/portfolio';
});

afterEach(() => {
  cleanup();
});

// --- shared fixtures -------------------------------------------------------
function makeOptimization(
  overrides: Partial<PortfolioOptimization> = {},
): PortfolioOptimization {
  return {
    status: 'Optimal',
    objective: 44_500_000,
    horizon_start: '2026-07-01',
    horizon_end: '2027-06-30',
    budgets: {
      capital_budget: 100_000_000,
      max_nonrenew_pct: 0.1,
      cession_budget: 5_000_000,
    },
    book_totals: {
      tiv: 3_100_000_000,
      premium: 50_000_000,
      loss_p50: 19_000_000,
      loss_p99: 78_400_000,
    },
    action_summary: {
      retain: { count: 200, tiv: 1_500_000_000 },
      reprice_n20: { count: 0, tiv: 0 },
      reprice_n10: { count: 25, tiv: 200_000_000 },
      reprice_0: { count: 25, tiv: 200_000_000 },
      reprice_p5: { count: 30, tiv: 200_000_000 },
      reprice_p10: { count: 30, tiv: 150_000_000 },
      reprice_p15: { count: 20, tiv: 100_000_000 },
      reprice_p20: { count: 0, tiv: 50_000_000 },
      non_renew: { count: 40, tiv: 210_000_000 },
      cede_qs: { count: 60, tiv: 320_000_000 },
      cede_xs: { count: 70, tiv: 170_000_000 },
    },
    cohorts: [],
    actions: [],
    ...overrides,
  };
}

const SAMPLE_ROL_LAYERS = [
  { type: 'QS', rol: 0.18 },
  { type: 'XS', rol: 0.1, attachment: 20_000_000 },
  { type: 'XS', rol: 0.06, attachment: 60_000_000 },
];

// --- persona config sanity --------------------------------------------------

describe('persona config', () => {
  test('PERSONA_VALUES are the five canonical ids', () => {
    expect([...PERSONA_VALUES]).toEqual([
      'cat-ops',
      'actuary',
      'reinsurance',
      'field-ops',
      'academic',
    ]);
  });

  test('parsePersona returns cat-ops on unknown / missing', () => {
    expect(parsePersona(null)).toBe('cat-ops');
    expect(parsePersona(undefined)).toBe('cat-ops');
    expect(parsePersona('')).toBe('cat-ops');
    expect(parsePersona('not-a-persona')).toBe('cat-ops');
    expect(parsePersona('actuary')).toBe('actuary');
  });

  test('cat-ops surfaces the what-if rail; other personas do not', () => {
    expect(getPersonaConfig('cat-ops').whatIfRail).toBe(true);
    for (const p of PERSONA_VALUES.filter((x) => x !== 'cat-ops')) {
      expect(getPersonaConfig(p).whatIfRail).toBe(false);
    }
  });

  test('each non-default persona surfaces at least one quick-link', () => {
    expect(getPersonaConfig('cat-ops').quickLinks.length).toBe(0);
    for (const p of PERSONA_VALUES.filter((x) => x !== 'cat-ops')) {
      expect(getPersonaConfig(p).quickLinks.length).toBeGreaterThan(0);
    }
  });
});

// --- PersonaToggle (controlled) — Phase 1 contract preserved ---------------

describe('PersonaToggle (controlled, Phase 1)', () => {
  test('renders all 5 mode buttons', () => {
    render(<PersonaToggle value="cat-ops" onChange={() => {}} />);
    for (const meta of PERSONAS) {
      expect(screen.getByRole('button', { name: meta.label })).toBeInTheDocument();
    }
  });
});

// --- PersonaToggleUrl — URL-backed -----------------------------------------

describe('PersonaToggleUrl', () => {
  test('default persona is cat-ops when no query string', () => {
    mockedQuery = '';
    render(<PersonaToggleUrl />);
    expect(screen.getByRole('button', { name: 'Cat-ops' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('?persona=actuary marks Actuary active', () => {
    mockedQuery = 'persona=actuary';
    render(<PersonaToggleUrl />);
    expect(screen.getByRole('button', { name: 'Actuary' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('invalid ?persona= falls back to cat-ops', () => {
    mockedQuery = 'persona=banana';
    render(<PersonaToggleUrl />);
    expect(screen.getByRole('button', { name: 'Cat-ops' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('clicking a button updates the URL via router.replace', () => {
    mockedQuery = '';
    mockedPathname = '/portfolio';
    render(<PersonaToggleUrl />);
    fireEvent.click(screen.getByRole('button', { name: 'Reinsurance' }));
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    const [href, opts] = replaceSpy.mock.calls[0];
    expect(href).toBe('/portfolio?persona=reinsurance');
    expect(opts).toEqual({ scroll: false });
  });

  test('clicking Cat-ops clears the param (canonical URL)', () => {
    mockedQuery = 'persona=actuary';
    mockedPathname = '/events';
    render(<PersonaToggleUrl />);
    fireEvent.click(screen.getByRole('button', { name: 'Cat-ops' }));
    const [href] = replaceSpy.mock.calls[0];
    expect(href).toBe('/events');
  });

  test('preserves other query keys when switching personas', () => {
    mockedQuery = 'storm=AL092024';
    mockedPathname = '/events';
    render(<PersonaToggleUrl />);
    fireEvent.click(screen.getByRole('button', { name: 'Academic' }));
    const [href] = replaceSpy.mock.calls[0];
    expect(href).toContain('storm=AL092024');
    expect(href).toContain('persona=academic');
  });
});

// --- PortfolioPersonaScope — per-persona ExecCards -------------------------

describe('PortfolioPersonaScope — per-persona content', () => {
  function renderScope(query: string) {
    mockedQuery = query;
    mockedPathname = '/portfolio';
    return render(
      <PortfolioPersonaScope
        initialOptimization={makeOptimization()}
        totalTiv={3_100_000_000}
        rolLayers={SAMPLE_ROL_LAYERS}
        crps={undefined}
        saaGap={undefined}
        vrpDemand={undefined}
      />,
    );
  }

  test('cat-ops (default) renders 5 cards + what-if rail + no quick-links', () => {
    renderScope('');
    const header = screen.getByTestId('portfolio-header');
    expect(header.getAttribute('data-persona')).toBe('cat-ops');
    expect(within(header).getAllByTestId('exec-card').length).toBe(5);
    expect(screen.getByTestId('whatif-rail')).toBeInTheDocument();
    expect(screen.queryByTestId('persona-quick-links')).toBeNull();
    // The headline cat-ops cards are present.
    expect(within(header).getByText('Expected margin')).toBeInTheDocument();
    expect(within(header).getByText('Cession spend')).toBeInTheDocument();
  });

  test('?persona=actuary swaps margin → Retained TVaR-99 + adds CRPS + shows /calibration', () => {
    renderScope('persona=actuary');
    const header = screen.getByTestId('portfolio-header');
    expect(header.getAttribute('data-persona')).toBe('actuary');
    // 2026-05-23: card label renamed from "VaR-99 (proxy)" to
    // "Retained TVaR-99" — schema v5 now ships a real coherent tail
    // measure (mean of top 1 % of merged book-loss scenarios) rather
    // than re-purposing book_totals.loss_p99 as a VaR proxy.
    expect(within(header).getByText('Retained TVaR-99')).toBeInTheDocument();
    expect(within(header).queryByText('Expected margin')).toBeNull();
    expect(within(header).getByText('CRPS')).toBeInTheDocument();
    // Quick-links band carries the /calibration link.
    const links = screen.getByTestId('persona-quick-links');
    const calLink = within(links).getByText('Calibration');
    expect(calLink.closest('a')?.getAttribute('href')).toBe('/calibration');
    // What-if rail is suppressed for non-cat-ops lenses.
    expect(screen.queryByTestId('whatif-rail')).toBeNull();
  });

  test('?persona=reinsurance swaps cession → RoL-by-layer + adds retained-tail + /treaty link', () => {
    renderScope('persona=reinsurance');
    const header = screen.getByTestId('portfolio-header');
    expect(header.getAttribute('data-persona')).toBe('reinsurance');
    expect(within(header).getByText('RoL by layer')).toBeInTheDocument();
    expect(within(header).queryByText('Cession spend')).toBeNull();
    expect(within(header).getByText('Retained tail (post-XS)')).toBeInTheDocument();
    const links = screen.getByTestId('persona-quick-links');
    const treatyLink = within(links).getByText('Treaty layers');
    expect(treatyLink.closest('a')?.getAttribute('href')).toBe('/treaty');
  });

  test('?persona=field-ops adds VRP demand card + adjuster-load quick-link', () => {
    renderScope('persona=field-ops');
    const header = screen.getByTestId('portfolio-header');
    expect(header.getAttribute('data-persona')).toBe('field-ops');
    expect(within(header).getByText('VRP demand adj.')).toBeInTheDocument();
    const links = screen.getByTestId('persona-quick-links');
    const claimsLink = within(links).getByText('Adjuster-load');
    expect(claimsLink.closest('a')?.getAttribute('href')).toBe('/claims');
  });

  test('?persona=academic adds SAA optimality-gap card + methodology link', () => {
    renderScope('persona=academic');
    const header = screen.getByTestId('portfolio-header');
    expect(header.getAttribute('data-persona')).toBe('academic');
    expect(within(header).getByText('SAA optimality gap')).toBeInTheDocument();
    const links = screen.getByTestId('persona-quick-links');
    const methodLink = within(links).getByText('Methodology');
    expect(methodLink.closest('a')?.getAttribute('href')).toBe('/methodology');
  });

  test('CRPS / SAA-gap / VRP cards render SYNTHETIC_SCAFFOLD when data is absent', () => {
    // No crps / saaGap / vrpDemand passed → cards still render with a "—"
    // placeholder and the SYNTHETIC_SCAFFOLD trust tier.
    mockedQuery = 'persona=academic';
    render(
      <PortfolioPersonaScope
        initialOptimization={makeOptimization()}
        totalTiv={3_100_000_000}
      />,
    );
    const header = screen.getByTestId('portfolio-header');
    const gapCard = within(header).getByText('SAA optimality gap').closest('[data-testid="exec-card"]');
    expect(gapCard).not.toBeNull();
    expect(within(gapCard as HTMLElement).getByText('—')).toBeInTheDocument();
    // The trust badge for the synthetic card should read "Demo".
    expect(within(gapCard as HTMLElement).getByText('Demo')).toBeInTheDocument();
  });
});

// --- sanity: DEFAULT_PERSONA matches the cat-ops contract ------------------

describe('default persona invariants', () => {
  test('DEFAULT_PERSONA is cat-ops', () => {
    expect(DEFAULT_PERSONA).toBe('cat-ops');
  });
});
