"""Task P3.26 — Controlled user-study protocol contract tests.

Pins the required sections of `docs/USER_STUDY_PROTOCOL.md` so a
future edit doesn't quietly drop a primary hypothesis, the n=20
sample-size constraint, or the OSF manual-follow-up section.
"""

from __future__ import annotations

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PROTOCOL = REPO_ROOT / "docs" / "USER_STUDY_PROTOCOL.md"


def _read() -> str:
    if not PROTOCOL.exists():
        pytest.skip("USER_STUDY_PROTOCOL.md missing — P3.26 not landed yet?")
    return PROTOCOL.read_text()


def test_protocol_exists():
    assert PROTOCOL.exists()


def test_protocol_is_within_subjects_design():
    """Plan default: within-subject 20 participants."""
    text = _read()
    assert "within-subjects" in text.lower() or "within subjects" in text.lower()


def test_protocol_pins_sample_size_20():
    """Plan default: n=20 participants."""
    text = _read()
    assert "n = 20" in text or "n=20" in text or "20 participants" in text


def test_protocol_has_primary_hypotheses():
    """Two primary hypotheses: confidence + completion time."""
    text = _read()
    assert "H1" in text
    assert "H2" in text
    assert "confidence" in text.lower()
    assert "completion" in text.lower() or "time" in text.lower()


def test_protocol_defines_treatment_and_control():
    """Treatment = scenario-coupled; Control = independent scenarios."""
    text = _read()
    assert "Treatment" in text
    assert "Control" in text
    assert "scenario-coupled" in text or "coupled" in text


def test_protocol_lists_standardised_tasks():
    """Four standardised decision tasks T1-T4."""
    text = _read()
    for marker in ("T1", "T2", "T3", "T4"):
        assert marker in text, f"missing task marker {marker}"


def test_protocol_pins_alpha_and_power():
    """Pre-registered α = 0.05 + power 0.80 (Cohen's d ≈ 0.67)."""
    text = _read()
    assert "0.05" in text
    assert "0.80" in text or "power 0.8" in text


def test_protocol_documents_analysis_plan():
    text = _read()
    assert "Wilcoxon" in text or "paired" in text.lower()
    assert "Analysis" in text


def test_protocol_documents_ethics():
    text = _read()
    assert "Ethics" in text or "ethics" in text
    assert "consent" in text.lower()


def test_protocol_documents_preregistration_scope_decision():
    """Pre-2026-05-24 the protocol carried a 'Manual follow-up for Sagar'
    section linking to an OSF paste-buffer. The protocol was rescoped to
    a design document (no OSF submission) when FORGE was committed as a
    portfolio project rather than a paper-pipeline submission. The doc
    must still explain *why* OSF is not filed so the decision is auditable.
    """
    text = _read()
    assert "Pre-registration scope" in text or "not formally pre-registered" in text
    # Doc must explain it's a committed design artifact, not a paper-pipeline
    # submission. Markdown linebreaks ('design\n> document') would beat a
    # naive substring search, so check the salient nouns independently.
    lc = text.lower()
    assert "design" in lc and ("document" in lc or "protocol" in lc)
    # OSF is still mentioned as 'reference for future use' if FORGE moves
    # toward an academic submission — make sure the door isn't slammed.
    assert "OSF" in text


def test_protocol_documents_reconciler_signal():
    """H3 uses lib/reconciler/index.ts manual_reversal_required as
    the decision-quality regret proxy — this is the FORGE-specific
    anchor that justifies why this study can be done on FORGE."""
    text = _read()
    assert "reconciler" in text.lower()
    assert "manual_reversal_required" in text or "manual reversal" in text.lower()
