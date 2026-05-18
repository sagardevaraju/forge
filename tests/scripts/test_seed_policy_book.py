"""Tests for scripts/seed_policy_book.py (Task 15)."""


def test_seeded_policies_have_synthetic_flag(tmp_path):
    from scripts.seed_policy_book import seed
    db_path = tmp_path / "test.db"
    seed(str(db_path), n=100)
    # query the db
    import sqlite3
    rows = sqlite3.connect(str(db_path)).execute("SELECT synthetic FROM policies LIMIT 5").fetchall()
    assert all(r[0] == 1 for r in rows)
