/**
 * Task P2.24 — SitrepPanel component tests.
 *
 * Phase 2 replaces the free-form markdown body with a structured 6-field
 * memo (threat_tier, lead_time_hours, portfolio_recommendation,
 * operational_recommendation, claims_prep_recommendation,
 * escalation_criteria) rendered as a label/value table. The panel takes
 * the structured payload + a `dataSource` discriminator as props; the
 * parent owns the fetch flow.
 *
 * Coverage:
 *   1. Renders all 6 rows when given a valid StructuredSitrep.
 *   2. Threat-tier badge color reflects the tier.
 *   3. lead_time_hours formatted as T-{n}h.
 *   4. Empty / missing escalation_criteria renders the em-dash placeholder.
 *   5. data_source: 'synthetic_fallback' shows SYNTHETIC_SCAFFOLD badge.
 *   6. TrustTierBadge + ProvenanceFootnote both present.
 */
import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import {
  SitrepPanel,
  type StructuredSitrep,
} from '@/components/SitrepPanel';

afterEach(() => cleanup());

function makeSitrep(overrides: Partial<StructuredSitrep> = {}): StructuredSitrep {
  return {
    threat_tier: 'high',
    lead_time_hours: 36,
    portfolio_recommendation:
      'Cede QS on FL ZIP3 330–339 cohorts; non-renew the worst-decile.',
    operational_recommendation:
      'Stage 12 adjusters in Tampa, 8 in Miami, 6 in Jacksonville.',
    claims_prep_recommendation:
      'Pre-flag cohorts above 35% probability; open IVR overflow.',
    escalation_criteria:
      'Re-broadcast if peak wind exceeds 140 mph or cone shifts >25 nm east.',
    ...overrides,
  };
}

describe('SitrepPanel · structured rendering', () => {
  test('renders all 6 rows when given a valid StructuredSitrep', () => {
    render(
      <SitrepPanel
        sitrep={makeSitrep()}
        dataSource="live"
        context={null}
        onGenerate={() => {}}
      />,
    );
    const panel = screen.getByTestId('sitrep-panel');
    // Every field gets a labeled row.
    expect(within(panel).getByTestId('sitrep-row-threat-tier')).toBeInTheDocument();
    expect(within(panel).getByTestId('sitrep-row-lead-time')).toBeInTheDocument();
    expect(
      within(panel).getByTestId('sitrep-row-portfolio-recommendation'),
    ).toBeInTheDocument();
    expect(
      within(panel).getByTestId('sitrep-row-operational-recommendation'),
    ).toBeInTheDocument();
    expect(
      within(panel).getByTestId('sitrep-row-claims-prep-recommendation'),
    ).toBeInTheDocument();
    expect(
      within(panel).getByTestId('sitrep-row-escalation-criteria'),
    ).toBeInTheDocument();
    // Value cells carry the supplied content.
    expect(panel).toHaveTextContent('Cede QS on FL ZIP3');
    expect(panel).toHaveTextContent('Stage 12 adjusters in Tampa');
    expect(panel).toHaveTextContent('Pre-flag cohorts');
    expect(panel).toHaveTextContent('Re-broadcast if peak wind');
  });

  test('threat-tier badge color reflects the tier', () => {
    // critical → red palette.
    const { rerender } = render(
      <SitrepPanel
        sitrep={makeSitrep({ threat_tier: 'critical' })}
        dataSource="live"
        context={null}
        onGenerate={() => {}}
      />,
    );
    let badge = screen.getByTestId('sitrep-threat-tier-badge');
    expect(badge.className).toMatch(/red/);
    expect(badge.textContent?.toLowerCase()).toContain('critical');

    // high → orange.
    rerender(
      <SitrepPanel
        sitrep={makeSitrep({ threat_tier: 'high' })}
        dataSource="live"
        context={null}
        onGenerate={() => {}}
      />,
    );
    badge = screen.getByTestId('sitrep-threat-tier-badge');
    expect(badge.className).toMatch(/orange/);

    // medium → amber.
    rerender(
      <SitrepPanel
        sitrep={makeSitrep({ threat_tier: 'medium' })}
        dataSource="live"
        context={null}
        onGenerate={() => {}}
      />,
    );
    badge = screen.getByTestId('sitrep-threat-tier-badge');
    expect(badge.className).toMatch(/amber/);

    // low → slate.
    rerender(
      <SitrepPanel
        sitrep={makeSitrep({ threat_tier: 'low' })}
        dataSource="live"
        context={null}
        onGenerate={() => {}}
      />,
    );
    badge = screen.getByTestId('sitrep-threat-tier-badge');
    expect(badge.className).toMatch(/slate/);
  });

  test('lead_time_hours formatted as T-{n}h', () => {
    render(
      <SitrepPanel
        sitrep={makeSitrep({ lead_time_hours: 36 })}
        dataSource="live"
        context={null}
        onGenerate={() => {}}
      />,
    );
    const cell = screen.getByTestId('sitrep-lead-time-value');
    expect(cell.textContent).toBe('T-36h');
  });

  test('empty / missing escalation_criteria renders the em-dash placeholder', () => {
    render(
      <SitrepPanel
        sitrep={makeSitrep({ escalation_criteria: '' })}
        dataSource="live"
        context={null}
        onGenerate={() => {}}
      />,
    );
    const row = screen.getByTestId('sitrep-row-escalation-criteria');
    // Em-dash sentinel for missing data, not the literal empty string.
    expect(row.textContent).toMatch(/—/);
  });

  test("data_source: 'synthetic_fallback' shows SYNTHETIC_SCAFFOLD badge instead of RECOMMENDATION", () => {
    const { rerender } = render(
      <SitrepPanel
        sitrep={makeSitrep()}
        dataSource="live"
        context={null}
        onGenerate={() => {}}
      />,
    );
    // Live ⇒ RECOMMENDATION badge (label = "Recommend").
    let trustBadge = screen.getByTestId('sitrep-trust-badge');
    expect(trustBadge.textContent).toMatch(/Recommend/);

    // Synthetic-fallback ⇒ SYNTHETIC_SCAFFOLD badge (label = "Demo").
    rerender(
      <SitrepPanel
        sitrep={makeSitrep()}
        dataSource="synthetic_fallback"
        context={null}
        onGenerate={() => {}}
      />,
    );
    trustBadge = screen.getByTestId('sitrep-trust-badge');
    expect(trustBadge.textContent).toMatch(/Demo/);
  });

  test('TrustTierBadge + ProvenanceFootnote both present', () => {
    render(
      <SitrepPanel
        sitrep={makeSitrep()}
        dataSource="live"
        context={null}
        onGenerate={() => {}}
      />,
    );
    expect(screen.getByTestId('sitrep-trust-badge')).toBeInTheDocument();
    expect(screen.getByTestId('provenance-footnote')).toBeInTheDocument();
    // Footnote must cite the agent tool by name.
    const footnote = screen.getByTestId('provenance-footnote');
    expect(footnote.textContent).toMatch(/draft_sitrep/);
  });
});
