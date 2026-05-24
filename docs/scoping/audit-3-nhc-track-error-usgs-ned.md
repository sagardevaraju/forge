# Scoping — AUDIT.3: Real NHC track-error climatology + USGS NED elevation

**Status:** Scoping doc only — no implementation in this commit.
**Owner:** Sagar Devaraju (subject to availability).
**Estimated effort:** 3–5 working sessions (~12–20 hours active), spread across calibration data fetch + scenario generation rewrite + verification.
**Dependencies:** None. Can run in parallel with any non-scenario work.
**Why this exists:** AUDIT.3 was deferred during Phase 3′ as "too big for cleanup; rescoped as a Phase 3 product feature." This doc breaks it into a sequence of contained PRs so the work can resume when there's a window.

---

## 1. What's broken today

Two hand-coded placeholders in `ml/scenarios/generate.py` violate
`CLAUDE.md` §"Data integrity — every value traces to a real source":

### 1a. `_DEMO_TRACK_FL` (lines 72–94)

A 21-waypoint Cat-4 hurricane track from west of the Florida Keys
recurving NNW into Big Bend FL. Wind speeds, lat/lon, and 6-hour
spacing are hand-tabulated, not derived from any historical storm.

**Used by:** `BASIN_DEMO_TRACKS["us_atlantic"]`, the mock fallback in
`fetch_nhc_cone` agent tool, and as the seed for stochastic track-error
perturbation in `generate_scenarios()`.

**P3.18 closed half the gap** by adding `_DEMO_TRACK_CARIBBEAN` and
`_DEMO_TRACK_ATLANTIC_CANADA` anchored to real storms (Matthew/Maria
shape for Caribbean, Dorian/Fiona shape for Canada). But the
`us_atlantic` track is still a fabricated composite.

### 1b. `_COASTAL_ZIP3S` (lines 176–196)

A 15-ZIP3 lookup table with hand-picked lat/lon centroids and
hand-estimated ground elevations (meters above MSL). Used as the surge
proxy denominator in `_surge_depth()`.

**Issues:**

- **Elevations are eyeballed**, not measured. E.g., Brooksville (346)
  at 8m, Mobile (365) at 3m — these look plausible but trace to no
  ground-truth source.
- **Coverage is sparse** — 15 ZIP3s vs the ~570 cohorts in the actual
  book. Non-coastal book ZIP3s get zero surge contribution, which is
  fine for storm-surge specifically but means the table can't
  generalize as the book expands inland or to new basins.
- **Per-ZIP3 elevation is itself a fiction** — a ZIP3 covers tens to
  hundreds of km²; a single elevation badly underrepresents the
  variation within the ZIP3 (a single value can't simultaneously
  capture both coastal Mobile and the elevated parts of the ZIP3).

---

## 2. Target end state

### 2a. Replace `_DEMO_TRACK_FL` with NHC track-error climatology

Drive scenario generation from:

- **Per-basin storm-track climatologies** that interpolate from real
  HURDAT2 best-track records (already on disk at
  `artifacts/hurdat2/best_track.parquet` — P3.18 brought this in).
- **NHC track-error envelopes** (the official "cone of uncertainty"
  parameters) published annually as the "Average track forecast errors
  for Atlantic basin tropical cyclones." These give per-forecast-hour
  cross-track and along-track standard deviations.
- **NHC intensity-error envelopes** (peak-wind forecast error
  climatology, parallel to the track-error tables).

The output of `generate_scenarios()` should:

1. Take a seed track (real-time NHC advisory in production; HURDAT2
   draw in calibration mode).
2. Perturb each waypoint by a Gaussian draw scaled by the NHC track
   error at that forecast hour.
3. Perturb peak-wind by intensity-error Gaussian at each waypoint.
4. Produce K=1000 scenarios that, in aggregate, reconstruct the NHC
   cone of uncertainty.

The `_DEMO_TRACK_FL` literal would be deleted; the mock fallback in
`fetch_nhc_cone` would either use a HURDAT2-sampled track or keep a
labeled "MOCK_DEMO_TRACK" wrapper that's loudly named as such (no more
"plausible-looking but fabricated" composite).

### 2b. Replace `_COASTAL_ZIP3S` with USGS NED elevation lookups

Drive surge / elevation calculations from:

- **USGS 3DEP / NED 1/3 arc-second** elevation rasters (~10m
  resolution, CONUS coverage). Public domain.
- A precompute script that, for each policy's `(lat, lon)`, samples
  the NED raster and writes per-policy `elevation_m_ned` to the DB.
- The `seed_policy_book.py` script already places lat/lon for every
  policy; this just adds an elevation pass after seeding.

The output:

- `_surge_depth()` calls take a per-policy elevation, not a per-ZIP3
  modal estimate.
- The `_COASTAL_ZIP3S` literal is deleted; any code that needed a
  ZIP3-level elevation can aggregate from the policy table.

---

## 3. Data sources

### NHC track-error climatology

| Source | Format | Where |
|---|---|---|
| NHC "Annual Average Forecast Errors" table | PDF / CSV (parsed) | https://www.nhc.noaa.gov/verification/verify7.shtml |
| NHC "Cone of Uncertainty" parameters | YAML / JSON | https://www.nhc.noaa.gov/aboutcone.shtml |
| HURDAT2 best-track records (already on disk) | parquet | `artifacts/hurdat2/best_track.parquet` |

License: NHC products are US Government works, public domain.

### USGS NED elevation

| Source | Format | Where |
|---|---|---|
| USGS 3DEP 1/3 arc-second National Elevation Dataset | GeoTIFF tiles | https://apps.nationalmap.gov/downloader/ (programmatic via TNM API) |
| Conterminous US 1/3-arcsec composite | ~280 GB raw / ~12 GB compressed | Multiple GeoTIFF tiles per state |

License: USGS data is in the public domain.

**Size consideration:** Full CONUS 1/3-arcsec is too big to commit. The
right pattern:

1. Run an offline `scripts/extract_elevations.py` that walks the
   policy book, fetches just the relevant NED tiles, samples elevations
   at each `(lat, lon)`, and writes back to `policies.elevation_m_ned`.
2. Commit only the resulting per-policy elevation column (already a
   column in the schema — just populated with real data instead of
   the synthetic Gaussian from `seed_policy_book.py`).
3. The NED tiles themselves stay out of the repo (add to .gitignore).

---

## 4. Phased implementation plan

### Phase 1 — NHC error climatology fetch + parse (~3 hours)

**Output:** `artifacts/nhc/track_error.json` + `artifacts/nhc/intensity_error.json` (committed).

Tasks:
- Fetch the latest NHC verification PDF/CSV
- Parse into a per-forecast-hour table: `{hours_ahead: {cross_track_sigma_nm, along_track_sigma_nm, peak_wind_sigma_kt}}`
- Commit the parsed JSON + the SHA-256 of the source PDF for reproducibility audits
- New tests: parse covers forecast hours 12-120; values match published NHC numbers within rounding tolerance

### Phase 2 — Refactor `generate_scenarios()` to use the climatology (~4 hours)

**Output:** New scenario generator path; `_DEMO_TRACK_FL` literal removed.

Tasks:
- Replace the hard-coded perturbation parameters in `generate_scenarios()` with lookups from the NHC error JSON
- Add a `seed_track` parameter that defaults to a HURDAT2 sample (per-basin) rather than `_DEMO_TRACK_FL`
- Update `BASIN_DEMO_TRACKS` to be a function `sample_basin_seed_track(basin)` that draws from HURDAT2
- Mock fallback in `fetch_nhc_cone` renamed `MOCK_BASIN_TRACK_*` with explicit labeling
- Tests for: scenario set reconstructs NHC cone widths within 10% at hours 24/48/72/96/120; deterministic for a given (basin, seed_storm_id)

### Phase 3 — USGS NED fetch script (~5 hours)

**Output:** `scripts/extract_elevations.py` + populated `policies.elevation_m_ned` column.

Tasks:
- Identify the unique NED tiles needed (lookup by lat/lon bbox per policy)
- Use the TNM API to download just those tiles to a gitignored cache
- Sample elevations at each policy's (lat, lon)
- UPDATE the policies table with the real elevation
- Update `seed_policy_book.py` to leave `elevation_m_ned` NULL on initial seed (the script populates it post-seed, similar to how `cv_features` works via `populate_cv_features.py`)
- Tests for: elevation values are physically plausible (-100m to 5000m CONUS); FL coastal ZIP3s land in 0-10m range; ID/CO/MT inland ZIP3s land in 1000m+

### Phase 4 — Remove `_COASTAL_ZIP3S`; rewire `_surge_depth()` (~3 hours)

**Output:** Policy-level surge computation.

Tasks:
- Refactor `_surge_depth()` to take `policy_elevation_m` instead of looking up `_COASTAL_ZIP3S[zip3]`
- Move ZIP3-level aggregation (if still needed for the UI) to a precompute artifact, derived from the policy table
- Delete `_COASTAL_ZIP3S` and `_COASTAL_LAT_LON` literals
- Update consumer tests

### Phase 5 — Verification + DOI release (~2 hours)

**Output:** Multi-peril TVaR-99 re-runs cleanly with real elevation + real cone; v0.2.0 Zenodo release.

Tasks:
- Re-run `python -m scripts.precompute_portfolio_optimization`
- Compare retained TVaR-99 before/after — expected: small change (a few %), since the FL-coast book is small and the hand-coded numbers were roughly right by eyeball
- Tag `v0.2.0`, GitHub Release → Zenodo auto-mints new version DOI
- Update dataset card (release history block + version-DOI line)

---

## 5. Verification criteria

The work is done when:

1. **No hand-coded waypoints or elevations remain** in `ml/scenarios/generate.py`. Every coordinate traces to NHC, HURDAT2, or USGS via a committed script + artifact.
2. **`grep -n "_DEMO_TRACK_FL\|_COASTAL_ZIP3S" ml/scenarios/generate.py`** returns nothing.
3. **The reconstructed cone of uncertainty** for a 5-day forecast matches the published NHC cone width within ~10% at hours 24/48/72/96/120.
4. **Per-policy elevations** distribute realistically: coastal FL median in 0-10m; inland TX median in 100-500m; mountain-west states (if seeded) in 1000m+.
5. **All existing tests still pass** + new tests for each phase + the joint multi-peril TVaR-99 artifact regenerates cleanly under the new elevation data.

---

## 6. Open questions

1. **NHC verification table format.** They sometimes publish as PDF only, sometimes as XLSX. Need to confirm a parse path that's stable year-over-year. Worst case: hand-transcribe the table once and commit a JSON.
2. **TNM API rate limits.** USGS may throttle the tile-download script. May need to use a CDN mirror (e.g., the OpenTopography mirror) or a different elevation source (Mapzen Terrain, but that's deprecated; Cesium ion is licensed). Public-domain alternatives: NASA SRTM (30m, lower resolution but global); USGS Earth Explorer bulk downloads (manual but most reliable).
3. **Inland ZIP3s in the FORGE book** are currently treated as zero-surge. Is that correct? For a hurricane policy book, yes — but expansion to multi-peril TVaR-99 (already shipped in Phase 4) means inland flood / inland-extension storm surge should be addressed at some point. Out of scope for AUDIT.3; track as a separate follow-up.
4. **Compatibility with promoted-sim path.** The /simulate UI lets operators draw custom hurricane footprints. Those use the same `_surge_depth()` codepath. Need to verify that after Phase 4 the simulate flow still works against per-policy elevations.

---

## 7. Risks

- **Calibration churn.** Changing the cone-of-uncertainty math might shift the joint multi-peril TVaR-99 by a non-trivial amount, which would invalidate the artifact and require a new MIP solve. Acceptable — but the v0.2.0 Zenodo release notes should be explicit about the calibration improvement.
- **TNM API instability.** USGS has changed their data delivery system multiple times. If the script breaks in 6 months, the elevation fetch needs an alternate path. Mitigation: cache the tiles + per-policy elevations in `artifacts/` so re-runs don't depend on the live API.
- **NHC verification table format drift.** Annual reports may format differently. Mitigation: vendor the latest table as JSON; update once a year by hand if needed.

---

## 8. References

- NHC cone of uncertainty methodology — https://www.nhc.noaa.gov/aboutcone.shtml
- NHC annual verification report — https://www.nhc.noaa.gov/verification/verify7.shtml
- USGS 3DEP National Elevation Dataset — https://www.usgs.gov/3d-elevation-program
- USGS TNM (The National Map) API docs — https://apps.nationalmap.gov/tnmaccess/
- Forecast error climatology methodology (DeMaria + Mainelli 2013, *Weather and Forecasting* 28) — https://doi.org/10.1175/WAF-D-12-00098.1
- HURDAT2 documentation — https://www.nhc.noaa.gov/data/hurdat/
- `memory/forge-phase-roadmap.md` — AUDIT.3 deferred-cleanup context
- `memory/autonomous-run-2026-05-24.md` — section on "What was NOT shipped (deferred)"

---

## 9. Why this isn't shipping today

Per session-level decision: "AUDIT.3 is multi-session feature work; not appropriate for a single push." This doc exists so when the work resumes, the next session has:

- A complete decomposition into PR-sized chunks
- Data sources identified up-front (no research-as-you-go)
- Success criteria written down
- The risks and open questions surfaced before keystroke #1

When work begins, the right starting point is **Phase 1** (NHC error
fetch + parse) — it's contained, has no dependencies on the rest, and
its output (the committed climatology JSON) is the foundation for
Phase 2.
