#!/usr/bin/env python3
"""
Build lib/geo/data/us-states.geo.json from us-atlas TopoJSON.

us-atlas (https://github.com/topojson/us-atlas) is a curated, Apache-2.0
re-publication of US Census Bureau cartographic boundary files. The Census
files themselves are in the public domain
(https://www.census.gov/data-tools/developers/about/terms-of-service.html);
us-atlas adds tidy TopoJSON packaging.

We pin to us-atlas v3 (states-10m.json — 1:10,000,000 simplified). This
gives ~114 KB of TopoJSON that, once decoded to GeoJSON FeatureCollection,
weighs ~600 KB unminified. The choropleth ships the *decoded* JSON since
the front-end consumes GeoJSON directly via MapLibre `addSource`.

Run:
    python -m scripts.build_state_geojson

Re-run when bumping us-atlas (e.g. once a year as Census publishes new
boundary files).

Outputs:
    lib/geo/data/us-states.geo.json      — GeoJSON FeatureCollection
    lib/geo/data/us-states.geo.json.sha  — SHA-256 of the source TopoJSON
                                            (for reproducibility audits)
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any
from urllib.request import urlopen

# us-atlas v3 — pinned to a specific minor for reproducibility.
SOURCE_URL = "https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/states-10m.json"
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "lib" / "geo" / "data"
OUTPUT_PATH = OUTPUT_DIR / "us-states.geo.json"
HASH_PATH = OUTPUT_DIR / "us-states.geo.json.sha"

# FIPS state code (2-digit) → USPS 2-letter abbreviation. The 50 states
# plus DC; the territories (PR, GU, VI, etc.) are intentionally skipped
# because the FORGE policy book is CONUS-only (per scripts/seed_policy_book.py).
FIPS_TO_USPS: dict[str, str] = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA",
    "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL",
    "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN",
    "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME",
    "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS",
    "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
    "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND",
    "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
    "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
    "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI",
    "56": "WY",
}


def decode_arc(arc: list[list[float]], transform: dict[str, list[float]]) -> list[list[float]]:
    """Apply transform + delta decoding to a single TopoJSON arc."""
    scale_x, scale_y = transform["scale"]
    trans_x, trans_y = transform["translate"]
    out: list[list[float]] = []
    x = y = 0
    for dx, dy in arc:
        x += dx
        y += dy
        out.append([x * scale_x + trans_x, y * scale_y + trans_y])
    return out


def stitch_ring(ring_indices: list[int], arcs: list[list[list[float]]]) -> list[list[float]]:
    """Stitch a polygon ring from its arc-index list. Negative indices
    mean reverse the arc (and bitwise-NOT the index, per TopoJSON spec)."""
    coords: list[list[float]] = []
    for idx in ring_indices:
        if idx < 0:
            arc = list(reversed(arcs[~idx]))
        else:
            arc = arcs[idx]
        if coords and coords[-1] == arc[0]:
            # avoid duplicating join points
            coords.extend(arc[1:])
        else:
            coords.extend(arc)
    return coords


def _valid_ring(ring: list[list[float]]) -> bool:
    """GeoJSON RFC 7946 §3.1.6: a linear ring needs at least 4 positions
    (3 unique + 1 closing). us-atlas occasionally ships degenerate
    3-point rings (e.g. a Delaware sliver) — filter them; they don't
    render any visible area anyway."""
    return len(ring) >= 4


def geometry_to_geojson(
    geom: dict[str, Any],
    decoded_arcs: list[list[list[float]]],
) -> dict[str, Any]:
    """Convert one TopoJSON geometry → GeoJSON geometry. Supports
    Polygon and MultiPolygon (the only types in us-atlas states).
    Filters degenerate rings; drops sub-polygons whose outer ring
    becomes invalid; if a MultiPolygon collapses to a single polygon
    it stays MultiPolygon (the consumer handles both)."""
    gtype = geom["type"]
    if gtype == "Polygon":
        rings = [stitch_ring(r, decoded_arcs) for r in geom["arcs"]]
        rings = [r for r in rings if _valid_ring(r)]
        return {"type": "Polygon", "coordinates": rings}
    if gtype == "MultiPolygon":
        polys: list[list[list[list[float]]]] = []
        for poly in geom["arcs"]:
            sub = [stitch_ring(r, decoded_arcs) for r in poly]
            sub = [r for r in sub if _valid_ring(r)]
            if sub:  # drop the whole sub-polygon if its outer ring died
                polys.append(sub)
        return {"type": "MultiPolygon", "coordinates": polys}
    raise ValueError(f"Unsupported geometry type: {gtype}")


def main() -> None:
    print(f"Fetching {SOURCE_URL}")
    with urlopen(SOURCE_URL) as response:
        raw = response.read()

    digest = hashlib.sha256(raw).hexdigest()
    topo = json.loads(raw)
    if topo.get("type") != "Topology":
        raise RuntimeError(f"Unexpected top-level type: {topo.get('type')}")

    transform = topo["transform"]
    decoded_arcs = [decode_arc(arc, transform) for arc in topo["arcs"]]
    geometries = topo["objects"]["states"]["geometries"]

    features: list[dict[str, Any]] = []
    seen_fips: set[str] = set()
    skipped: list[tuple[str, str]] = []
    for geom in geometries:
        fips = str(geom.get("id", "")).zfill(2)
        seen_fips.add(fips)
        usps = FIPS_TO_USPS.get(fips)
        name = geom["properties"]["name"]
        if not usps:
            skipped.append((fips, name))
            continue
        features.append({
            "type": "Feature",
            "properties": {
                "iso_code": usps,
                "name": name,
                "fips": fips,
            },
            "geometry": geometry_to_geojson(geom, decoded_arcs),
        })

    features.sort(key=lambda f: f["properties"]["iso_code"])

    fc = {
        "type": "FeatureCollection",
        "features": features,
        "source": {
            "url": SOURCE_URL,
            "sha256": digest,
            "license": "Apache-2.0 (us-atlas) / public-domain (US Census)",
            "note": (
                "us-atlas v3 states-10m re-published from US Census Bureau "
                "cartographic boundary files (CB year per us-atlas release). "
                "Re-run scripts/build_state_geojson.py to regenerate."
            ),
        },
    }

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w") as out:
        json.dump(fc, out, separators=(",", ":"))
    HASH_PATH.write_text(digest + "\n")

    size_kb = OUTPUT_PATH.stat().st_size / 1024
    print(f"  → wrote {len(features)} states to {OUTPUT_PATH} ({size_kb:.1f} KB)")
    print(f"  → sha256 of source TopoJSON: {digest}")
    if skipped:
        print(f"  → skipped {len(skipped)} non-state entries: {skipped}")


if __name__ == "__main__":
    main()
