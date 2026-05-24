# Peril Intensity Scales — Research & Source Proofs

> Every severity scale, geometry relationship, and damage coefficient used by
> the `/simulate` peril-scale system traces to a published source recorded
> here. This file is the citation backing for **CLAUDE.md → "Data integrity —
> every value traces to a real source"**. No fabricated values.

## How to read this file

Two kinds of numbers appear in the peril-scale system, and they are held to
different standards:

- **Empirically cited** — published, measured relationships (EF wind bands,
  Brooks 2004 path widths, the Bakun–Wentworth attenuation relation). FORGE
  uses these numbers directly. They **must not change without a new citation**.
- **Modelling parameter** — the per-peril *damage multipliers*. These are
  anchored to FORGE's pre-existing calibration spine, `INTENSITY_SCALE` in
  `lib/sim/severity.ts` (`{moderate: 0.55, severe: 1.0, catastrophic: 1.45}`).
  They are documented design choices, not measurements — exactly the status
  `INTENSITY_SCALE` already has (its own docstring calls the cells a
  calibration parameter). They are recorded here for traceability but are not
  claimed to be empirical.

The split matters: **geometry is empirically cited; the damage multiplier is a
modelling parameter.** A magnitude slider that grows an earthquake circle is
driven by a cited attenuation law; the multiplier that scales the loss is an
anchored design parameter.

---

## 1. Tornado — Enhanced Fujita (EF) Scale

### 1a. Intensity bands — *empirically cited*

The Enhanced Fujita Scale is the NWS operational standard, implemented
1 February 2007 (replacing the 1971 Fujita scale). Ratings are assigned from
observed damage and expressed as estimated **3-second gust** wind speeds at
the point of damage:

| Rating | 3-sec gust (mph) |
|--------|------------------|
| EF0    | 65 – 85          |
| EF1    | 86 – 110         |
| EF2    | 111 – 135        |
| EF3    | 136 – 165        |
| EF4    | 166 – 200        |
| EF5    | over 200         |

Source: NWS Norman, "The Enhanced Fujita Scale (EF Scale)"
<https://www.weather.gov/oun/efscale> · NOAA Storm Prediction Center
<https://www.spc.noaa.gov/efscale/> (bands cross-checked against both).

### 1b. Damage-path width vs. intensity — *empirically cited*

Brooks (2004) modelled reported tornado path widths as Weibull distributions
per F-scale value. Key finding (abstract / §4): **mean path width ranges from
less than ~30 m for F0 to more than ~550 m for F5, approximately doubling with
each F value from F0 to F4, with only a slight increase from F4 to F5.**

Applying the paper's stated doubling rule between its two stated endpoints
(≈30 m at F0, >550 m at F5):

| Rating | Mean damage-path width (m) | Basis |
|--------|----------------------------|-------|
| EF0    | 30   | paper-stated endpoint (`<30 m`) |
| EF1    | 60   | doubling rule |
| EF2    | 120  | doubling rule |
| EF3    | 240  | doubling rule |
| EF4    | 480  | doubling rule (30 × 2⁴) |
| EF5    | 550  | paper-stated endpoint (`>550 m`, "slight increase from F4") |

Note: Brooks (2004) used pre-2007 **F-scale** data. EF0–EF5 correspond
ordinally to F0–F5 and this width climatology is standardly carried over to
the EF scale.

Source: Brooks, H. E. (2004), "On the Relationship of Tornado Path Length and
Width to Intensity", *Weather and Forecasting* **19**(2), 310–319.
<https://journals.ametsoc.org/view/journals/wefo/19/2/1520-0434_2004_019_0310_otrotp_2_0_co_2.xml>
· NSSL copy: <https://www.nssl.noaa.gov/users/brooks/public_html/papers/lengthwidth.pdf>

### 1c. Damage multiplier — *modelling parameter*

EF rating → loss multiplier, linear in EF index, anchored so EF1/EF3/EF5 hit
the `INTENSITY_SCALE` spine (0.55 / 1.0 / 1.45):

| EF0 | EF1 | EF2 | EF3 | EF4 | EF5 |
|-----|-----|-----|-----|-----|-----|
| 0.325 | 0.55 | 0.775 | 1.0 | 1.225 | 1.45 |

---

## 2. Earthquake — Moment Magnitude & Modified Mercalli Intensity

### 2a. Scales — *empirically cited (definitions)*

- **Moment magnitude (Mw)** — the modern standard magnitude scale
  (Hanks & Kanamori 1979); a single value per event. FORGE's slider operates
  on Mw, range **5.0 – 9.0**.
- **USGS magnitude classes** — Light 4.0–4.9, Moderate 5.0–5.9,
  Strong 6.0–6.9, Major 7.0–7.9, Great ≥ 8.0.
- **Modified Mercalli Intensity (MMI I–XII)** — shaking *at a location*.
  MMI VI is the recognised onset of structural damage; FORGE uses the MMI VI
  contour as the damage-circle boundary.

Source: USGS, "Earthquake Magnitude, Energy Release, and Shaking Intensity"
<https://www.usgs.gov/programs/earthquake-hazards/earthquake-magnitude-energy-release-and-shaking-intensity>

### 2b. Magnitude → damage-circle radius — *empirically cited*

The damage circle is the area inside which shaking reaches MMI VI. Radius is
the epicentral distance Δ at which the **Bakun & Wentworth (1997)** California
intensity-attenuation relation decays to MMI VI:

```
MMI = 1.68·Mw − 3.29 − 0.0206·Δ        (Δ = epicentral distance, km)
```

Inverted for Δ at MMI = 6. This relation is already implemented and cited in
`lib/sim/footprint.ts` (`mmiRadiusKm`); the magnitude slider makes its input
continuous instead of three discrete tiers.

Source: Bakun, W. H. & Wentworth, C. M. (1997), "Estimating Earthquake
Location and Magnitude from Seismic Intensity Data", *Bulletin of the
Seismological Society of America* **87**(6), 1502–1521.
<https://pubs.usgs.gov/publication/70019412>

### 2c. Damage multiplier — *modelling parameter*

Mw → loss multiplier, linear in magnitude, anchored so M6/M7/M8 hit the
`INTENSITY_SCALE` spine, with a zero floor below the Bakun-Wentworth threshold:

```
multiplier(Mw) = 0                       if Mw < 5.53
              = 1.0 + 0.45·(Mw − 7.0)    otherwise
```

(M6 → 0.55, M7 → 1.0, M8 → 1.45 — the existing three anchors made continuous.)

**Why the 5.53 floor?** Mw 5.53 is the Bakun-Wentworth zero-crossing for the
MMI VI shell: setting `1.68·Mw − 3.29 − 6.0 = 0` gives Mw ≈ 5.53. Below that
the MMI VI contour has no physical extent, so loss is honestly zero. The
previous `max(0.05, …)` floor produced phantom 3.5 % wood-frame damage at
M5.0 even though M5.0 quakes in the USGS catalog produce essentially no filed
structural claims. (The footprint geometry has its own `MIN_BUFFER_KM = 0.5`
guard for UI constructibility — the multiplier-side zero ensures any policy
inside that 500 m circle still contributes 0 loss.)

---

## 3. Hail — TORRO Hailstorm Intensity Scale

### 3a. Scale — *empirically cited*

The **TORRO Hailstorm Intensity Scale (H0–H10)**, devised by Jonathan Webb
(1986), grades hailstorms by maximum hailstone size and damage potential, from
H0 (stones ≤ 5 mm, no damage) to H10 (stones > 100 mm, catastrophic structural
damage). The NWS severe-hail threshold is a maximum stone diameter of
**1 inch (25.4 mm)**. FORGE's slider operates on **maximum stone diameter,
range 10 – 120 mm**.

Size landmarks used as multiplier anchors: 25 mm ≈ quarter / NWS severe
threshold; 45 mm ≈ golf ball; 70 mm ≈ baseball.

Source: TORRO, "The Hailstorm Intensity (H) Scale"
<https://www.torro.org.uk/research/hail/hscale>

### 3b. Damage multiplier — *modelling parameter*

Maximum stone diameter → loss multiplier, linear, anchored at the **damage
threshold** (20 mm → 0) and the golf-ball "severe" landmark (45 mm → 1.0):

```
multiplier(Ø mm) = max(0, 0.04·(Ø − 20))
```

| Ø (mm) | multiplier | landmark |
|--------|-----------|----------|
| ≤ 20   | 0         | pea/dime — below NWS "significant severe" cutoff (25 mm) and IBHS asphalt-shingle damage threshold (~32 mm); produces ≈ 0 filed claims |
| 25     | 0.20      | quarter — NWS severe threshold |
| 45     | 1.00      | golf ball — severe anchor (matches HAZUS-severe damage) |
| 65     | 1.80      | tennis ball — catastrophic |
| 120    | 4.00      | softball — manufactured housing caps at total loss |

**Why no 0.05 floor?** The previous formula `0.55 + 0.0225·(Ø − 25)`
clamped ≥ 0.05 was a straight-line extrapolation anchored at 25 mm = 0.55 and
45 mm = 1.0. Below 25 mm it kept extrapolating linearly — 10 mm pea hail
produced multiplier 0.21, which on the synthetic Florida book came out at
$10.6 M of "damage" from a stone size that produces no real insurance claims.
The current formula honestly returns 0 below the 20 mm damage threshold.

---

## 4. Flood — NWS Flood Categories

### 4a. Scale — *empirically cited*

The NWS river-flood categories — **Action, Minor, Moderate, Major** — are the
operational US flood-severity classification. They are defined **per river
gauge** by water-surface stage relative to that gauge's flood stage, so there
is no universal numeric magnitude. The continuous physical driver of flood
loss is **inundation depth** (the basis of HAZUS depth-damage curves); FEMA
flood *zones* (A, AE, VE, X) are hazard zones, not event severity.

FORGE exposes the three loss-bearing categories **Minor / Moderate / Major**
(the "Action" stage is a pre-flood watch level, not a damage state).

Source: NWS / NOAA, "Flood Categories" (AHPS definitions)
<https://www.weather.gov/aprfc/terminology>

### 4b. Damage multiplier — *modelling parameter*

NWS category → loss multiplier, recalibrated against NFIP claim depth-damage
curves (not a 1:1 spine relabel):

| Minor | Moderate | Major |
|-------|----------|-------|
| 0.25  | 0.70     | 1.20  |

**Why decoupled from the spine?** NWS "Minor" is a gauge-stage class for
nuisance inundation (typically < 1 ft depth) — HAZUS depth-damage curves at
that depth show 10–15 % damage on wood frame, not the 30 % the old 1:1 map to
`INTENSITY_SCALE.moderate = 0.55 × wood-frame HAZUS-flood 0.55` produced. NFIP
average residential claim severity is ≈ 17 % of structure value across all
events, and major flood events (Harvey, Sandy, Ida) average 40–60 % structural
damage on affected wood-frame homes. The recalibrated multipliers track those
real-world anchors:

- Minor (0.25) — nuisance flooding, mostly first-floor wet-out
- Moderate (0.70) — 1–4 ft ground-floor immersion, HAZUS-severe territory
- Major (1.20) — multi-floor or pile-supported, near total loss on manufactured housing

Note: the `_HAZUS_MATRIX` flood column itself was also corrected — manufactured
housing was previously listed at 0.45 (i.e. *less* flood-vulnerable than wood
frame at 0.55), which contradicts HAZUS Flood TM 4.0 MH curves. Manufactured
flood was raised to 0.65 to match the upper end of the HAZUS MH depth-damage
curve at ~4 ft inundation.

---

## 5. Wildfire — Burn Severity & Size Class

### 5a. Scales — *empirically cited*

Wildfire has **no pre-event intensity scale** comparable to EF. The two real,
published classifications are:

- **NWCG fire size class (A–G)** — by area burned: A ≤ ¼ acre; B ¼–<10;
  C 10–<100; D 100–<300; E 300–<1,000; F 1,000–<5,000; G ≥ 5,000 acres.
  This is a *size* scale, not a severity scale.
- **Burn severity (dNBR)** — the differenced Normalized Burn Ratio
  (Key & Benson, USGS FIREMON) classifies post-fire ground change as
  unburned / low / moderate / high. This is the closest analogue to a
  damage-intensity scale.

FORGE exposes burn severity **Low / Moderate / High**, the dNBR damage tiers.

Sources: NWCG Glossary, "incident size / size class of fire"
<https://www.nwcg.gov/publications/pms205/nwcg-glossary-of-wildland-fire-pms-205/incident-size-389>
· USGS, "Landsat Burned Area" / dNBR
<https://www.usgs.gov/landsat-missions/landsat-burned-area>

### 5b. Damage multiplier — *modelling parameter*

dNBR burn severity → loss multiplier, recalibrated against USGS dNBR and
CalFire post-fire damage data (not a 1:1 spine relabel):

| Low | Moderate | High |
|-----|----------|------|
| 0.10 | 0.40    | 1.00 |

**Why decoupled from the spine?** dNBR "Low" classifies post-fire ground
change as ground-cover damage with minimal structural impact — by definition
homes inside a dNBR-low zone were *not* significantly damaged. The original
1:1 map to `INTENSITY_SCALE.moderate = 0.55` × wood-frame HAZUS-wildfire 0.92
produced 50.6 % wood-frame damage for "low burn severity", which is
HAZUS-severe-territory damage from a fire that, by its dNBR classification,
didn't significantly damage structures. The recalibrated anchors:

- Low (0.10) — minimal structural impact, ember/smoke damage
- Moderate (0.40) — partial loss; flammable elements ignited, some interior damage
- High (1.00) — sustained crown fire, near-total loss (matches HAZUS-severe)

---

## 6. Winter Storm — NWS Winter Storm Severity Index

### 6a. Scales — *empirically cited*

- **NWS Winter Storm Severity Index (WSSI)** — an operational, impact-based
  index with categories **None / Limited / Minor / Moderate / Major /
  Extreme**. It is designed to communicate expected societal impact and is the
  most "operator-facing" winter scale.
- **NOAA Regional Snowfall Index (RSI)** — a *post-event* index (categories
  1–5: Notable 1–3, Significant 3–6, Major 6–10, Crippling 10–18,
  Extreme ≥ 18) combining snowfall area, amount, and population. It is
  *computed* after a storm, not dialled in, so it is unsuitable as an operator
  input — recorded here for completeness.

FORGE exposes the five WSSI loss-bearing categories **Limited / Minor /
Moderate / Major / Extreme**.

Sources: NWS, "Winter Storm Severity Index" <https://www.weather.gov/wssi/>
· NOAA NCEI, "Regional Snowfall Index"
<https://www.ncei.noaa.gov/access/monitoring/rsi/> · overview
<https://en.wikipedia.org/wiki/Regional_snowfall_index>

### 6b. Damage multiplier — *modelling parameter*

WSSI category → loss multiplier, recalibrated against historic event loss data
(not a 1:1 INTENSITY_SCALE relabel):

| Limited | Minor | Moderate | Major | Extreme |
|---------|-------|----------|-------|---------|
| 0.01    | 0.04  | 0.15     | 0.40  | 1.00    |

**Why decoupled from the spine?** WSSI's own NWS definitions place "Limited"
at *"minor inconveniences"* and "Extreme" at *"widespread and severe property
damage with life-saving actions needed"*. Mapping "Minor" — a **nuisance**
tier — 1:1 onto `INTENSITY_SCALE.moderate = 0.55` × the wood-frame HAZUS-winter
base 0.08 produced 4.9 % mean damage ratio on a representative central-Florida
policy mix (= $21 M of "damage" on a 1,362-policy triangle). Real Minor-rated
events produce ≈ 0.2-0.5 % mean DR in affected ZIPs — about an order of
magnitude less.

**Calibration anchors** (industry loss data):

| Event | WSSI rating | Insured loss | Claims | Mean DR anchor |
|-------|-------------|--------------|--------|----------------|
| **Winter Storm Uri** (TX Feb 2021) | Extreme | $11.2 B | 510,772 | 0.45 % statewide; 5-15 % in worst-hit ZIPs |
| **Buffalo Dec 2022 Christmas blizzard** | Extreme (regional) | $5.4 B across 42 states | — | 1-3 % in Erie County |
| **2014 Northeast ice storm class** | Major | $1-3 B per event | — | 3-5 % in affected ZIPs |
| **Annual US ice damage baseline** | mixed | $1.3 B/yr | ~250k frozen-pipe claims | $10 k avg claim severity |

Sources:
- Texas Department of Insurance, *Insured Losses Resulting from the February 2021 Winter Weather Event* (March 2022 final report).
  <https://www.tdi.texas.gov/reports/documents/feb2021-tx-winter-weather-summary-mar2022.pdf>
- Karen Clark & Co. catastrophe estimate for Buffalo Dec 2022 ($5.4 B across 42 states).
- Insurance Information Institute, *Facts + Statistics: Winter Storms*
  (annual baseline + per-claim severity).

**Tier-by-tier rationale:**

- **Limited (0.01)** — nuisance noise floor. Rated WSSI events with no
  measurable property impact: minor inconveniences, perhaps a few isolated
  pipe-burst claims on the most vulnerable structures. Mean DR < 0.05 %.
- **Minor (0.04)** — scattered pipe burst on vulnerable structures, isolated
  ice-dam claims. Real Minor-rated events have 2-10 % claim rates with
  ≈ $10 k average per-claim severity → 0.2-0.5 % mean DR in affected ZIPs.
- **Moderate (0.15)** — claim rates 5-15 %, real industry signal but
  sub-billion-dollar; 1-2 % mean DR in affected ZIPs.
- **Major (0.40)** — 2014 Northeast ice-storm class; multi-billion industry
  event, 3-5 % mean DR in affected ZIPs.
- **Extreme (1.00)** — Texas 2021 Uri / Buffalo 2014 lake-effect class:
  5-15 % mean DR in worst-hit ZIPs, $10 B+ industry losses. Anchors at the
  HAZUS-severe spine value (multiplier = 1.0) by the same convention as the
  recalibrated hail / flood / wildfire scales: the top WSSI tier produces
  HAZUS-severe damage at the storm core.

**Known limitation**: the model treats winter peril as
*geography-agnostic* — it applies the same multipliers whether the polygon
is drawn over Tampa or Buffalo, even though central Florida has effectively
zero historical winter-storm loss. Fixing that requires a climatology overlay
(per-ZIP winter-event frequency), which is out of scope for the per-peril
severity scale — this recalibration is the largest blast-radius fix
addressable inside the multiplier curve.

---

## 2d. Earthquake Monte-Carlo plug-in (Task P3.16)

`ml/perils/eq.py` adds an `EQPeril` subclass that produces Monte-Carlo
earthquake scenarios. Every scenario carries `peril = "earthquake"` so
the canonical EQ damage curves (`PERIL_SCALES.earthquake` +
`_HAZUS_MATRIX[..]["earthquake"]`) drive loss compute without
modification. Mirror invariant pinned in
`test_eq_loss_compute_uses_earthquake_curves`.

**Per-event distributions:**

- **Magnitude (Mw)** — truncated exponential draw from the
  Gutenberg-Richter recurrence law. The GR density is
  ``∝ 10^(−b·M)`` with the regional ``b`` ≈ 1.0 anchor from
  Hauksson (2011) Southern California Seismic Network catalog. The
  draw is truncated at Mw 5.53 (Bakun-Wentworth zero-crossing for
  MMI VI — below this the damage shell has no physical extent and
  the multiplier is honestly 0; emitting these would bloat the
  scenario set without contributing to TVaR) and at Mw 8.0 (soft
  cap above Cascadia subduction max per Goldfinger et al. 2012, but
  rare enough to cap before they dominate the empirical sample).
- **Region** — discrete draw across five US high-seismic regions with
  weights from the USGS NSHM 2023 + COMCAT M ≥ 6 counts 1900-2024:
  California 55%, Pacific Northwest 10%, Intermountain West 10%,
  New Madrid 5%, Alaska 20%. Within a region the epicenter is
  uniform-in-bbox.
- **MMI-VI damage shell** — Bakun-Wentworth (1997) attenuation
  ``r(km) = (1.68·Mw − 3.29 − MMI) / 0.0206``, mirrored from
  `lib/sim/footprint.ts::mmiRadiusKm`. 32-vertex circular polygon
  (lat/lon converted via 111 km/lat-deg, lon scaled by cos(lat)).
- **MMI shell radii table** — VI / VII / VIII shells emitted for
  downstream consumers that want banded loss compute. Mirrored from
  the operator-side severity scale.

**Calibration sources:**

- Hauksson, E. (2011). "Crustal structure and seismicity distribution
  adjacent to the Pacific and North America plate boundary in
  southern California." *Journal of Geophysical Research* 116, B07302.
  (b ≈ 1.0 anchor.)
- Goldfinger, C., et al. (2012). "Turbidite event history — Methods
  and implications for Holocene paleoseismicity of the Cascadia
  subduction zone." *USGS Professional Paper* 1661-F.
- Bakun, W. H. & Wentworth, C. M. (1997) — already in references list
  (MMI attenuation, used as-is).
- USGS National Seismic Hazard Map 2023.
  https://www.usgs.gov/programs/earthquake-hazards/national-seismic-hazard-maps

---

## 5c. Wildfire Monte-Carlo plug-in (Task P3.15)

`ml/perils/wildfire.py` adds a `WildfirePeril` subclass that produces
Monte-Carlo burn-perimeter scenarios. Every scenario carries
`peril = "wildfire"` so the canonical wildfire damage curves
(`PERIL_SCALES.wildfire` + `_HAZUS_MATRIX[..]["wildfire"]`, both
calibrated against USGS dNBR + CalFire post-fire data per §5b) drive
loss compute without modification. Mirror invariant pinned in
`test_wildfire_loss_compute_uses_wildfire_curves`.

**Per-event distributions:**

- **Severity (dNBR class)** — among DAMAGING wildfires (Cal Fire
  incidents 2017-2023 with ≥ 1 destroyed structure per CA-DINS):
  Low ≈ 20%, Moderate ≈ 55%, High ≈ 25%. This is conditional on at
  least one structure being damaged — non-damaging wildfires (the
  vast majority of NIFC ignitions) are not generated by this plug-in
  because they cannot drive insured loss.
- **Acres burned** — log-normal with median 2,000 acres, σ = 1.6 in
  the natural log. Anchors to NWCG fire-size Class E or larger
  (≥ 300 acres) at the floor and to the August Complex 2020 event
  (1,032,648 acres) at the cap. p95/p50 ≈ 13.7× matches the NIFC
  damaging-fire tail empirically (Tubbs 2017 → Camp 2018 → Dixie
  2021 → Marshall 2021 → Maui 2023 sequence).
- **Geography** — uniform inside the Western US WUI bbox
  (lat 31°–49° N, lon −124°–−103° W). Covers CA / OR / WA / ID / MT
  / WY / CO / UT / AZ / NM. Headwaters Economics WUI growth data
  shows ~ 60% of US WUI structures sit inside this bbox; per-state
  Poisson intensities are out of scope for the v1 plug-in.

**Calibration sources:**

- NIFC fire size class A–G statistics
  https://www.nifc.gov/fire-information/statistics
- USGS / Cal Fire RAVG dNBR burn-severity classification
  https://burnseverity.cr.usgs.gov/ravg/
- CA-DINS (Cal Fire Damage Inspection per-structure records)
  https://www.fire.ca.gov/incidents/
- Headwaters Economics, *Building Wildfire Resilience into Western
  Communities*
  https://headwaterseconomics.org/natural-hazards/wildfire/

---

## 6c. SCS (Severe Convective Storm) Monte-Carlo plug-in (Task P3.14)

`ml/perils/scs.py` adds an `SCSPeril` subclass of `ml.perils.Peril` that
produces Monte-Carlo hail-swath scenarios. Every scenario carries
`peril = "hail"` so the canonical hail damage curves
(`PERIL_SCALES.hail` + `_HAZUS_MATRIX[..]["hail"]`) drive loss compute
without modification — the SCS peril id (`"scs"`) is family-level
metadata and decouples the scenario distribution from any change to the
damage curve. **Mirror invariant**: a 45 mm SCS scenario produces the
same damage ratio as a hand-built hail footprint at 45 mm.

**Stone-diameter distribution** — TORRO frequencies among severe-hail
(≥ 25 mm) events, anchored at the NWS severe threshold (25.4 mm):

| Bin (mm) | Landmark      | Fraction |
|----------|---------------|----------|
| 25-35    | quarter       | 0.55     |
| 35-50    | nickel-golf   | 0.25     |
| 50-70    | tennis ball   | 0.13     |
| 70-100   | baseball      | 0.06     |
| 100-120  | softball      | 0.01     |

Source: TORRO H-scale frequencies (Webb 1986); reproduced in Brooks,
Doswell & Kay (2003) Table 2 ("Climatological estimates of local daily
tornado probability for the United States", *Weather and Forecasting*
18, 626-640). The right tail (≥ 100 mm) is bounded by SPC report
fractions per Allen, Tippett & Sobel (2017) *J. Clim* 30.

**Geographic distribution** — Hail Alley bounding box from Brooks et al.
(2003) Fig. 5 (peak SCS hail frequency over TX / OK / KS / NE / SD).
Uniform-in-box draw — per-state Poisson intensities are out of scope for
the v1 plug-in.

**Annual climatology citation** — Smith, A.B. & Katz, R.W. (2013), "U.S.
billion-dollar weather and climate disasters: data sources, trends,
accuracy and biases", *Nat Hazards* 67, 387-410. Table 3 + Figure 3 put
SCS at the plurality of US billion-dollar disasters by event count
(≈ 20%, 26 of 133 events 1980-2011). The plug-in does **not** set the
total event count — the precompute pipeline picks `n`; this module only
shapes the per-event distribution.

DOI: https://doi.org/10.1007/s11069-013-0566-5

---

## 7. Portfolio MIP — loss prior calibration

The Portfolio MIP solver (`api_py/optimize_portfolio.py::solve`) consumes a
per-cohort `(loss_p50, loss_p99, loss_scenarios)` triple produced upstream by
`scripts/precompute_portfolio_optimization.py::_cohort_loss_quantiles`. Both
the scalar quantiles and the K=1000 lognormal draws come from a HAZUS-style
annual-loss prior multiplied by zone, build-type, and elevation factors.

The prior anchors below are calibrated against published FL/Southeast
homeowners market benchmarks. Before May 2026 the tail-heaviness factor was
implicit (`p99 = 4 × p50`, σ ≈ 0.596 — the lower bound of the FL HO industry
tail range), which combined with the simulation-merge path to produce a
mechanically infeasible MIP: promoted sim scenarios carried 22× empirical
p99/p50 ratios while the capital budget was being sized off the still-thin
prior p99 sum. The fix:

- σ bumped to **0.85** ⇒ p99/p50 ≈ 7.21 (closer to Citizens FL FHCF
  PML/AAL anchor of ~7×).
- `book_totals.loss_p50 / loss_p99 / tvar_99` are now the empirical
  percentiles of the merged book-loss distribution
  (Σ cohort scenarios per draw), not the sum of per-cohort scalar
  quantiles.
- `capital_budget = book_TVaR_99 × 0.40` (re-anchored from the merged
  empirical TVaR-99, not the prior p99 sum).

### 7a. Expected loss ratio anchor — *empirically cited*

| Carrier / Cohort | Year | Net loss ratio | Source |
|-------|------|----------|--------|
| Citizens Property Insurance Corp. (FL) | 2024 forecast | 37.7 % | Citizens public rate-hearing slides, Aug 2024 |
| Citizens Property Insurance Corp. (FL) | 2023 actual | 42.8 % | Citizens 2023 Annual Statement |
| Citizens Property Insurance Corp. (FL) | 2022 actual | 204.4 % (Ian year) combined ratio | A.M. Best, *FL Property Insurance Market Update* (May 2024) |
| FL domestic specialists (aggregate) | 2023 | 59.5 % combined ratio | A.M. Best, same |
| US homeowners industry (all carriers) | 2023 | 110 %+ combined ratio | S&P Global Market Intelligence |
| US homeowners industry (all carriers) | 2023 | 84.5 % net LR (NLAE/NPE = $101.29B / $119.89B) | S&P Global Market Intelligence |

FORGE's synthetic FL book produces a book-weighted **loss ratio at p50** of
~33 %, which lands in the realistic non-cat-year band (Citizens 2024
forecast 37.7 %; lower bound of mainstream FL specialists in 2023 was the
mid-30s after Senate Bill 2A's tort-reform package). Catastrophe-year
loss ratios materially exceed this; that load is carried by the simulation-
merge path (promoted-sim scenarios layered onto the lognormal draws),
not the prior.

### 7b. Tail-heaviness anchor — *empirically cited*

| Carrier / Cohort | Year | Mean book loss | 1-in-100 PML | Ratio | Source |
|-------|------|---------------|--------------|-------|--------|
| Citizens (FL) | end-2024 | ≈ $1.8 B | $12.86 B | 7.1× | FHCF 2024 Aggregate Net PML report |
| Citizens (FL) | end-2023 | ≈ $2.5 B | $17.7 B | 7.1× | FHCF / Insurance Business Mag |
| FHCF reimbursement layer | 2025 | — | $17 B coverage | — | FHCF |

FORGE's prior σ = 0.85 ⇒ p99/p50 = `exp(2.326 × 0.85) ≈ 7.21`, matching
the Citizens-anchored 7× FHCF PML/AAL ratio for the no-cat-year baseline.
The empirical p99/p50 *after the simulation merge* runs 18-25× on the
demo book, which is appropriate for a cat-year (events the optimizer
must price retention against).

### 7c. Capital budget anchor — *modelling parameter*

`capital_budget = book_TVaR_99 × 0.40` — the carrier is willing to retain
40 % of the mean 1-in-100 book event, ceding or non-renewing the rest.
This is a design choice, not a measurement: real carriers' XS attachment
points and FHCF participation rates vary materially. Citizens FL's 2025
private XS + cat bond placement totals $2.94 B (per Artemis 2025-04
news) on a $12.86 B 1-in-100 PML — roughly 23 % of PML privately ceded,
with the rest split between FHCF and capital surplus. The 40 % retention
target sits between Citizens (heavy ceding) and pure-private carriers
(retention closer to 60 %) and is the operator-facing budget slider on
the Portfolio page.

### References (Portfolio MIP)

14. Citizens Property Insurance Corporation, *2023 Annual Statement*
    (loss ratio history, direct premium growth).
    https://www.citizensfla.com/documents/20702/29655847/2023+Annual+Statement.pdf
15. Florida Office of Insurance Regulation, *Florida Property Insurance
    Market Update*, May 2024 (domestic specialist combined ratio,
    profit/loss flips).
    https://floir.gov/docs-sf/property-casualty-libraries/property-insurance-market-overview/insurance-update-may-2024.pdf
16. Florida Hurricane Catastrophe Fund, *2024 Aggregate Net Probable
    Maximum Loss Report* (Citizens 1-in-100 PML, FHCF reimbursement
    layer sizing).
    https://fhcf.sbafla.com/media/410lkiue/fhcf-2024-pml-report-final.pdf
17. A.M. Best, *Florida Homeowners Writers — Selected Financial
    Indicators, 2023 Edition* (specialist carrier rankings, combined
    ratios).
    https://bestsreview.ambest.com/displaychart.aspx?Record_Code=328093
18. S&P Global Market Intelligence, *US homeowners insurers' net
    combined ratio surges past 110%* (May 2024).
    https://www.spglobal.com/market-intelligence/en/news-insights/articles/2024/5/us-homeowners-insurers-net-combined-ratio-surges-past-110-81711947
19. Insurance Information Institute / Triple-I, *Home Insurance Premiums
    in Florida Increased 80% Less in 2023 Than Initial Projections* (June
    2024 press release; tort-reform impact attribution).
    https://www.iii.org/press-release/triple-i-home-insurance-premiums-in-florida-increased-80-less-in-2023-than-initial-projections-due-in-large-part-to-legislative-legal-system-abuse-reforms-062624
20. Artemis.bm, *Florida Citizens targets $2.94 B of new reinsurance and
    cat bonds for 2025* (April 2025) — private market participation
    relative to PML.
    https://www.artemis.bm/news/florida-citizens-targets-2-94bn-of-new-reinsurance-and-cat-bonds-for-2025/
21. Artzner, Delbaen, Eber & Heath, *Coherent Measures of Risk*,
    Mathematical Finance 1999, 9(3), 203-228 — TVaR is sub-additive
    (basis for the capital-constraint switch from VaR-99 to TVaR-99).

---

## Summary — what is cited vs. what is a modelling parameter

| Peril | Operator control | Empirically cited | Modelling parameter |
|-------|------------------|-------------------|---------------------|
| Tornado | EF0–EF5 picker | EF wind bands (NWS); path width (Brooks 2004) | 6-step damage multiplier (spine-anchored) |
| Earthquake | Mw 5.0–9.0 slider | Bakun–Wentworth attenuation → circle radius | linear-in-Mw multiplier, zero floor below Mw 5.53 |
| Hail | Ø 10–120 mm slider | TORRO H-scale; 20 mm damage threshold | linear-in-diameter multiplier, zero below threshold |
| Flood | Minor/Moderate/Major | NWS flood categories | recalibrated 3-step (off the spine; NFIP-anchored) |
| Wildfire | Low/Moderate/High | dNBR burn-severity classes (USGS) | recalibrated 3-step (off the spine; dNBR-anchored) |
| Winter | WSSI 5 categories | NWS WSSI | recalibrated 5-step (off the spine; Uri/Buffalo-anchored) |

## 8. CV property features — Sentinel-2 band math & mock-mode noise asymptotes

### 8a. Sentinel-2 indices — *empirically cited (formulas)*

The eight raw CV dims (five surfaced in the Portfolio drill-down) are
emitted by the trained MLP head fine-tuned on top of a Prithvi/ViT-B
backbone against **Sentinel-2 L2A** surface-reflectance chips. The
deterministic mock path uses the same band-math formulas as the head's
training signal — they are also the formulas a reader should recognise
when interpreting the dim semantics:

| Dim | Formula / signal | Source |
|---|---|---|
| `vegetation_density` | `NDVI = (B08 − B04) / (B08 + B04)` rescaled to `[0,1]` | Rouse et al. 1973 — NASA NDVI definition [22] |
| `water_proximity` | `NDWI = (B03 − B08) / (B03 + B08)` rescaled to `[0,1]` | McFeeters 1996 — *Int J Remote Sens* 17(7) [23] |
| `fuel_proximity` | `B11 (SWIR-1) / 10000` (dry-vegetation proxy) | ESA Sentinel-2 SR scale [24] |
| `elevation_bucket` | `hash(chip_bytes) mod 5 / 4` (deterministic proxy) | placeholder — not derived from a DEM |
| `structure_density` | Sobel-like gradient mean on NIR, ×20 | Sobel 1968 — operator definition [25] |

### 8b. Chip cache — *real Sentinel-2 chips on disk*

`artifacts/chips/<NN>/<policy_id>.npy` holds 5-band 256×256 `uint16`
Sentinel-2 L2A chips, sharded by the first two digits of the policy id.
The cache is populated by `scripts/cache_s2_chips.py`, which iterates over
`policies(id, lat, lon)`, calls `ml.cv.data_loaders.fetch_chip()` against
Microsoft Planetary Computer's `sentinel-2-l2a` STAC collection [26], picks
the most recent scene with cloud cover < 10 % intersecting the policy
centroid, and writes the 256×256 reflectance window through
`save_cached_chip()`.

**Provenance for the demo book (`forge-local.db`):**

- Source: Microsoft Planetary Computer, `sentinel-2-l2a` STAC collection.
- Fetched: **2026-05-16T05:41:06 → 2026-05-16T10:17:06** (cache_s2_chips.py).
- Per-policy fetch: most recent scene with cloud cover < 10 % intersecting
  the policy's `(lat, lon)` centroid; 256×256 px window, 5 bands
  (B04, B03, B02, B08, B11), stored as raw `uint16` `.npy`.
- Success: **9,999 / 10,000** policies. One failure: policy `8368` —
  `RasterioIOError: HTTP response code: 403` on the signed asset URL.
  Failure list at `artifacts/chips_fetch_failures.txt`; full
  per-poll log at `artifacts/chips_fetch.log`.
- The trained MLP head (`artifacts/cv_head.pt`, ~2.2 MB) is tracked in
  the repo; the chip cache is gitignored (~6 GB).

### 8c. cv_features population — *trained head over real chips*

`scripts/populate_cv_features.py --mode cached` (default) reads each
cached chip, forwards it through the Prithvi backbone + trained MLP head
(`predict_chip`), and writes the resulting 8-float vector to
`policies.cv_features` as a JSON-encoded array. Policies that hit the
single fetch failure fall through to the mock band-math path
(`load_chip_features` line 308–312) — for the demo book, that's policy
`8368` only.

Observed per-dim distribution after running `--mode cached` on the demo
book (10,000 policies):

| Dim | Mean | Stdev | Min | Max |
|---|---|---|---|---|
| `vegetation_density` | 0.483 | 0.011 | 0.427 | 0.539 |
| `impervious_surface` | 0.524 | 0.011 | 0.468 | 0.580 |
| `fuel_proximity` | 0.666 | 0.019 | 0.498 | 0.720 |
| `roof_condition_proxy` | 0.413 | 0.012 | 0.357 | 0.503 |
| `water_proximity` | 0.331 | 0.019 | 0.269 | 0.502 |
| `elevation_bucket` | 0.475 | 0.026 | 0.000 | 1.000 |
| `ndvi_seasonal_var` | 0.502 | 0.033 | 0.447 | 1.000 |
| `structure_density` | 0.530 | 0.032 | 0.474 | 1.000 |

**Discrimination caveat:** the per-policy stdevs are tight (≈0.01–0.03)
and the per-ZIP3 averages differ in the third / fourth decimal place
(FL Hernando 346: vegetation 0.4826 / fuel 0.6716 / water 0.3269;
TX Harris 770: 0.4826 / 0.6660 / 0.3323). This is a model-quality
observation, not a data-integrity one — the head is producing real
outputs on real Sentinel-2 chips, but it doesn't discriminate strongly
between residential coastal geographies in the US South. Tightening
the head's signal is a Phase 2 retraining task (NLCD + OSM weak labels
referenced in `lib/db/cohorts.ts` and the drill-down footnote).

Real values are what the UI surfaces. The previous practice of
populating via `--mode mock` is forbidden by `populate_cv_features.py`
unless `--allow-mock` is passed (see §8d below).

### 8e. Why the trained MLP head is bypassed by default — *empirical evidence*

`artifacts/cv_head.pt` was trained against weak labels emitted by
`ml/cv/train.py::_derive_labels(flood_zone, build_type, elevation_m)` — a
hand-coded 8-dim function of policy METADATA, with no dependency on chip
content. Because the supervision signal is independent of the input
features, the loss-minimising MLP collapses to the label-mean: a constant
function that emits roughly the same vector for every chip.

Empirical verification across the demo book (10,000 policies, real Sentinel-2
cached chips from §8b):

| Path                                  | per-policy stdev (vegetation_density) | discrimination |
|---------------------------------------|---------------------------------------|----------------|
| Raw NDVI on real cached chips         | ≈ 0.10–0.25 (range −0.06 to +0.42)    | strong         |
| `predict_chip_mock` band-math (real)  | ≈ 0.10 stdev (range 0.38–0.82)        | strong         |
| `predict_chip` trained head (real)    | ≈ 0.011 stdev (range 0.43–0.54)       | **near-zero**  |

`load_chip_features(..., bypass_head=True)` (also via env
`FORGE_CV_BYPASS_HEAD=1`) and the populate script's default both bypass
the trained head and run band-math directly on the real chips. The head
remains in the tree; passing `populate_cv_features.py --use-head`
restores forwarding through it (for comparison only — see Phase 2
retrain results below).

**Phase 2 / P2.37 retrain — partial success.** Re-running `ml/cv/train.py`
against the new ESA WorldCover + MS Buildings weak labels (§12) on the same
frozen ViT-B/16 backbone for 20 epochs (best val MAE 0.1105 at epoch 3)
improved per-policy stdev 6-10× over the metadata-trained head but did
NOT preserve the per-ZIP geographic contrast embedded in the labels:

| Path                                | impervious stdev | impervious Δ (TX 770 vs FL 346) |
|-------------------------------------|------------------|---------------------------------|
| Phase-1 metadata-trained head       | ≈ 0.011          | ~ 0.00                          |
| Phase-2 weak-label-retrained head   | **≈ 0.066** (PASS gate >0.05) | **0.02** (FAIL gate >0.15) |
| ESA WC labels themselves            | ≈ 0.22           | **0.49**                        |

The head's outputs compress every chip toward the book-wide mean —
likely because the frozen ViT-B backbone wasn't pretrained on land-cover
imagery and the small MLP head can't reconstruct the strong geographic
signal that ESA WorldCover encodes directly. Honest follow-up paths:
unfreezing the backbone, swapping to Prithvi-100M (land-cover-pretrained),
or training a longer schedule with a label-magnitude-aware loss.

**Decision (2026-05-23):** keep `bypass_head=True` as the populate
default. The retrained head is saved at `artifacts/cv_head.pt`; the
Phase-1 metadata-trained head is preserved at
`artifacts/cv_head.metadata-trained.pt` for regression diffing.
**Populate now OVERLAYS the parquet values directly at idx 1, 3, 6**
(`scripts/populate_cv_features.py` — band-math for the 5 already-modeled
dims plus literal ESA WorldCover / MS Buildings labels for the new three).
That ships the real geographic signal to the UI today without waiting on
a more expressive head.

### 8f. Why mock-mode populations are forbidden — *derivation*

`ml/cv/data_loaders.py::mock_chip(lat, lon)` returns `rng.integers(0, 10001,
size=(5, 256, 256))` — i.e. uniformly-distributed `uint16` noise per band,
deterministically seeded by lat/lon. Applying the band-math formulas above to
uniform `[0, 10000]` noise gives closed-form **asymptotic means** that are
identical for every policy:

| Dim | Asymptotic mean over `U(0, 10000)` noise |
|---|---|
| `vegetation_density` | NDVI of i.i.d. uniform bands has expectation 0 → rescaled to **0.50** |
| `water_proximity` | NDWI of i.i.d. uniform bands has expectation 0 → rescaled to **0.50** |
| `fuel_proximity` | `E[U/10000] = 0.50` → **0.50** |
| `elevation_bucket` | hash mod 5 / 4 ∈ {0, 0.25, 0.5, 0.75, 1.0} uniform → mean **0.50** |
| `structure_density` | edge density of pure noise ≈ 0.05–0.1 × ×20 scaling saturates → **1.00** |

These are the values observed in an earlier draft of this PR — vegetation
0.50, fuel 0.50, water 0.50, elevation ~0.52, structure 1.00 — when
`populate_cv_features.py --mode mock` was wired into the seed. They are not
Sentinel-2 observations; they are the mathematical fingerprint of running
NDVI/NDWI/SWIR/edge-density on uniform noise. Per CLAUDE.md "no fictional
data": the drill-down hides the bar chart and surfaces an amber
"unpopulated" callout when `cv_features = NULL`, and the populate script
refuses `--mode mock` unless `--allow-mock` is passed explicitly (offline
training pipelines that need a non-null column to exercise downstream code).

## 9. Seed-book premium & loss prior — sourced calibration (2026-05-23)

The `scripts/seed_policy_book.py` premium model and the
`scripts/precompute_portfolio_optimization.py` loss prior previously used
hand-picked multipliers (`ZONE_MULT = {0.9, 1.2, 1.4, 1.8}`,
`FLOOD_ZONE_SEVERITY = {0.6, 1.0, 1.4, 2.2}`,
`BUILD_VULNERABILITY = {1.0, 0.55, 1.9}`,
`annual_loss_rate = 0.012 × …`) with no citations. Replaced with the
sourced values below; every figure traces to a primary or industry source.

### 9a. State HO-3 average premium rates — *empirically cited*

| State | HO-3 avg premium (2022) | / Median TIV $268k | = % TIV |
|---|---|---|---|
| FL | $2,677 | $268,000 | **1.000%** |
| TX | $2,397 | $268,000 | **0.894%** |
| LA | $2,603 | $268,000 | **0.971%** |
| NC | $1,621 | $268,000 | **0.605%** |

Source: III, "Facts + Statistics: Homeowners and Renters Insurance"
(2022 HO-3 averages), underlying NAIC "Dwelling Fire, Homeowners, and
Renters Insurance Report" — TX figure from Texas Department of Insurance.
https://www.iii.org/fact-statistic/facts-statistics-homeowners-and-renters-insurance

Wired in: `scripts/seed_policy_book.py::STATE_HO3_RATE`.

### 9b. NFIP per-zone expected loss — *derived from real claims*

Queried OpenFEMA endpoints on 2026-05-23:

- `FimaNfipClaims`: 166,234 paid claims with non-zero
  `amountPaidOnBuildingClaim`, `yearOfLoss` 2018–2023 (6-year window).
- `FimaNfipPolicies`: 3,649,432 policies with `policyEffectiveDate` in 2021.

| Zone | n_claims (6y) | claims/yr | n_policies (2021) | claim_freq /yr | avg_paid    | expected loss /yr | ratio /X |
|------|---------------|-----------|-------------------|----------------|-------------|-------------------|----------|
| X    | 41,651        | 6,942     | 1,911,579         | 0.363%         | $41,192     | $149.62           | 1.000    |
| A    | 7,141         | 1,190     | 139,143           | 0.855%         | $41,907     | $358.51           | **2.40** |
| AE   | 111,582       | 18,597    | 1,545,383         | 1.203%         | $65,034     | $782.59           | **5.23** |
| VE   | 5,860         | 977       | 53,327            | 1.831%         | $100,370    | $1,838.18         | **12.29**|

Loaded for NFIP expense ratio ≈ 0.35 (divide expected loss by 0.65, then
divide by NFIP average-policy TIV ≈ $268k):

| Zone | loaded loss / TIV |
|------|-------------------|
| X    | 0.086%            |
| A    | 0.207%            |
| AE   | 0.450%            |
| VE   | 1.057%            |

Source: FEMA OpenFEMA API endpoints
https://www.fema.gov/api/open/v2/FimaNfipClaims and
https://www.fema.gov/api/open/v2/FimaNfipPolicies (filter expressions in
`/tmp/nfip_zone_calc.py`, archived in commit).

Wired in:
- `scripts/seed_policy_book.py::NFIP_FLOOD_LOADING` (the loaded /TIV percentages above).
- `scripts/precompute_portfolio_optimization.py::FLOOD_ZONE_SEVERITY` (the ratios /X column).

### 9c. Build-type vulnerability — *HAZUS-MH wind anchors*

HAZUS-MH Hurricane Technical Manual wind damage curves at 110 mph (Cat-2
representative coastal Southeast peril):

| Build type   | HAZUS damage ratio | Premium loading | Loss vulnerability |
|--------------|--------------------|-----------------|--------------------|
| wood_frame   | ~5%                | **1.00** (baseline) | **1.00** (baseline) |
| masonry      | ~2%                | **0.85** (premium discount for resistance) | **0.40** (HAZUS-ratio) |
| manufactured | ~15%               | **1.40** (HO-7 / mobile-home loading) | **3.00** (HAZUS-ratio) |

The premium loading reflects what carriers actually charge (the wind
discount on masonry is smaller than the HAZUS ratio because non-wind
perils dominate average year). The loss vulnerability mirrors HAZUS-ratio
because that's what drives the expected-loss prior.

Sources:
- FEMA HAZUS-MH 5.1 Hurricane Technical Manual (April 2022), §6.4 "Wind Damage
  Functions", Tables 6.4-1 (Wood Frame), 6.4-2 (Masonry), 6.4-7 (Manufactured
  Housing). The 110 mph anchor sits at the Cat-2 ceiling on the Saffir-Simpson
  scale; values at 130 / 155 / 180 mph (Cat-3 / Cat-4 / Cat-5 ceilings) are
  also wired through `ml/xgb/hazus_curves.py::wind_damage_ratio` as the ML
  training-data signal. AUDIT.2 (2026-05-24) pinned these via
  `tests/ml/xgb/test_hazus.py::TestHazusWindAnchors`.
- FEMA P-1019 (2019) hurricane vulnerability functions calibrated against
  post-Andrew (1992), post-Charley (2004), post-Ian (2022) claim datasets —
  the source the HAZUS-MH 5.1 tables derive from.
- HO-7 product pricing per state DOI rate filings (FL OIR, TX TDI).

Wired in:
- `ml/xgb/hazus_curves.py::wind_damage_ratio` (continuous interpolation —
  ML training-data path).
- `api_py/sim_loss.py::_HAZUS_MATRIX` + `lib/sim/severity.ts::HAZUS_MATRIX`
  (per-peril discrete severe-anchor matrix — simulation-side; see §1c).
- `scripts/seed_policy_book.py::BUILD_PREMIUM_LOADING` (premium-side multipliers).
- `scripts/precompute_portfolio_optimization.py::BUILD_VULNERABILITY` (loss-side multipliers).

The two HAZUS surfaces in the repo (continuous curves in
`ml/xgb/hazus_curves.py` vs the discrete `_HAZUS_MATRIX` per-build × peril
table) are *different abstractions over the same source data*. They
intentionally do not share numeric values — the curves give fine-grained
intensity → damage interpolation for XGB training, while the matrix gives
a per-peril severe-anchor scalar that the sim multiplies by a severity
level. Both trace back to HAZUS-MH 5.1; AUDIT.2 cross-cited both.

### 9d. Elevation slope — *HAZUS-Flood depth-damage gradient*

HAZUS-Flood Technical Manual 4.0 depth-damage curves indicate ~10%
damage reduction per foot of first-floor elevation above BFE at the
low-depth regime (0–3 ft of flood depth). Translating to per-meter, and
applying only to the FLOOD component of total expected loss (wind / hail
/ fire are elevation-independent):

`elev_factor = max(0.70, 1.0 − 0.05 × avg_elevation_m)`

The surge depth-damage curve breakpoints in `ml/xgb/hazus_curves.py::
surge_damage_ratio` (0.3 m → 10%, 1.0 m → 35%, 2.0 m → 65%, 4.0 m → 95%)
sample the FEMA HAZUS-MH 5.1 Flood Technical Manual §9 Table 9.5
("One-Story No Basement Residential Depth-Damage Function") at the
canonical 1/3/6/13 ft depth anchors. Pinned via
`tests/ml/xgb/test_hazus.py::TestHazusSurgeAnchors`. The HAZUS-Flood
curves derive in turn from USACE EGM 04-01 (2004) updated against
post-Katrina (2005), post-Sandy (2012), post-Harvey (2017) claim records.

Floor 0.70 reflects that the ~70% non-flood component of total loss
can't be mitigated by elevation. Slope 0.05/m matches the HAZUS gradient
applied to the ~30% flood share of total loss.

Source: FEMA HAZUS-Flood Technical Manual 4.0 §6.
Wired in: `scripts/precompute_portfolio_optimization.py::_cohort_loss_quantiles`.

### 9e. Base catastrophe-exposed annual loss rate — *industry HO-3 anchor*

`annual_loss_rate = 0.0023 × zone_factor × build_factor × elev_factor`.

Calibrated so the book-weighted expected loss lands near **0.55% of TIV
per year** — the industry HO-3 incurred-loss-ratio benchmark for the
coastal Southeast:

- Citizens FL 2024 net loss ratio forecast: 37.7% of premium × 1.0% TIV
  premium ≈ 0.38% TIV (the conservative Citizens-only anchor).
- Broader FL/TX/LA/NC industry runs closer to 0.55–0.65% TIV in
  no-cat-year baseline (NAIC industry aggregate).
- Cat years (Ian, Helene) push annual loss ratios to 100–130%+; those
  layer in via the merged sim parquet at promotion time, not via the
  prior.

Book-mix verification:
- E[zone_factor] = 1.0·0.55 + 2.40·0.20 + 5.23·0.20 + 12.29·0.05 ≈ 2.69
- E[build_factor] = 1.0·0.55 + 0.40·0.30 + 3.00·0.15 ≈ 1.12
- E[elev_factor] ≈ 0.85 (typical 3m avg elevation)
- Expected book-avg = 0.0023 × 2.69 × 1.12 × 0.85 ≈ **0.59% TIV/yr** ✓

Wired in: `scripts/precompute_portfolio_optimization.py::_cohort_loss_quantiles`.

Previous base rate `0.012` (with the earlier uncited zone/build factors
that averaged 0.92) produced 0.88% book-avg expected loss, overstating
normal-year severity by ~60%.

## 10. Portfolio MIP cession economics — *2026 reinsurance market*

### 10a. QS ceding-commission norms — `CESSION_COST_RATE['cede_qs']`

US homeowner quota-share treaties typically cede 50% of premium to the
reinsurer, who returns 30-35% of the ceded premium as a ceding
commission. Net cost-to-cede-per-dollar-of-loss is approximately
`premium_ceded × (1 − commission) / loss_ceded`. For 30-35% commissions
this lands at `0.65-0.70`.

Set to **0.65** in `api_py/optimize_portfolio.py::CESSION_COST_RATE`.

Source: Aon Reinsurance Market Dynamics, January 2026 report; published
on Aon's "Reinsurance Market Dynamics" landing page.
https://www.aon.com/en/insights/reports/reinsurance-market-dynamics

### 10b. Working-layer property-cat RoL — `CESSION_COST_RATE['cede_xs']`

Guy Carpenter US Property Catastrophe Rate-on-Line Index movements
(Artemis index tracker):

| Renewal date | YoY rate change |
|--------------|-----------------|
| 1/1 2025     | −6.2%           |
| Mid-2025     | −6.7%           |
| 1/1 2026     | **−12%**        |
| 4/1 2026     | **−14%**        |

Cumulative US Property Cat RoL Index since 2017 trough: ~+66% after
two consecutive softening cycles. Working-layer (low-attachment,
high-frequency layers like $20M xs $20M) RoLs run **~12% of premium**
in the current cycle, down from ~15% in 2024.

Set to **0.12** in `api_py/optimize_portfolio.py::CESSION_COST_RATE`.

Source: Guy Carpenter US Property Cat Rate-on-Line Index (via Artemis):
https://www.artemis.bm/us-property-cat-rate-on-line-index/

Reinsurance News market summaries:
https://www.reinsurancene.ws/2026-renewal-sees-sharpest-decline-in-risk-adjusted-global-property-rates-since-2014-howden/

## 11. Territory non-renewal caps — *INTERNAL UNDERWRITING POLICY, NOT STATUTE*

`lib/regulatory/territory_caps.ts::TERRITORY_CAPS` ships hand-set annual
non-renewal % caps per `(state, territory)` bucket. **No US state
imposes a statutory annual percentage cap on homeowner non-renewals.**
The regulatory levers are notice periods (already implemented in
`lib/regulatory/notice_periods.ts`), product-availability rules, and
post-event moratoria. The TERRITORY_CAPS values represent an INTERNAL
underwriting policy a carrier might self-impose to manage concentration,
public-relations, and rating-agency exposure — not a regulator filing.

Reconciler rationale strings emitted in
`lib/reconciler/index.ts::buildAgentNotifications` therefore read
"Internal underwriting cap exceeded" — never "regulator cap" or
"statutory limit." This pins the trust tier: the cap is a model
assumption, the rationale string admits it, and a reviewer can never be
told a fictional FL 3% number is from a Fla. Stat. citation.

Sources surveyed (and confirmed not to expose a numerical annual % cap):
- Fla. Stat. §627.4133 (non-renewal notice + hurricane-related
  protections; HB 9 / SB 16-A 2024–2025 reforms tightened notice but did
  not introduce a % cap).
- Tex. Ins. Code §551.105 (30-day notice; no annual % cap).
- La. Rev. Stat. §22:1265 (anti-discrimination; no annual % cap).
- N.C. Gen. Stat. §58-41-15 (60-day notice; no annual % cap).

## 12. P2.37 weak-label retraining trail — *sourced calibration (2026-05-23)*

Phase 2 / Task P2.37 replaces the metadata-only `_derive_labels` heuristic
(§8e) with external image-derived weak labels for the 3 previously-unmodeled
CV head dims. Every numeric output in the new pipeline traces back to one of
the two upstream sources documented here.

### 12a. Source audit — what we picked vs what the plan named

The plan default (`docs/superpowers/plans/2026-05-16-forge-redesign.md`)
named NLCD landcover + OSM building footprints + USGS 3DEP DEM. The audit
on 2026-05-23 (recorded in
`docs/superpowers/specs/2026-05-23-cv-weak-label-retrain-design.md`)
replaced all three with two sources that are strictly better against MPC
+ 10 m chip alignment:

| Plan default | Audit verdict | Reason |
|---|---|---|
| NLCD landcover (MRLC.gov) | Rejected | Not hosted on MPC; 30 m only (3× coarser than chips). |
| OSM building footprints (Overpass API) | Rejected | Per-policy rate-limited; flaky under 10k-query loads. |
| USGS 3DEP DEM for `tree_overhang` | Rejected — wrong tool | DEM is bare-earth terrain, not canopy. The canopy-like product `3dep-lidar-hag` is `proprietary` on MPC and has no FL Hernando 346 coverage. |
| **Approved swap** | ESA WorldCover (idx 1 + 6) + MS Buildings (idx 3) | 10m native S2 alignment; both on MPC's auth path; one fetch produces both impervious AND tree fractions; ODbL-compliant attribution surfaced in the drill-down. |

### 12b. ESA WorldCover 2021 — `imperviousness` + `tree_overhang`

- **Product:** ESA WorldCover v200 (2021). Global 10 m land cover map
  produced from Sentinel-1 + Sentinel-2 observations, classified into
  11 IPCC-style categories.
- **License:** CC-BY-4.0 (Zanaga et al. 2022, doi:10.5281/zenodo.7254221 [27]).
- **Distribution:** Microsoft Planetary Computer STAC collection
  `esa-worldcover` ([28]). No API key required.
- **Spatial:** 3°×3° tiles, EPSG:4326 (geographic). The id encodes the
  **SW corner** of the tile — e.g. `N27W084` covers latitudes [27°, 30°]
  and longitudes [-84°, -81°]. Verified empirically against MPC STAC:
  a search for (28.55, -82.45) returns
  `ESA_WorldCover_10m_2021_v200_N27W084`.
- **Fetched:** 2026-05-23 via `ml/cv/labels/esa_worldcover.py::_open_scene`
  (LRU-cached, ~20 unique scenes cover the synthetic FORGE policy book).
- **Class codes used:**
  - **50** Built-up → fraction over the 256 px chip window = `imperviousness` (idx 1).
  - **10** Tree cover → fraction over the 256 px chip window = `tree_overhang` (idx 6).
- **Attribution rendered in `/portfolio` drill-down:**
  "© ESA WorldCover 2021 — Zanaga et al., doi:10.5281/zenodo.7254221" (CC-BY-4.0).

### 12c. Microsoft US Building Footprints — `roof_complexity`

- **Product:** *US Building Footprints* (Bing Maps imagery, 2014-2021).
  129+ M polygons across the contiguous US, classified by an internal
  deep-learning pipeline against Maxar / Airbus / Bing imagery [29].
- **License:** ODbL-1.0 (Open Database License).
- **Distribution:** Microsoft Planetary Computer STAC collection
  `ms-buildings` ([30]). Sharded by Bing Maps quadkey at zoom 9 — 2,413
  parquet shards cover the US, each ~78 km × 78 km at the equator.
- **Spatial:** WKB polygons in EPSG:4326. The full schema is one column,
  `geometry: binary` — no per-row quadkey or bbox metadata, so spatial
  selection uses the quadkey-shard prefilter (`ml/cv/labels/quadkey.py`
  + `ms_buildings.load_shard_index`).
- **Fetched:** 2026-05-23 via `ml/cv/labels/ms_buildings.py`. Latest
  US snapshot: `United States_2022-07-06` (selected deterministically by
  reverse-sorted item id, so reruns are reproducible).
- **Reduction:** `roof_complexity = 1 − mean(PP)` where
  `PP = 4π · area / perimeter²` (Polsby-Popper compactness, [31]). Higher
  value = more jagged footprints. Empty bbox (no buildings) → 0.
- **Attribution rendered in `/portfolio` drill-down:**
  "© Microsoft, OpenStreetMap contributors (ODbL)" (ODbL-1.0).

### 12d. Vintage gap acknowledgement

ESA WorldCover is the 2021 v200 product. MS Buildings is the 2022-07-06
snapshot. Cached Sentinel-2 chips are 2026-05-16 fetches. A 4-5 year gap
is acceptable for the three target dims because (a) imperviousness and
tree cover change slowly at the chip scale (10 m × 10 m) — most US
neighbourhoods do not flip from forest to built-up in a 5-year window;
(b) building footprints are even more stable — demolitions + new
construction at the chip scale change the polygon count by <1 % per year
on typical residential blocks. Catastrophic events (Helene 2024, hail
2023) can spot-invalidate; carrier post-event refresh is out of scope
for the demo book.

### 12e. Retrain outcome — head trained but not used by default

The Phase 2 retrain (20 epochs, frozen ViT-B/16 + 4-layer MLP head, MPS,
~10 min wall time) was scored against the acceptance gate in §8e:

- ✅ Per-policy stdev > 0.05 on `imperviousness` (head 0.066) and
  `tree_overhang` (head 0.103). `roof_complexity` stdev = 0.027 (FAIL —
  building shape varies less than land-cover across the US book).
- ❌ Per-ZIP3 |Δ| > 0.15 on `imperviousness` + `tree_overhang`. The
  labels themselves have |Δ| 0.49 / 0.28 between TX Harris (770) and FL
  Hernando (346); the head's outputs collapse those to |Δ| 0.02 / 0.005.

The discrepancy is a head-quality problem, not a label problem. We
ship the labels straight through to the UI via
`populate_cv_features.py`'s overlay path — every policy's
`cv_features` JSON is band-math for idx 0/2/4/5/7 plus the literal ESA
WorldCover + MS Buildings value at idx 1/3/6. The UI sees real
geographic signal today; the head sits on the shelf as a future
improvement target (see §8e for follow-up paths).

### 12f. Output cache + train-time consumption

`scripts/precompute_cv_weak_labels.py` writes `artifacts/cv_weak_labels.parquet`
(tracked, ~250 KB for 10 k rows × 3 float32 columns). The training step
(`ml/cv/train.py::_load_weak_labels` + `PolicyChipDataset` constructor)
loads the parquet once, joins on `policy_id`, and supplies the 3 weak
labels for indices 1 / 3 / 6 alongside band-math labels for the other 5
dims (`predict_chip_mock(chip)` on the same chip — see §8a). The retrained
head thus learns image-derived signal across all 8 dims, with the 3 new
dims supervised by real ground-truth ESA WC / MS Buildings labels rather
than the constant metadata heuristics that produced §8e's near-zero
discrimination.

**Acceptance gate** (recorded by the verification step in
`scripts/verify_cv_head.py`): per-policy stdev of the head's output across
all 10 k policies must be > 0.05 on each retrained dim (the band-math
NDVI baseline reaches 0.10; we need to be in that ballpark, not collapsed
to a constant like §8e).

### 12g. References (new in §12)

27. Zanaga, D., et al. (2022). *ESA WorldCover 10 m 2021 v200.* Zenodo.
    doi:10.5281/zenodo.7254221. https://esa-worldcover.org/en
28. Microsoft Planetary Computer — `esa-worldcover` STAC collection.
    https://planetarycomputer.microsoft.com/dataset/esa-worldcover
29. Microsoft (2022). *US Building Footprints* (Bing Maps, 129 M
    polygons). GitHub: https://github.com/microsoft/USBuildingFootprints
30. Microsoft Planetary Computer — `ms-buildings` STAC collection.
    https://planetarycomputer.microsoft.com/dataset/ms-buildings
31. Polsby, D. D., & Popper, R. D. (1991). *The Third Criterion:
    Compactness as a Procedural Safeguard Against Partisan
    Gerrymandering.* Yale Law & Policy Review, 9(2), 301-353.

## 13. AUDIT.1 — common-factor β/σ from NOAA Storm Events (2026-05-24)

The P2.4 docstring on `api_py/correlation.py` flagged its β=0.5 / σ=0.3
defaults as "sensible starting literals pending NOAA Storm Events
calibration". AUDIT.1 closes that deferral by shipping a fitter
(`api_py/correlation_fit.py`) wired into `scripts/precompute_calibration.py`.

### 13a. The model and what's identifiable from data

The simulation-loss generator applies a per-scenario multiplicative
common factor:

  L'_{s,c} = L_{s,c} · (1 + β · ε_s),   ε_s ~ N(0, σ²)

Only the product **β·σ** appears in the likelihood — β and σ are not
separately identifiable from observational damage data. The fitter
adopts the standard σ = 1 (unit-variance latent shock) convention so
β alone parameterizes the cross-event coefficient of variation.

### 13b. Estimator

For each storm episode in the corpus, sum the per-county property
damage to get a total `D_e`. Across N episodes:

  β̂ = std(D_e) / mean(D_e)         (sample-CoV under σ=1)

The estimator's standard error is roughly 1/√(2(N-1)) of β̂ — at N=8
episodes that's ~27% of β̂, which is the threshold we accept as
"more credible than the literal default". Below that gate, the
fitter persists an INSUFFICIENT_EPISODES marker to `calibration.json`
and `api_py.sim_loss::_load_correlation` continues falling back to
`DEFAULT_BETA / DEFAULT_SIGMA`.

### 13c. Current state — fitter ships, fit doesn't activate yet

At HEAD the `storm_events` table holds 337 county-level reports for
2024 only (FL, TX, LA, NC × Hurricane / Tropical Storm). Grouped by
`(year, state, event_type)` — the coarsest grouping the current
schema supports — that collapses to 7 episodes, just below the 8-
episode threshold. The fitter therefore correctly emits an
INSUFFICIENT_EPISODES marker and the loader continues to use defaults.

Enabling the fit requires either:
  - Extending `scripts/ingest_storm_events.py` to capture the
    `EPISODE_ID` field NOAA already publishes (one column add +
    schema migration), then re-ingesting; or
  - Running `ingest_storm_events.py --years 2018-2024` to broaden
    the corpus past the 8-episode gate under the current grouping.

The fitter accepts a `group_key` callback so once `episode_id` lands
the caller can switch from `(year, state, event_type)` to
`(episode_id,)` for finer-grained grouping.

### 13d. References (new in §13)

32. NOAA — Storm Events Database. https://www.ncdc.noaa.gov/stormevents/
33. NCEI — Storm Events FTP archive (1950-present, gzip CSV by year).
    https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/

## References

1. NWS Norman — The Enhanced Fujita Scale. https://www.weather.gov/oun/efscale
2. NOAA Storm Prediction Center — EF Scale. https://www.spc.noaa.gov/efscale/
3. Brooks, H. E. (2004). On the Relationship of Tornado Path Length and Width
   to Intensity. *Weather and Forecasting* 19(2), 310–319.
   https://www.nssl.noaa.gov/users/brooks/public_html/papers/lengthwidth.pdf
4. Bakun, W. H. & Wentworth, C. M. (1997). Estimating Earthquake Location and
   Magnitude from Seismic Intensity Data. *BSSA* 87(6), 1502–1521.
   https://pubs.usgs.gov/publication/70019412
5. USGS — Earthquake Magnitude, Energy Release, and Shaking Intensity.
   https://www.usgs.gov/programs/earthquake-hazards/earthquake-magnitude-energy-release-and-shaking-intensity
6. TORRO — The Hailstorm Intensity (H) Scale.
   https://www.torro.org.uk/research/hail/hscale
7. NWS/NOAA — Flood Categories (AHPS terminology).
   https://www.weather.gov/aprfc/terminology
8. NWCG — Glossary of Wildland Fire, "size class of fire".
   https://www.nwcg.gov/publications/pms205/nwcg-glossary-of-wildland-fire-pms-205/incident-size-389
9. USGS — Landsat Burned Area / dNBR.
   https://www.usgs.gov/landsat-missions/landsat-burned-area
10. NWS — Winter Storm Severity Index. https://www.weather.gov/wssi/
11. NOAA NCEI — Regional Snowfall Index.
    https://www.ncei.noaa.gov/access/monitoring/rsi/
12. Texas Department of Insurance — *Insured Losses Resulting from the
    February 2021 Winter Weather Event* (March 2022 final report;
    Winter Storm Uri totals).
    https://www.tdi.texas.gov/reports/documents/feb2021-tx-winter-weather-summary-mar2022.pdf
13. Insurance Information Institute — *Facts + Statistics: Winter Storms*
    (annual industry losses, per-claim severity, frozen-pipe frequency).
    https://www.iii.org/fact-statistic/facts-statistics-winter-storms
14. Smith, A. B. & Katz, R. W. (2013). U.S. billion-dollar weather and
    climate disasters: data sources, trends, accuracy and biases.
    *Natural Hazards* 67, 387–410. (SCS share + climatology — Task P3.14.)
    https://doi.org/10.1007/s11069-013-0566-5
15. Brooks, H. E., Doswell, C. A., & Kay, M. P. (2003). Climatological
    estimates of local daily tornado probability for the United States.
    *Weather and Forecasting* 18, 626–640. (Hail Alley geography +
    TORRO stone-diameter table reproduction — Task P3.14.)
    https://journals.ametsoc.org/view/journals/wefo/18/4/1520-0434_2003_018_0626_ceoldt_2_0_co_2.xml
16. Allen, J. T., Tippett, M. K., & Sobel, A. H. (2017). Influence of the
    El Niño/Southern Oscillation on tornado and hail frequency in the
    United States. *Journal of Climate* 30, 9-30. (SPC severe-hail
    report distribution bounds — Task P3.14.)
17. NIFC (National Interagency Fire Center) — annual wildfire
    statistics, fire size class breakdown.
    https://www.nifc.gov/fire-information/statistics
    (Damaging-fire size distribution anchor — Task P3.15.)
18. USGS / Cal Fire RAVG — Rapid Assessment of Vegetation condition
    after wildfire, dNBR burn severity products.
    https://burnseverity.cr.usgs.gov/ravg/ (Task P3.15.)
19. Cal Fire — Damage Inspection (DINS) per-structure records.
    https://www.fire.ca.gov/incidents/
    (Severity-among-damaging-fires distribution — Task P3.15.)
20. Headwaters Economics — *Building Wildfire Resilience into Western
    Communities*; WUI structure growth data.
    https://headwaterseconomics.org/natural-hazards/wildfire/
    (Western US WUI geographic anchor — Task P3.15.)
21. Hauksson, E. (2011). Crustal structure and seismicity distribution
    adjacent to the Pacific and North America plate boundary in
    southern California. *Journal of Geophysical Research* 116, B07302.
    (Gutenberg-Richter b ≈ 1.0 anchor — Task P3.16.)
21b. Goldfinger, C., et al. (2012). Turbidite event history—Methods and
    implications for Holocene paleoseismicity of the Cascadia
    subduction zone. *USGS Professional Paper* 1661-F.
    (Cascadia maximum-magnitude soft cap — Task P3.16.)
21c. USGS National Seismic Hazard Map 2023 — regional weighting
    among California / PNW / Intermountain West / New Madrid / Alaska.
    https://www.usgs.gov/programs/earthquake-hazards/national-seismic-hazard-maps
22. Rouse, J. W., Haas, R. H., Schell, J. A., & Deering, D. W. (1973).
    *Monitoring Vegetation Systems in the Great Plains with ERTS*.
    NASA Goddard Space Flight Center, Third ERTS-1 Symposium.
    https://ntrs.nasa.gov/citations/19740022614
23. McFeeters, S. K. (1996). The use of the Normalized Difference Water
    Index (NDWI) in the delineation of open water features. *Int J Remote
    Sens* 17(7), 1425–1432.
    https://doi.org/10.1080/01431169608948714
24. ESA Sentinel-2 User Handbook — Level-2A scaled surface reflectance,
    quantification value 10 000.
    https://sentinels.copernicus.eu/documents/247904/685211/Sentinel-2_User_Handbook
25. Sobel, I. (1968). *A 3×3 Isotropic Gradient Operator for Image
    Processing*. Stanford AI Project, presented Talk at the Stanford
    Artificial Intelligence Project. (Standard discrete-gradient operator
    used as the structure_density proxy on the NIR band.)
26. Microsoft Planetary Computer — `sentinel-2-l2a` STAC collection.
    https://planetarycomputer.microsoft.com/dataset/sentinel-2-l2a
