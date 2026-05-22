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
`INTENSITY_SCALE` spine:

```
multiplier(Mw) = 1.0 + 0.45·(Mw − 7.0)        clamped ≥ 0.05
```

(M6 → 0.55, M7 → 1.0, M8 → 1.45 — the existing three anchors made continuous.)

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

Maximum stone diameter → loss multiplier, linear, anchored at the NWS
severe-hail threshold (25 mm → 0.55) with slope set by the golf-ball landmark
(45 mm → 1.0):

```
multiplier(Ø mm) = 0.55 + 0.0225·(Ø − 25)        clamped ≥ 0.05
```

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

Minor / Moderate / Major map directly onto the `INTENSITY_SCALE` spine
**0.55 / 1.0 / 1.45** — a one-to-one relabel of the legacy three tiers.

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

Low / Moderate / High burn severity map directly onto the `INTENSITY_SCALE`
spine **0.55 / 1.0 / 1.45**.

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

WSSI category → loss multiplier, anchored so Minor / Moderate / Major hit the
`INTENSITY_SCALE` spine; Limited and Extreme extrapolate one step out:

| Limited | Minor | Moderate | Major | Extreme |
|---------|-------|----------|-------|---------|
| 0.325   | 0.55  | 1.0      | 1.45  | 1.90    |

---

## Summary — what is cited vs. what is a modelling parameter

| Peril | Operator control | Empirically cited | Modelling parameter |
|-------|------------------|-------------------|---------------------|
| Tornado | EF0–EF5 picker | EF wind bands (NWS); path width (Brooks 2004) | 6-step damage multiplier |
| Earthquake | Mw 5.0–9.0 slider | Bakun–Wentworth attenuation → circle radius | linear-in-Mw multiplier |
| Hail | Ø 10–120 mm slider | TORRO H-scale; NWS 25 mm threshold | linear-in-diameter multiplier |
| Flood | Minor/Moderate/Major | NWS flood categories | direct spine map |
| Wildfire | Low/Moderate/High | dNBR burn-severity classes (USGS) | direct spine map |
| Winter | WSSI 5 categories | NWS WSSI | 5-step damage multiplier |

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
