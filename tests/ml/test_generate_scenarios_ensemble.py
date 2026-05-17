"""Task P2.38 — generate_scenarios accepts an ensemble seed.

The Monte-Carlo scenario generator now supports two input distributions:

* ``ensemble=None`` (default): parametric Gaussian perturbation around the
  built-in Cat-4 demo track. This is the historical behaviour and must
  remain bit-exactly reproducible — existing callers don't pass ``ensemble``
  and don't tolerate a change in their RNG sequence.
* ``ensemble=[{member_id, track: [{lat, lng, t_hours, peak_wind}]}]``: real
  GEFS ensemble members served by ``fetch_nhc_cone`` (Task P2.38). Each
  scenario is seeded from one member (resampled uniformly to reach ``n``).

The tests below pin the backward-compat invariant, the resampling
behaviour, and the empty-ensemble fallback.
"""

from __future__ import annotations

from ml.scenarios.generate import generate_scenarios


def _mock_ensemble(num_members: int = 20) -> list[dict]:
    """Build a synthetic ensemble with ``num_members`` deterministic
    members. Each member's track is a 5-point line shifted by member
    index so the resulting scenarios end up with distinguishable paths.
    """
    members = []
    for i in range(num_members):
        offset = (i - num_members / 2) * 0.15
        track = [
            {
                "lat": 24.0 + 0.5 * k + offset * 0.5,
                "lng": -83.0 + 0.3 * k + offset,
                "t_hours": k * 24,
                "peak_wind": 120.0 + i,  # member-unique peak so we can detect resampling
            }
            for k in range(5)
        ]
        members.append({"member_id": f"AC{i + 1:02d}", "track": track})
    return members


def test_generate_without_ensemble_uses_parametric_path():
    """Backward-compat: ``ensemble=None`` must produce the same output as
    the historical ``generate_scenarios(...)`` (Task 12 parametric path)."""
    legacy = generate_scenarios(storm_id="AL092024", n=50)
    new = generate_scenarios(storm_id="AL092024", n=50, ensemble=None)
    assert len(new) == len(legacy) == 50
    # Same RNG seed + same code path ⇒ bit-exact tracks + peak winds.
    for a, b in zip(legacy, new):
        assert a["path"] == b["path"]
        assert a["peak_wind"] == b["peak_wind"]
        assert a["id"] == b["id"]


def test_generate_with_ensemble_returns_n_scenarios():
    """``ensemble=members`` must still emit ``n`` scenarios (resampled)."""
    members = _mock_ensemble(num_members=20)
    scs = generate_scenarios(storm_id="AL092024", n=100, ensemble=members)
    assert len(scs) == 100
    for s in scs:
        assert {"id", "path", "peak_wind", "surge_grid", "prob"}.issubset(s.keys())
        assert isinstance(s["path"], list)
        assert len(s["path"]) >= 1
        assert isinstance(s["peak_wind"], (int, float))
        # probability weights still sum to 1.
    total = sum(s["prob"] for s in scs)
    assert abs(total - 1.0) < 1e-6


def test_generate_with_ensemble_records_member_id():
    """Each ensemble-seeded scenario records which member it was drawn
    from so downstream consumers can group by member if needed."""
    members = _mock_ensemble(num_members=5)
    scs = generate_scenarios(storm_id="AL092024", n=25, ensemble=members)
    member_ids = {s.get("member_id") for s in scs}
    # Every scenario should carry a member_id, and the set should be
    # a subset of the input ensemble's member_ids.
    assert None not in member_ids
    input_ids = {m["member_id"] for m in members}
    assert member_ids.issubset(input_ids)
    # With n=25 and 5 members, we expect uniform-ish coverage — at least
    # 2 distinct members must show up.
    assert len(member_ids) >= 2


def test_generate_n1000_with_20_members_resamples_uniformly():
    """With ``n`` >> num_members, the resampling should hit every member."""
    members = _mock_ensemble(num_members=20)
    scs = generate_scenarios(storm_id="AL092024", n=1000, ensemble=members)
    counts: dict[str, int] = {}
    for s in scs:
        mid = s["member_id"]
        counts[mid] = counts.get(mid, 0) + 1
    # All 20 members must have been sampled at least once.
    assert len(counts) == 20, f"Expected 20 members sampled, got {len(counts)}"
    # Uniform-ish: each member roughly 1000/20=50 draws. Allow 25..100.
    for mid, c in counts.items():
        assert 25 <= c <= 100, f"Member {mid} got {c} draws (expected uniform)"


def test_generate_with_empty_ensemble_falls_back_to_parametric():
    """An empty ensemble list should fall back to the parametric path
    rather than crash or return an empty scenario set."""
    legacy = generate_scenarios(storm_id="AL092024", n=20)
    fallback = generate_scenarios(storm_id="AL092024", n=20, ensemble=[])
    assert len(fallback) == 20
    for a, b in zip(legacy, fallback):
        assert a["path"] == b["path"]
        assert a["peak_wind"] == b["peak_wind"]


def test_generate_with_ensemble_uses_member_track_coordinates():
    """Ensemble-derived scenarios should reflect the member tracks (with
    optional perturbation), NOT the built-in FL demo track. A member
    placed near the equator should yield scenarios near the equator."""
    members = [
        {
            "member_id": "AC01",
            "track": [
                {"lat": 0.0, "lng": -50.0, "t_hours": 0, "peak_wind": 100.0},
                {"lat": 0.5, "lng": -49.5, "t_hours": 12, "peak_wind": 105.0},
            ],
        },
    ]
    scs = generate_scenarios(storm_id="AL092024", n=10, ensemble=members)
    for s in scs:
        # Track points must be in the neighbourhood of the input member.
        # Allow generous slack for any perturbation jitter the implementation
        # adds on top.
        assert abs(s["path"][0]["lat"] - 0.0) < 5.0
        assert abs(s["path"][0]["lon"] - -50.0) < 5.0


def test_generate_with_ensemble_keeps_probabilities_normalised():
    members = _mock_ensemble(num_members=3)
    scs = generate_scenarios(storm_id="AL092024", n=37, ensemble=members)
    total = sum(s["prob"] for s in scs)
    assert abs(total - 1.0) < 1e-6
