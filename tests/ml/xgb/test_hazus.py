from ml.xgb.hazus_curves import wind_damage_ratio, surge_damage_ratio


def test_wind_below_threshold_zero():
    assert wind_damage_ratio(75, "wood_frame") == 0.0


def test_wind_manufactured_more_vulnerable_than_masonry():
    assert wind_damage_ratio(110, "manufactured") > wind_damage_ratio(110, "masonry")


def test_wind_monotonic_in_speed():
    speeds = [80, 100, 120, 140, 160, 180]
    ratios = [wind_damage_ratio(s, "wood_frame") for s in speeds]
    assert ratios == sorted(ratios)


def test_surge_zero_when_below_elevation():
    assert surge_damage_ratio(1.0, elevation_m=2.0) == 0.0


def test_surge_caps_at_high_water():
    assert surge_damage_ratio(10.0, elevation_m=0.0) > 0.9
