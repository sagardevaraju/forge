import pytest
from pathlib import Path

EVAL_RESULTS = Path(__file__).resolve().parents[2] / "eval" / "results"

@pytest.mark.skipif(not (EVAL_RESULTS / "component_metrics.json").exists(),
                    reason="component_metrics.json not generated yet")
def test_component_metrics_has_three_blocks():
    import json
    data = json.loads((EVAL_RESULTS / "component_metrics.json").read_text())
    assert "cv_head" in data
    assert "xgb_loss_model" in data
    assert "scenario_loglik" in data

@pytest.mark.skipif(not (EVAL_RESULTS / "end_to_end.json").exists(),
                    reason="end_to_end.json not generated yet")
def test_end_to_end_has_per_event_records():
    import json
    data = json.loads((EVAL_RESULTS / "end_to_end.json").read_text())
    assert "events" in data and len(data["events"]) >= 1
    assert "summary" in data
    for event in data["events"]:
        assert "event_id" in event and "forge_pnl" in event and "baseline_pnl" in event
