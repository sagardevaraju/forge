# FORGE — OSF Preregistration Form (Paste-Ready Extract)

**Purpose:** This file mirrors `docs/USER_STUDY_PROTOCOL.md` content into
the exact field order of the [OSF Preregistration template](https://help.osf.io/article/158-create-a-preregistration).
When you open the OSF form at https://osf.io/registries/, each `## OSF
Field N — …` heading below maps to one field on the OSF UI. Paste the body
of each section into the matching field and submit.

After submission, paste the returned DOI back into:
- `docs/USER_STUDY_PROTOCOL.md` line 4 (`OSF pre-registration:`)
- `docs/USER_STUDY_PROTOCOL.md` line 186 (`OSF DOI:`)

…then re-commit as `docs(FORGE): P3.26 OSF DOI - <DOI>`.

This extract is verbatim from the source protocol — keep both files in sync
if you edit the protocol before submission. Source-of-truth is the
protocol document; this is a paste-buffer view of it.

---

## OSF Field 1 — Title

A within-subjects study of decision-confidence and task-completion time in
scenario-coupled cat-ops dashboards (FORGE).

---

## OSF Field 2 — Description / Background

(Map to OSF: "Background" or "Study information → Description")

FORGE is a *scenario-coupled* catastrophe-operations console: a single
Monte-Carlo scenario set drives the Portfolio MIP, the Operational LP, and
the claims pre-flagger simultaneously. The hypothesis tested by this study
is that this scenario-coupling materially improves operator **decision
confidence** and **task-completion time** relative to a control condition
in which the three layers use independently-fit scenarios (the conventional
sequential approach).

This study DOES NOT test loss-prediction accuracy, MIP solution quality, or
any other algorithmic property — those are measured by the existing `eval/`
suite. The study measures **operator efficacy on real tasks** using both
conditions.

---

## OSF Field 3 — Hypotheses

(Map to OSF: "Hypotheses")

### H1 (primary, decision confidence)

Operators using the scenario-coupled console (treatment) will report **≥ 1.0
point higher** mean confidence on a 7-point Likert scale per decision than
operators using the independent-scenarios console (control), averaged across
all decisions made during the study session.

### H2 (primary, completion time)

Operators using the scenario-coupled console will complete the four
standardised decision tasks **≥ 25% faster** than operators using the
independent-scenarios console (measured as median seconds-per-task across
the four tasks).

### H3 (secondary, error rate)

Operators using the scenario-coupled console will produce **≥ 30% fewer
"manual reversal required" outcomes** in the post-decision reconciler than
operators using the independent-scenarios console (a proxy for
decision-quality regret).

---

## OSF Field 4 — Study Design

(Map to OSF: "Study design")

**Within-subjects** crossover design. Each participant completes the same
four standardised decision tasks under both conditions. The order is
counterbalanced (half see treatment first; half see control first) using a
randomised block design (Latin-square balanced within each block of 4
participants).

### Conditions

| Condition | Scenarios |
|---|---|
| **Treatment (scenario-coupled)** | All three layers (Portfolio MIP, Operational LP, claims pre-flagger) consume the same Monte-Carlo scenario set produced by `ml/scenarios/generate.py` for a single `storm_id`. This is FORGE's default. |
| **Control (independent scenarios)** | Each layer consumes a freshly-drawn scenario set (different RNG seed per layer). The console UI is otherwise identical. |

The console code base is the same in both conditions; only the backend
scenario-wiring differs (controlled by a single feature flag).

### Tasks (standardised)

All participants perform these four tasks in both conditions:

1. **Portfolio Decision (T1)** — given a fresh threat (a covered hurricane
   forecast cone), choose a portfolio action mix (retain / reprice /
   non-renew / cede QS / cede XS) for ≥ 80% of book TIV. Completion
   criterion: a portfolio MIP solve was committed via
   `/api/optimize/portfolio` and the operator marked it as "Reviewed".
2. **Adjuster Routing (T2)** — given 50 freshly-opened claims after the
   threat materialises, route ≥ 90% to adjusters via the `/operational`
   view's VRP solve.
3. **Sim Drawing (T3)** — draw a custom hail simulation footprint on the
   `/simulate` map, promote it, and verify it lands in the joint TVaR-99
   capital calculation.
4. **Audit Diff (T4)** — open the most recent decision in `/audit`,
   identify the change from the prior decision, and explain it in ≤ 30
   seconds.

### Materials

Each participant is provided with:

- A FORGE instance pre-seeded with the synthetic 10k-policy book
  (`scripts/seed_policy_book.py`).
- A laptop with Chromium and the dev server (`npm run dev`).
- A printed task sheet listing T1–T4 with success criteria.
- A confidence-and-completion-log app on a second device for reporting
  per-decision confidence + start/end timestamps.

---

## OSF Field 5 — Sampling Plan

(Map to OSF: "Sampling plan")

**n = 20** participants (10 treatment-first, 10 control-first per
counterbalancing). Selected by convenience sampling from the FORGE review
group at the time of the study (insurance ops backgrounds — PMs,
underwriters, claims managers); the protocol pre-registration records the
recruitment population.

### Power justification

Within-subjects paired-t comparison. Detecting a 1.0-point shift on a
7-point Likert with SD ≈ 1.5 per condition (a moderate effect, Cohen's d ≈
0.67) at α = 0.05 and power 0.80 requires n ≈ 19 paired participants. n =
20 gives a small safety margin and is the plan-mandated sample size (per
the autonomous handoff charter).

### Stopping rule

n = 20 is fixed at pre-registration; **no early stopping**.

---

## OSF Field 6 — Variables

(Map to OSF: "Variables → Manipulated variables" + "Variables → Measured variables")

### Manipulated (independent) variable

- **Scenario-coupling mode**: 2 levels (treatment = coupled vs. control =
  independent). Set via a single feature flag in the FORGE backend; UI
  identical across conditions.

### Measured (dependent) — Primary

- **Confidence (Likert 1–7)** — per-decision self-report on the question
  "How confident are you that this decision will not need reversal in the
  next 30 days?" averaged per participant per condition.
- **Time (seconds)** — wall-clock seconds per task, averaged across the
  four tasks per participant per condition.

### Measured (dependent) — Secondary

- **Manual-reversal rate** — fraction of decisions flagged by the scenario
  reconciler (`lib/reconciler/index.ts`) as `manual_reversal_required`.
  This is the FORGE-side audit signal for decision-quality regret.
- **NASA-TLX cognitive-load** — administered at the end of each condition
  (six 0-100 sliders).

---

## OSF Field 7 — Analysis Plan

(Map to OSF: "Analysis plan")

- **H1, H2:** paired Wilcoxon signed-rank test (within-subjects,
  Likert-scale + skewed time data). Pre-registered α = 0.05.
- **H3:** McNemar's test on paired manual-reversal counts.
- **Secondary (NASA-TLX):** descriptive statistics + paired comparison; no
  formal pre-registered hypothesis.
- **Order effect check:** 2-way ANOVA with condition + presentation order
  as factors. Report the interaction effect for transparency even when
  non-significant.
- **Outlier exclusion:** none planned; if a participant did not complete a
  task in either condition, that participant is excluded from the
  pairwise comparison for that task (within-subjects with pairwise
  deletion).

---

## OSF Field 8 — Other (Optional)

(Map to OSF: "Other" — ethics, compensation, data-handling)

### Ethics

- **IRB / ethics review:** waiver requested under the *minimal-risk
  software usability study* category (no health data, no decisions
  affecting real underwriting policies, no PII captured beyond participant
  first name + role).
- **Consent:** verbal consent recorded at session start.
- **Compensation:** $50 gift card per session, prorated for early
  withdrawal.
- **Data handling:** per-participant logs retained only as aggregate
  statistics; raw timing + confidence data anonymized at ingest. Storage
  on the same Turso DB as FORGE production data under an
  `study_<participant_id>` schema partition.

### Pre-registration time-stamps

- **Protocol committed:** 2026-05-24
- **OSF DOI:** TBD (this submission)
- **Data-collection start:** TBD (post-DOI)
- **Data-collection end:** TBD (post-DOI + N=20)
- **Analysis lockdown:** at data-collection end

---

## References (for OSF "Related literature" field if asked)

1. Bessen, J. (2019). *AI and Jobs: The role of demand.* NBER WP 24235.
2. Hart, S. G. & Staveland, L. E. (1988). *Development of NASA-TLX (Task
   Load Index)*. North-Holland.
3. Likert, R. (1932). *A Technique for the Measurement of Attitudes.*
   Archives of Psychology 140.
4. OSF Preregistration template: https://help.osf.io/article/158-create-a-preregistration
