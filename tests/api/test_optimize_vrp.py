"""Task 17 — unit tests for the Operational VRP (adjuster staging)."""

from __future__ import annotations

from api_py.optimize_vrp import solve


def test_vrp_assigns_each_adjuster_each_day() -> None:
    """Every adjuster must be placed in exactly one zone every day."""
    result = solve(
        adjusters=[
            {
                "id": 1,
                "home_lat": 28.0,
                "home_lon": -82.5,
                "skills": ["wind"],
                "daily_capacity": 4,
            },
            {
                "id": 2,
                "home_lat": 28.0,
                "home_lon": -82.5,
                "skills": ["wind"],
                "daily_capacity": 4,
            },
        ],
        zones=[
            {
                "id": 100,
                "name": "Tampa",
                "lat": 27.9,
                "lon": -82.5,
                "capacity": 5,
                "required_skill": "wind",
                "expected_claim_volume": 50,
            },
            {
                "id": 101,
                "name": "Orlando",
                "lat": 28.5,
                "lon": -81.4,
                "capacity": 5,
                "required_skill": "wind",
                "expected_claim_volume": 30,
            },
        ],
        days=3,
    )
    assert result["status"] == "Optimal"
    # 2 adjusters × 3 days = 6 assignments
    assert len(result["assignments"]) == 6


def test_vrp_respects_skill_constraint() -> None:
    """Skill-mismatched assignments must never appear."""
    result = solve(
        adjusters=[
            {
                "id": 1,
                "home_lat": 28.0,
                "home_lon": -82.5,
                "skills": ["wind"],
                "daily_capacity": 4,
            },
            {
                "id": 2,
                "home_lat": 28.0,
                "home_lon": -82.5,
                "skills": ["flood"],
                "daily_capacity": 4,
            },
        ],
        zones=[
            {
                "id": 100,
                "name": "FloodCity",
                "lat": 27.9,
                "lon": -82.5,
                "capacity": 5,
                "required_skill": "flood",
                "expected_claim_volume": 100,
            },
            {
                "id": 101,
                "name": "WindCity",
                "lat": 28.5,
                "lon": -81.4,
                "capacity": 5,
                "required_skill": "wind",
                "expected_claim_volume": 100,
            },
        ],
        days=2,
    )
    assert result["status"] == "Optimal"
    # Wind adjuster -> WindCity only; flood adjuster -> FloodCity only.
    for a in result["assignments"]:
        if a["adjuster_id"] == 1:
            assert a["zone_id"] == 101
        if a["adjuster_id"] == 2:
            assert a["zone_id"] == 100


def test_vrp_drive_time_constraint() -> None:
    """An adjuster more than max_drive_hours away cannot be assigned to a zone."""
    result = solve(
        adjusters=[
            {
                "id": 1,
                "home_lat": 28.0,
                "home_lon": -82.5,
                "skills": ["wind"],
                "daily_capacity": 4,
            },  # FL home
        ],
        zones=[
            {
                "id": 100,
                "name": "NearbyFL",
                "lat": 28.5,
                "lon": -82.0,
                "capacity": 5,
                "required_skill": "wind",
                "expected_claim_volume": 50,
            },
            {
                "id": 200,
                "name": "DistantWA",
                "lat": 47.6,
                "lon": -122.3,
                "capacity": 5,
                "required_skill": "wind",
                "expected_claim_volume": 1000,
            },
        ],
        days=1,
        max_drive_hours=8.0,
    )
    assert result["status"] == "Optimal"
    for a in result["assignments"]:
        if a["adjuster_id"] == 1:
            assert a["zone_id"] == 100  # forced to the nearby zone
