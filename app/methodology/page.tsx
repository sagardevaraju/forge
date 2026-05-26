/**
 * /methodology — the credibility contract behind the console.
 *
 * History:
 *   - Task 14 (Redesign Phase 1) shipped this as a raw <pre> dump of
 *     docs/methodology.md so reviewers could read the defense without
 *     leaving the running app.
 *   - 2026-05-23: redesigned into a structured page (sticky TOC + anchored
 *     sections + grammar-tier badges + cross-links into the live console)
 *     because the markdown blob (a) didn't match FORGE's design language
 *     anywhere else, (b) wasn't navigable, and (c) buried the trust-tier
 *     vocabulary that every other view advertises.
 *
 * The content is the same defensible methodology we'd send to an actuary
 * or program-committee reviewer — every "magic" constant is named, located
 * in code, and pointed at its calibration source. Updates here MUST stay
 * in lock-step with `research.md` (real-world citations) and the
 * `// Citation:` docstrings on the constants themselves.
 *
 * No new deps. Sections are plain JSX so search, anchors, and Tailwind
 * typography work without a markdown runtime.
 */
import Link from 'next/link';
import { TrustTierBadge } from '@/components/grammar/TrustTierBadge';
import { ProvenanceFootnote } from '@/components/grammar/ProvenanceFootnote';
import { CoastalZip3Catalog } from '@/components/methodology/CoastalZip3Catalog';
import type { TrustTier } from '@/lib/grammar/trust-tiers';
import { loadCoastalZip3Catalog } from '@/lib/methodology/coastal_zip3s';

export const dynamic = 'force-dynamic';

interface TocItem {
  id: string;
  label: string;
}

const TOC: TocItem[] = [
  { id: 'trust-tiers', label: '1 · Trust tiers' },
  { id: 'mip', label: '2 · Portfolio MIP' },
  { id: 'peril-severity', label: '3 · Peril severity' },
  { id: 'risk-measures', label: '4 · Risk measure (TVaR-99)' },
  { id: 'vrp-lp', label: '5 · Adjuster LP — integrality' },
  { id: 'magic-constants', label: '6 · Magic constants' },
  { id: 'coastal-zip3s', label: '7 · Coastal ZIP3 catalog' },
  { id: 'reproducibility', label: '8 · Reproducibility' },
  { id: 'deferrals', label: '9 · Deferrals' },
  { id: 'references', label: 'References' },
];

interface TierRowProps {
  tier: TrustTier;
  description: string;
  example: string;
}

function TierRow({ tier, description, example }: TierRowProps) {
  return (
    <div className="grid grid-cols-[180px_1fr] gap-4 py-3 border-b border-zinc-100 last:border-0">
      <div>
        <TrustTierBadge tier={tier} />
      </div>
      <div className="text-[13px] text-zinc-700 leading-relaxed">
        <p className="text-zinc-900">{description}</p>
        <p className="text-zinc-500 mt-1">e.g. {example}</p>
      </div>
    </div>
  );
}

interface ConstantRowProps {
  name: string;
  location: string;
  problem: string;
  fix: string;
  href?: string;
}

function ConstantRow({ name, location, problem, fix, href }: ConstantRowProps) {
  return (
    <li className="rounded-md ring-1 ring-zinc-200/70 px-4 py-3 bg-white">
      <div className="flex items-baseline justify-between gap-3 mb-1.5">
        <code className="text-[12.5px] font-mono font-semibold text-zinc-900">{name}</code>
        <code className="text-[10.5px] font-mono text-zinc-500">{location}</code>
      </div>
      <p className="text-[12.5px] text-zinc-700 leading-relaxed">
        <span className="font-medium text-zinc-900">Problem:</span> {problem}
      </p>
      <p className="text-[12.5px] text-zinc-700 leading-relaxed mt-1">
        <span className="font-medium text-zinc-900">Fix:</span> {fix}
        {href && (
          <>
            {' '}
            <Link href={href} className="text-emerald-700 hover:text-emerald-900 underline-offset-2 hover:underline decoration-emerald-300">
              View live →
            </Link>
          </>
        )}
      </p>
    </li>
  );
}

function SectionHeading({ id, eyebrow, title }: { id: string; eyebrow: string; title: string }) {
  return (
    <header className="mb-4 scroll-mt-20" id={id}>
      <p className="text-[10.5px] uppercase tracking-[0.16em] font-medium text-zinc-500">
        {eyebrow}
      </p>
      <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-zinc-900 mt-1">
        {title}
      </h2>
    </header>
  );
}

export default async function MethodologyPage() {
  const coastalCatalog = await loadCoastalZip3Catalog();
  return (
    <div className="mx-auto max-w-[1400px] px-6 py-8">
      {/* Hero */}
      <header className="mb-8 border-b hairline pb-5">
        <p className="text-[10.5px] uppercase tracking-[0.18em] font-medium text-zinc-500 mb-1">
          FORGE · Reviewer-facing
        </p>
        <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-zinc-900 leading-none">
          Methodology
        </h1>
        <p className="text-[13.5px] text-zinc-600 mt-3 max-w-prose">
          The credibility contract behind the console. Every magic constant
          is named, located in code, and pointed at the citation that
          replaces it. The aim is to surface the gaps before an actuary or
          program-committee reviewer does.
        </p>
        <p className="text-[12px] text-zinc-500 mt-2">
          Companion files:{' '}
          <code className="font-mono text-zinc-700">docs/methodology.md</code>{' '}
          (defended constants, plan tasks),{' '}
          <code className="font-mono text-zinc-700">research.md</code>{' '}
          (real-world citations).
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-10">
        {/* Sticky TOC */}
        <nav
          aria-label="Table of contents"
          className="lg:sticky lg:top-16 lg:self-start text-[12.5px]"
        >
          <p className="text-[10.5px] uppercase tracking-[0.12em] font-medium text-zinc-500 mb-2">
            On this page
          </p>
          <ul className="space-y-1.5">
            {TOC.map((item) => (
              <li key={item.id}>
                <a
                  href={`#${item.id}`}
                  className="text-zinc-700 hover:text-zinc-900 hover:underline decoration-zinc-300 underline-offset-2"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* Body */}
        <article className="space-y-12 max-w-[820px]">
          {/* §1 Trust tiers */}
          <section>
            <SectionHeading
              id="trust-tiers"
              eyebrow="§1 · Grammar contract"
              title="Trust tiers"
            />
            <p className="text-[13px] text-zinc-700 leading-relaxed mb-4">
              Every numbered surface — chart, KPI, recommendation pill,
              sitrep bullet — mounts a{' '}
              <code className="font-mono text-[12px] bg-zinc-100 px-1.5 py-0.5 rounded">
                TrustTierBadge
              </code>{' '}
              and (in most cases) a{' '}
              <code className="font-mono text-[12px] bg-zinc-100 px-1.5 py-0.5 rounded">
                ProvenanceFootnote
              </code>
              . The five tiers form a strict provenance hierarchy. A number
              with the wrong badge is worse than a number with no badge —
              see CLAUDE.md{' '}
              <em>&quot;Data integrity — every value traces to a real source.&quot;</em>
            </p>
            <div className="rounded-md ring-1 ring-zinc-200/70 px-4 py-1 bg-white">
              <TierRow
                tier="LIVE_FEED"
                description="Pulled from an upstream API this minute."
                example="NHC CurrentStorms.json on /events; NWS active alerts; FIRMS thermal anomalies."
              />
              <TierRow
                tier="MODEL_OUTPUT"
                description="A calibrated model emitted this number."
                example="XGBoost loss heads, CV head, scenario generator, realized retained TVaR-99."
              />
              <TierRow
                tier="SYNTHETIC_SCAFFOLD"
                description="Placeholder distribution standing in for a real feed until Phase 2 ingestion lands. Also worn when a solve is contaminated (e.g. Infeasible)."
                example="Total TIV from the seed; CRPS pending /calibration calibration."
              />
              <TierRow
                tier="RECOMMENDATION"
                description="Optimizer output. Only worn when the solver converged."
                example="Per-cohort dominant action on /portfolio; runbook output on /events."
              />
              <TierRow
                tier="MANUAL_OVERRIDE"
                description="Human-pinned value."
                example="Adjuster supervisor pinning a non-renewal flag in /claims."
              />
            </div>
          </section>

          {/* §2 Portfolio MIP */}
          <section>
            <SectionHeading
              id="mip"
              eyebrow="§2 · Optimization"
              title="Portfolio MIP"
            />
            <p className="text-[13px] text-zinc-700 leading-relaxed mb-3">
              The Portfolio MIP allocates each cohort to a single
              underwriting action drawn from an 11-action set:{' '}
              <code className="font-mono text-[12px]">retain</code>, the
              7-bucket reprice rate grid{' '}
              <code className="font-mono text-[12px]">
                {'{n20, n10, 0, p5, p10, p15, p20}'}
              </code>
              ,{' '}
              <code className="font-mono text-[12px]">non_renew</code>,{' '}
              <code className="font-mono text-[12px]">cede_qs</code>, and{' '}
              <code className="font-mono text-[12px]">cede_xs</code>.
            </p>
            <p className="text-[13px] text-zinc-700 leading-relaxed mb-3">
              The reprice grid is priced with a per-cohort price-elasticity
              correction: effective_premium ={' '}
              <code className="font-mono text-[12px]">
                base × (1 + Δrate) × (1 − η · max(Δrate, 0))
              </code>
              . The clamp encodes the empirical asymmetry that rate cuts do
              not churn customers; elasticity only bites when rates rise.
              Default η = 0.5, traceable to NAIC market-conduct retention
              studies.
            </p>
            <div className="rounded-md bg-amber-50 ring-1 ring-amber-200 px-4 py-3 mt-4">
              <p className="text-[12.5px] text-amber-900 leading-relaxed">
                <span className="font-semibold">Infeasibility contract:</span>{' '}
                when CBC reports <code className="font-mono">Infeasible</code>{' '}
                — i.e. the retained-tail constraint cannot be satisfied under
                the budget triple — the solver returns{' '}
                <code className="font-mono">objective = null</code> and
                zeroed action shares. The UI must downgrade every
                solve-derived ExecCard to{' '}
                <TrustTierBadge tier="SYNTHETIC_SCAFFOLD" className="!text-[9px] !px-1 !py-0" />{' '}
                and render &quot;—&quot; over a banner explaining the
                constraint. The pre-2026 code surfaced an internal
                LP-relaxed value as &quot;Expected margin&quot; under a{' '}
                <TrustTierBadge tier="RECOMMENDATION" className="!text-[9px] !px-1 !py-0" />{' '}
                badge; that&apos;s the same class of bug as a{' '}
                <TrustTierBadge tier="LIVE_FEED" className="!text-[9px] !px-1 !py-0" />{' '}
                badge over mock data.
              </p>
            </div>
            <p id="treaty" className="text-[13px] text-zinc-700 leading-relaxed mt-4 mb-3 scroll-mt-20">
              The capital constraint uses <strong>retained TVaR-99</strong>{' '}
              — mean of the top 1 % of book-aggregated loss scenarios after
              each cohort&apos;s chosen action has been applied, with{' '}
              <code className="font-mono text-[12px]">cede_xs</code>{' '}
              cohorts running the per-scenario{' '}
              <code className="font-mono text-[12px]">retained_xs</code>{' '}
              integration{' '}
              <code className="font-mono text-[12px]">
                min(L, attachment) + max(0, L − exhaustion)
              </code>
              . The capital budget is sized as 40 % of the empirical
              book-TVaR-99 of the merged scenario set, anchored to the
              Citizens FL FHCF PML/AAL ratio (~7×) — see{' '}
              <code className="font-mono text-[12px]">research.md §7</code>.
            </p>
            <p className="text-[13px] text-zinc-700 leading-relaxed">
              See the live solve at{' '}
              <Link href="/portfolio" className="text-emerald-700 hover:text-emerald-900 underline-offset-2 hover:underline decoration-emerald-300">
                /portfolio
              </Link>
              . What-if controls re-solve in place against the same
              constraint set; the cohort-level recommendations stream into
              the map.
            </p>
          </section>

          {/* §3 Peril severity */}
          <section>
            <SectionHeading
              id="peril-severity"
              eyebrow="§3 · Simulation"
              title="Peril severity"
            />
            <p className="text-[13px] text-zinc-700 leading-relaxed mb-3">
              The <Link href="/simulate" className="text-emerald-700 hover:text-emerald-900 underline-offset-2 hover:underline decoration-emerald-300">/simulate</Link>{' '}
              flow computes per-cohort loss as{' '}
              <code className="font-mono text-[12px]">
                HAZUS_base[build_type][peril] × multiplier(severity)
              </code>
              , clamped to [0, 1]. The TS implementation in{' '}
              <code className="font-mono text-[12px]">lib/sim/severity.ts</code>{' '}
              and the Python mirror in{' '}
              <code className="font-mono text-[12px]">api_py/sim_loss.py</code>{' '}
              must stay in sync; they are tested independently and one
              drifting silently inflates or deflates gross loss.
            </p>
            <p className="text-[13px] text-zinc-700 leading-relaxed mb-3">
              <strong>Calibration convention:</strong> the top realistic
              tier maps to multiplier = 1.0 = HAZUS-severe damage (Hail
              45 mm, dNBR high, NWS major, WSSI extreme, Mw 7.0, EF3). Lower
              tiers reflect physical reality, not a relabeled spine — every
              numeric value cites a published source in{' '}
              <code className="font-mono text-[12px]">research.md</code>{' '}
              (TDI Uri report, NWS WSSI, USGS dNBR, FEMA HAZUS-Flood TM 4.0,
              Brooks 2004, Bakun–Wentworth 1997).
            </p>
            <p className="text-[13px] text-zinc-700 leading-relaxed">
              Build-type vulnerability is FEMA HAZUS-Wind / Flood / IBHS-
              backed. Manufactured housing&apos;s flood base was 0.45 prior
              to the May 2026 recalibration (inverted from reality — HAZUS
              Flood TM 4.0 puts MH curves <em>above</em> wood frame); raised
              to 0.65 to match the upper end of the MH depth-damage curve.
            </p>
          </section>

          {/* §4 Risk measure */}
          <section>
            <SectionHeading
              id="risk-measures"
              eyebrow="§4 · Coherence"
              title="Risk measure (TVaR-99)"
            />
            <p className="text-[13px] text-zinc-700 leading-relaxed mb-3">
              VaR is intuitive (a single quantile) but not coherent — not
              sub-additive, so it can recommend portfolios that look safer
              when diced than when aggregated. Phase 2 P2.6 swapped the
              capital constraint to TVaR-99 (expected loss conditional on
              exceeding the 99th percentile) which{' '}
              <em>is</em> coherent in the sense of Artzner, Delbaen, Eber,
              and Heath,{' '}
              <em>&ldquo;Coherent Measures of Risk,&rdquo;</em>{' '}
              Mathematical Finance 1999.
            </p>
            <p className="text-[13px] text-zinc-700 leading-relaxed">
              On the Actuary persona{' '}
              (<Link href="/portfolio?persona=actuary" className="text-emerald-700 hover:text-emerald-900 underline-offset-2 hover:underline decoration-emerald-300">
                /portfolio?persona=actuary
              </Link>
              ), the &quot;Retained TVaR-99&quot; card surfaces the realized
              retained tail under the solver&apos;s chosen action mix — not
              the gross book p99 sum. The card moves when the operator
              changes the budget triple; the pre-2026 card was invariant to
              the action mix and therefore tautological.
            </p>
          </section>

          {/* §5 VRP LP */}
          <section>
            <SectionHeading
              id="vrp-lp"
              eyebrow="§5 · Operations LP"
              title="Adjuster assignment — integrality argument"
            />
            <p className="text-[13px] text-zinc-700 leading-relaxed">
              The operational adjuster-assignment program is solved as an
              LP, not an IP, even though &ldquo;adjuster X assigned to
              staging zone Y on day D&rdquo; is binary. This is not a
              relaxation gamble: the assignment polytope is{' '}
              <strong>totally unimodular</strong>, which is sufficient for
              the LP relaxation to have integer extreme points whenever the
              right-hand side is integer (Birkhoff–von Neumann, 1946;
              Bertsimas &amp; Tsitsiklis,{' '}
              <em>Introduction to Linear Optimization</em>, Ch. 7). The LP
              returns an integer solution by construction, not by luck —
              the operational schedule never needs branch-and-bound and the
              solve stays under the 5-second budget.
            </p>
          </section>

          {/* §6 Magic constants */}
          <section>
            <SectionHeading
              id="magic-constants"
              eyebrow="§6 · Calibration plan"
              title="Magic constants and their fixes"
            />
            <p className="text-[13px] text-zinc-700 leading-relaxed mb-4">
              Each entry lists the constant, its location in code, the
              problem the engineer&apos;s pick caused, and the calibrated
              replacement.
            </p>
            <ul className="space-y-3">
              <ConstantRow
                name="REPRICE_FACTOR"
                location="api_py/optimize_portfolio.py"
                problem="Flat ×1.15 (up) / ×0.90 (down) multipliers — an actuary's first objection."
                fix="Replaced by a 7-bucket rate grid {−20%, −10%, 0, +5%, +10%, +15%, +20%} with retention elasticity. Live: see /portfolio's dominant-action distribution."
                href="/portfolio"
              />
              <ConstantRow
                name="CESSION_COST_RATE"
                location="api_py/optimize_portfolio.py"
                problem="Per-action scalars {cede_qs: 0.6, cede_xs: 0.15} divorced from treaty attachment/exhaustion."
                fix="cede_xs now uses per-scenario retained_xs(L, attachment, exhaustion). cede_qs scalar retained pending the layered-treaty model in /treaty."
                href="/treaty"
              />
              <ConstantRow
                name="capital_budget anchor"
                location="scripts/precompute_portfolio_optimization.py"
                problem="Sized as 0.40 × prior-derived loss_p99 sum — invariant to merged simulation scenarios, producing mechanical infeasibility every time the operator promoted a sim."
                fix="Re-anchored to 0.40 × empirical book TVaR-99 of the merged scenario set. Adapts to whatever cat load the operator has promoted."
              />
              <ConstantRow
                name="loss prior σ"
                location="scripts/precompute_portfolio_optimization.py::PRIOR_SIGMA"
                problem="Implicit σ ≈ 0.596 (from p99 = 4 × p50) — lower bound of FL HO tail; produced 22× understatement vs merged-scenario empirical tail."
                fix="σ = 0.85 ⇒ p99/p50 ≈ 7.21, matching the Citizens FL FHCF PML/AAL anchor (~7×). research.md §7 names the FHCF 2024 PML report as the citation."
              />
              <ConstantRow
                name="LOSS_FACTOR (Claims)"
                location="app/claims/page.tsx"
                problem="Three-tier heuristic {high: 0.4, medium: 0.15, low: 0.05} applied to TIV."
                fix="Phase 2 P2.27 swaps this for the cohort loss_p50 from the XGB quantile head so the pre-brief list shares the optimizer's loss surface."
                href="/claims"
              />
              <ConstantRow
                name="Reconciler thresholds"
                location="lib/reconciler/index.ts"
                problem="NON_RENEW_THRESHOLD = 0.5 and HIGH_ADJUSTER_DAYS = 2 — operationally defensible but unbacked."
                fix="Phase 2 surfaces both as manager-configurable knobs; Phase 3 P3.9 tunes against post-mortem outcomes."
              />
            </ul>
          </section>

          {/* §7 Coastal ZIP3 catalog (AUDIT.3 Phase 4 closeout) */}
          <section>
            <SectionHeading
              id="coastal-zip3s"
              eyebrow="§7 · Real-data anchor"
              title="Coastal ZIP3 catalog"
            />
            <div className="flex items-center gap-2 mb-3">
              <TrustTierBadge tier="LIVE_FEED" />
              <span className="text-[12px] text-zinc-500">
                USGS National Elevation Dataset · refreshed by{' '}
                <code className="font-mono text-zinc-700">
                  scripts.precompute_coastal_zip3s
                </code>
              </span>
            </div>
            <p className="text-[13px] text-zinc-700 leading-relaxed mb-4">
              AUDIT.3 Phase 4 retired the hand-coded{' '}
              <code className="font-mono text-[12px]">_COASTAL_ZIP3S</code>{' '}
              literal in{' '}
              <code className="font-mono text-[12px]">ml/scenarios/generate.py</code>.
              The replacement is a 38-ZIP3 catalog computed from real data:
              centroids are the policy-table mean lat/lon per ZIP3, and
              elevations are point reads from the USGS{' '}
              <a
                href="https://epqs.nationalmap.gov/v1/json"
                className="underline decoration-zinc-300 hover:decoration-zinc-500"
                target="_blank"
                rel="noreferrer"
              >
                Elevation Point Query Service
              </a>{' '}
              backed by the National Elevation Dataset at 1/3-arcsec
              resolution. The catalog covers every coastal-state ZIP3
              with at least 50 seeded policies — wide enough to drive
              the storm-surge per-cohort uplift across the eight Gulf /
              Atlantic states, narrow enough to keep regeneration to
              ~80 s.
            </p>
            {coastalCatalog ? (
              <CoastalZip3Catalog payload={coastalCatalog} />
            ) : (
              <div className="rounded-md ring-1 ring-amber-200/70 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-900">
                <div className="font-semibold mb-1">
                  Catalog unavailable.
                </div>
                <div>
                  Run{' '}
                  <code className="font-mono">
                    python -m scripts.precompute_coastal_zip3s
                  </code>{' '}
                  to regenerate{' '}
                  <code className="font-mono">
                    artifacts/coastal_zip3s.json
                  </code>
                  .
                </div>
              </div>
            )}
          </section>

          {/* §8 Reproducibility */}
          <section>
            <SectionHeading
              id="reproducibility"
              eyebrow="§8 · Determinism"
              title="Reproducibility"
            />
            <p className="text-[13px] text-zinc-700 leading-relaxed mb-3">
              Every stochastic input has a pinned seed:{' '}
              <code className="font-mono text-[12px]">scripts/seed_policy_book.py</code>{' '}
              calls <code className="font-mono text-[12px]">random.seed(42)</code>{' '}
              so the 10k book is byte-identical across runs;{' '}
              <code className="font-mono text-[12px]">ml/xgb/train.py</code>{' '}
              uses{' '}
              <code className="font-mono text-[12px]">np.random.default_rng(seed=0)</code>{' '}
              for synthetic loss generation;{' '}
              <code className="font-mono text-[12px]">requirements.txt</code>{' '}
              and{' '}
              <code className="font-mono text-[12px]">package-lock.json</code>{' '}
              are pinned;{' '}
              <code className="font-mono text-[12px]">vercel.json</code>{' '}
              pins the runtime to{' '}
              <code className="font-mono text-[12px]">python3.12</code>.
            </p>
            <p className="text-[13px] text-zinc-700 leading-relaxed">
              The per-cohort lognormal draws used by the Portfolio MIP are
              seeded with{' '}
              <code className="font-mono text-[12px]">
                hash((zip3, build_type, q)) &amp; 0xFFFFFFFF
              </code>{' '}
              so re-running the precompute produces a deterministic
              artifact from start to finish.
            </p>
          </section>

          {/* §9 Deferrals */}
          <section>
            <SectionHeading
              id="deferrals"
              eyebrow="§9 · Roadmap"
              title="Deferred work"
            />
            <p className="text-[13px] text-zinc-700 leading-relaxed mb-3">
              The deferrals most likely to come up in review:
            </p>
            <ul className="space-y-1.5 text-[13px] text-zinc-700 leading-relaxed list-disc pl-5 marker:text-zinc-400">
              <li>Importance-sampled tail scenarios — P2.5.</li>
              <li>SAA mode with optimality-gap envelope — P2.9.</li>
              <li>Layered treaty-cost model for cession — P2.7.</li>
              <li>Column generation for cohort-scale portfolio — P3.11 (credibility artifact, not a hot path).</li>
              <li>Pre-registered within-subject user study with cat-ops practitioners — P3.26 (multi-month, IRB-gated).</li>
              <li>Dockerfile + DOI&apos;d Zenodo dataset card — P3.24 / P3.25.</li>
              <li>Post-mortem-driven reconciler-threshold tuning — P3.9.</li>
            </ul>
            <p className="text-[12px] text-zinc-500 mt-4">
              Full matrix in{' '}
              <code className="font-mono text-[11px]">
                docs/superpowers/plans/2026-05-16-forge-redesign.md
              </code>
              .
            </p>
          </section>

          {/* References */}
          <section>
            <SectionHeading
              id="references"
              eyebrow="Bibliography"
              title="References"
            />
            <p className="text-[13px] text-zinc-700 leading-relaxed mb-4">
              Selected citations behind the constants above. The full list
              (with per-peril breakdown for{' '}
              <Link href="/simulate" className="text-emerald-700 hover:text-emerald-900 underline-offset-2 hover:underline decoration-emerald-300">/simulate</Link>{' '}
              calibration anchors) lives in{' '}
              <code className="font-mono text-[12px]">research.md</code>.
            </p>
            <ol className="space-y-2 text-[12.5px] text-zinc-700 leading-relaxed list-decimal pl-5 marker:text-zinc-400">
              <li>
                Citizens Property Insurance Corp.,{' '}
                <em>2023 Annual Statement</em>.{' '}
                <a
                  href="https://www.citizensfla.com/documents/20702/29655847/2023+Annual+Statement.pdf"
                  className="text-emerald-700 hover:underline break-all"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  citizensfla.com
                </a>
              </li>
              <li>
                Florida OIR,{' '}
                <em>Florida Property Insurance Market Update</em> (May 2024).{' '}
                <a
                  href="https://floir.gov/docs-sf/property-casualty-libraries/property-insurance-market-overview/insurance-update-may-2024.pdf"
                  className="text-emerald-700 hover:underline break-all"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  floir.gov
                </a>
              </li>
              <li>
                Florida Hurricane Catastrophe Fund,{' '}
                <em>2024 Aggregate Net PML Report</em>.{' '}
                <a
                  href="https://fhcf.sbafla.com/media/410lkiue/fhcf-2024-pml-report-final.pdf"
                  className="text-emerald-700 hover:underline break-all"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  fhcf.sbafla.com
                </a>
              </li>
              <li>
                A.M. Best,{' '}
                <em>Florida Homeowners Writers — Selected Financial Indicators</em>{' '}
                (2023 ed.).{' '}
                <a
                  href="https://bestsreview.ambest.com/displaychart.aspx?Record_Code=328093"
                  className="text-emerald-700 hover:underline break-all"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  bestsreview.ambest.com
                </a>
              </li>
              <li>
                S&amp;P Global Market Intelligence,{' '}
                <em>US homeowners insurers&apos; net combined ratio surges past 110 %</em>{' '}
                (May 2024).{' '}
                <a
                  href="https://www.spglobal.com/market-intelligence/en/news-insights/articles/2024/5/us-homeowners-insurers-net-combined-ratio-surges-past-110-81711947"
                  className="text-emerald-700 hover:underline break-all"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  spglobal.com
                </a>
              </li>
              <li>
                Artzner, Delbaen, Eber &amp; Heath,{' '}
                <em>&ldquo;Coherent Measures of Risk,&rdquo;</em>{' '}
                Mathematical Finance 1999, 9(3), 203–228.
              </li>
              <li>
                Bertsimas &amp; Tsitsiklis,{' '}
                <em>Introduction to Linear Optimization</em>, Athena
                Scientific (1997) — total unimodularity, Ch. 7.
              </li>
              <li>
                Brooks (2004),{' '}
                <em>On the Relationship of Tornado Path Length and Width to Intensity</em>,{' '}
                Weather and Forecasting 19(2), 310–319.
              </li>
              <li>
                Bakun &amp; Wentworth (1997),{' '}
                <em>Estimating Earthquake Location and Magnitude from Seismic Intensity Data</em>,{' '}
                BSSA 87(6), 1502–1521.
              </li>
            </ol>
          </section>

          <ProvenanceFootnote
            source="docs/methodology.md · research.md (citations)"
            method="JSX-rendered (no markdown runtime); cross-linked to live console routes"
          />
        </article>
      </div>
    </div>
  );
}
