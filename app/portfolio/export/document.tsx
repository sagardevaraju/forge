/**
 * Task P2.30 — React-PDF document for the Portfolio board-deck export.
 *
 * Renders a static one-to-two page PDF summarizing the cached Portfolio MIP
 * decision: headline + objective, action mix, budget triple, and a
 * provenance footer. Intentionally avoids the map / cohort drill-down —
 * see the route's docstring for scope rationale.
 *
 * Pure presentational module: takes the in-memory PortfolioOptimization
 * (with `loss_scenarios` stripped) and the ISO timestamp the route stamps
 * on the document. No fs / network access here so the unit tests can
 * exercise the renderer with a small fake artifact.
 */
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from '@react-pdf/renderer';
import * as React from 'react';
import {
  ACTION_LABELS,
  type ActionName,
  type PortfolioOptimization,
} from '@/lib/portfolio-actions';

// Tailwind-ish palette so the printed deck reads as part of the same family
// as the web view. Kept compact — react-pdf StyleSheet is not full CSS.
const styles = StyleSheet.create({
  page: {
    paddingTop: 48,
    paddingHorizontal: 48,
    paddingBottom: 48,
    fontFamily: 'Helvetica',
    fontSize: 10,
    color: '#0f172a',
  },
  headline: {
    fontSize: 22,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 4,
  },
  subhead: {
    fontSize: 11,
    color: '#475569',
    marginBottom: 18,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    marginTop: 18,
    marginBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
    paddingBottom: 3,
  },
  paragraph: {
    fontSize: 10,
    lineHeight: 1.5,
    marginBottom: 6,
  },
  scalarsRow: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  scalarCell: {
    flex: 1,
    padding: 8,
    backgroundColor: '#f8fafc',
    marginRight: 6,
    borderRadius: 4,
  },
  scalarCellLast: {
    flex: 1,
    padding: 8,
    backgroundColor: '#f8fafc',
    borderRadius: 4,
  },
  scalarLabel: {
    fontSize: 8,
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  scalarValue: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
  },
  table: {
    width: '100%',
    marginTop: 4,
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: '#0f172a',
    color: '#f8fafc',
    paddingVertical: 5,
    paddingHorizontal: 6,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: '#e2e8f0',
    paddingVertical: 5,
    paddingHorizontal: 6,
  },
  tableRowAlt: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    paddingVertical: 5,
    paddingHorizontal: 6,
  },
  colAction: { flex: 2 },
  colCount: { flex: 1, textAlign: 'right' },
  colTiv: { flex: 1.5, textAlign: 'right' },
  colPct: { flex: 1, textAlign: 'right' },
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 48,
    right: 48,
    fontSize: 8,
    color: '#64748b',
    borderTopWidth: 0.5,
    borderTopColor: '#cbd5e1',
    paddingTop: 6,
    lineHeight: 1.4,
  },
});

function formatMoneyMillions(n: number): string {
  return `$${(n / 1_000_000).toFixed(1)}M`;
}

function formatMoneyBillions(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  return formatMoneyMillions(n);
}

function formatPct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}

interface DocProps {
  optimization: PortfolioOptimization & { schema_version?: number };
  isoTimestamp: string;
  isoDate: string;
}

/**
 * Builds the Portfolio export document. Exported so the unit tests can pass
 * the same fake artifact through the renderer without touching disk.
 */
export function PortfolioExportDocument({
  optimization,
  isoTimestamp,
  isoDate,
}: DocProps) {
  const schemaVersion = optimization.schema_version ?? 0;
  const totalActions = Object.values(optimization.action_summary).reduce(
    (acc, v) => acc + (v?.count ?? 0),
    0,
  );
  const totalActionTiv = Object.values(optimization.action_summary).reduce(
    (acc, v) => acc + (v?.tiv ?? 0),
    0,
  );

  // Order actions deterministically (matches the action grid in the UI).
  // P2.8 swapped the two reprice scalars for a 7-bucket rate grid.
  const orderedActions: ActionName[] = [
    'retain',
    'reprice_n20',
    'reprice_n10',
    'reprice_0',
    'reprice_p5',
    'reprice_p10',
    'reprice_p15',
    'reprice_p20',
    'non_renew',
    'cede_qs',
    'cede_xs',
  ];

  return (
    <Document
      title={`FORGE Portfolio Decision, ${isoDate}`}
      author="FORGE"
      subject="Portfolio MIP board-deck export"
    >
      <Page size="LETTER" style={styles.page} wrap>
        <Text style={styles.headline}>
          FORGE Portfolio Decision, {isoDate}
        </Text>
        <Text style={styles.subhead}>
          Optimizer status: {optimization.status} · Objective{' '}
          {formatMoneyMillions(optimization.objective)} · Horizon{' '}
          {optimization.horizon_start ?? 'n/a'} → {optimization.horizon_end ?? 'n/a'}
        </Text>

        {/* Book scalars row */}
        <View style={styles.scalarsRow}>
          <View style={styles.scalarCell}>
            <Text style={styles.scalarLabel}>Book TIV</Text>
            <Text style={styles.scalarValue}>
              {formatMoneyBillions(optimization.book_totals.tiv)}
            </Text>
          </View>
          <View style={styles.scalarCell}>
            <Text style={styles.scalarLabel}>Book Premium</Text>
            <Text style={styles.scalarValue}>
              {formatMoneyMillions(optimization.book_totals.premium)}
            </Text>
          </View>
          <View style={styles.scalarCell}>
            <Text style={styles.scalarLabel}>Loss P50</Text>
            <Text style={styles.scalarValue}>
              {formatMoneyMillions(optimization.book_totals.loss_p50)}
            </Text>
          </View>
          <View style={styles.scalarCellLast}>
            <Text style={styles.scalarLabel}>Loss P99</Text>
            <Text style={styles.scalarValue}>
              {formatMoneyMillions(optimization.book_totals.loss_p99)}
            </Text>
          </View>
        </View>

        <Text style={styles.sectionTitle}>Budget Triple</Text>
        <View style={styles.scalarsRow}>
          <View style={styles.scalarCell}>
            <Text style={styles.scalarLabel}>Capital budget</Text>
            <Text style={styles.scalarValue}>
              {formatMoneyMillions(optimization.budgets.capital_budget)}
            </Text>
          </View>
          <View style={styles.scalarCell}>
            <Text style={styles.scalarLabel}>Max non-renew</Text>
            <Text style={styles.scalarValue}>
              {formatPct(optimization.budgets.max_nonrenew_pct)}
            </Text>
          </View>
          <View style={styles.scalarCellLast}>
            <Text style={styles.scalarLabel}>Cession budget</Text>
            <Text style={styles.scalarValue}>
              {formatMoneyMillions(optimization.budgets.cession_budget)}
            </Text>
          </View>
        </View>

        <Text style={styles.sectionTitle}>Action Mix</Text>
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={styles.colAction}>Action</Text>
            <Text style={styles.colCount}>Count</Text>
            <Text style={styles.colTiv}>TIV</Text>
            <Text style={styles.colPct}>Share</Text>
          </View>
          {orderedActions.map((action, idx) => {
            const row = optimization.action_summary[action] ?? { count: 0, tiv: 0 };
            const share = totalActionTiv > 0 ? row.tiv / totalActionTiv : 0;
            const style = idx % 2 === 0 ? styles.tableRow : styles.tableRowAlt;
            return (
              <View key={action} style={style}>
                <Text style={styles.colAction}>{ACTION_LABELS[action]}</Text>
                <Text style={styles.colCount}>{row.count.toLocaleString()}</Text>
                <Text style={styles.colTiv}>{formatMoneyMillions(row.tiv)}</Text>
                <Text style={styles.colPct}>{formatPct(share)}</Text>
              </View>
            );
          })}
          <View style={styles.tableRow}>
            <Text style={[styles.colAction, { fontFamily: 'Helvetica-Bold' }]}>
              Total
            </Text>
            <Text style={[styles.colCount, { fontFamily: 'Helvetica-Bold' }]}>
              {totalActions.toLocaleString()}
            </Text>
            <Text style={[styles.colTiv, { fontFamily: 'Helvetica-Bold' }]}>
              {formatMoneyMillions(totalActionTiv)}
            </Text>
            <Text style={styles.colPct}>—</Text>
          </View>
        </View>

        <Text style={styles.sectionTitle}>Provenance</Text>
        <Text style={styles.paragraph}>
          This decision was loaded from `artifacts/portfolio_optimization.json`
          (schema_version {schemaVersion}). The optimizer is a mixed-integer
          program solved with CBC over {optimization.cohorts.length}{' '}
          {`{zip3, build_type, tiv_quintile}`} cohorts. Cohort priors are
          HAZUS-derived. See `docs/methodology.md`. Re-solve via{' '}
          {`POST /api/optimize/portfolio`}.
        </Text>

        <Text style={styles.footer} fixed>
          Generated from `artifacts/portfolio_optimization.json` schema_version{' '}
          {schemaVersion} at {isoTimestamp}. Re-solve via{' '}
          {`POST /api/optimize/portfolio`}. Cohort prior: HAZUS-derived (see
          docs/methodology.md).
        </Text>
      </Page>
    </Document>
  );
}
