from scripts.ingest_storm_events import parse_damage_property


def test_parse_millions():
    assert parse_damage_property("5.00M") == 5_000_000


def test_parse_thousands():
    assert parse_damage_property("300K") == 300_000


def test_parse_billions():
    assert parse_damage_property("1.5B") == 1_500_000_000


def test_parse_empty_returns_none():
    assert parse_damage_property("") is None


def test_parse_zero():
    assert parse_damage_property("0.00K") == 0
