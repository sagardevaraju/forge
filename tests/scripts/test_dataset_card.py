"""Task P3.25 — DOI'd dataset card contract tests.

Pins the structural sections of `docs/DATASET_CARD.md` so a future
edit doesn't quietly drop a Gebru-et-al-2018 datasheet section or
forget the DOI placeholder convention.
"""

from __future__ import annotations

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
CARD_PATH = REPO_ROOT / "docs" / "DATASET_CARD.md"


def _read_card() -> str:
    if not CARD_PATH.exists():
        pytest.skip("DATASET_CARD.md missing — P3.25 not landed yet?")
    return CARD_PATH.read_text()


def test_dataset_card_exists():
    assert CARD_PATH.exists(), "docs/DATASET_CARD.md must exist"


def test_dataset_card_has_yaml_front_matter():
    """First fenced YAML block must carry title / version / license / doi."""
    text = _read_card()
    assert "title:" in text
    assert "version:" in text
    assert "license:" in text
    assert "doi:" in text
    assert "authors:" in text


def test_dataset_card_has_cc_by_4_0_license():
    text = _read_card()
    assert "CC-BY-4.0" in text or "Creative Commons Attribution 4.0" in text


def test_dataset_card_carries_real_zenodo_doi():
    """DOI must be the real Zenodo DOI minted on the v0.1.0 release
    (no longer a TBD placeholder)."""
    text = _read_card()
    assert "10.5281/zenodo." in text, "no Zenodo DOI in dataset card"
    # The version-DOI digits are committed verbatim — surfaces typos in
    # the paste-back step.
    assert "10.5281/zenodo.20368096" in text


def test_dataset_card_lists_artifacts():
    """Every committed artifact mentioned in CLAUDE.md must appear in
    the dataset card's composition table."""
    text = _read_card()
    for artifact in (
        "calibration.json",
        "portfolio_optimization.json",
        "treaty.json",
        "hurdat2",
        "regime",
    ):
        assert artifact in text, f"missing artifact reference: {artifact}"


def test_dataset_card_has_gebru_datasheet_sections():
    """Gebru et al. 2018 'Datasheets for Datasets' six headers."""
    text = _read_card()
    for section in (
        "Motivation",
        "Composition",
        "Collection process",
        "Preprocessing",
        "Uses",
        "Distribution",
        "Maintenance",
    ):
        assert section in text, f"missing Gebru datasheet section: {section}"


def test_dataset_card_documents_zip3_geography_caveat():
    """The synthetic zip3 / lat-lon independence is critical to
    document — see CLAUDE.md and the [[zip3-geography]] memory."""
    text = _read_card()
    assert "zip3" in text or "ZIP3" in text
    assert "no real-world" in text or "label" in text


def test_dataset_card_includes_bibtex_citation():
    text = _read_card()
    assert "@dataset{" in text
    assert "Devaraju" in text


def test_dataset_card_documents_not_recommended_uses():
    """Honesty contract: dataset card MUST document inappropriate uses."""
    text = _read_card()
    assert "NOT recommended" in text or "Not recommended" in text
    # The three classic anti-uses for synthetic data
    assert "production" in text.lower()
    assert "regulatory" in text.lower()


def test_dataset_card_has_release_history():
    """Post-v0.1.0 the 'Manual follow-up' section was replaced with
    a 'Release history' block tracking minted DOIs."""
    text = _read_card()
    assert "Release history" in text
    assert "v0.1.0" in text
    assert "Zenodo" in text
