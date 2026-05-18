# Cohort key contract

A cohort is identified by `{zip3}_{build_type}_q{N}` where N ∈ {0..4}.

- **zip3** — the first 3 digits of the policy ZIP.
- **build_type** — one of `wood_frame`, `masonry`, `manufactured`.
- **q** — TIV quintile (0..4) computed over the **entire book**, not per-state.
   Ties broken by modal flood zone (lexical order).

This key is a join contract between the TS aggregation (`lib/db/cohorts.ts`)
and the Python reimplementation (`eval/end_to_end.py::build_cohorts`).
Changes must land in both files in the same commit.
