"""Scenario YAMLs round-trip through the loader to typed config."""

from dataclasses import replace
from pathlib import Path
from agent_cost_bench.eie.scenario_loader import load_scenario, ScenarioCfg

SCENARIO_DIR = Path(__file__).resolve().parents[2] / "scenarios" / "eie-templating"


def test_all_six_scenarios_load():
    expected_ids = [
        "pattern-paper-status-only",
        "pattern-paper-key-fields",
        "pattern-paper-freeform",
        "pattern-eie-status-only",
        "pattern-eie-key-fields",
        "pattern-eie-freeform",
    ]
    for sid in expected_ids:
        s = load_scenario(SCENARIO_DIR / f"{sid}.yml")
        assert isinstance(s, ScenarioCfg)
        assert s.id == sid
        assert s.handler_mode in ("status_only", "key_fields", "freeform")
        assert s.pattern in ("paper", "eie")
        assert s.model.startswith("gpt-")


# ---------------------------------------------------------------------------
# enforce_compute_stats field
# ---------------------------------------------------------------------------

def test_enforce_compute_stats_defaults_false():
    """ScenarioCfg without enforce_compute_stats set defaults to False."""
    cfg = ScenarioCfg(
        id="test",
        pattern="paper",
        handler_mode="status_only",
        model="gpt-stub",
        description="test",
    )
    assert cfg.enforce_compute_stats is False


def test_enforce_compute_stats_roundtrips_true():
    """ScenarioCfg with enforce_compute_stats=True retains the value."""
    cfg = ScenarioCfg(
        id="test",
        pattern="paper",
        handler_mode="status_only",
        model="gpt-stub",
        description="test",
        enforce_compute_stats=True,
    )
    assert cfg.enforce_compute_stats is True


def test_enforce_compute_stats_dataclass_replace():
    """dataclasses.replace works correctly with the new field."""
    cfg = ScenarioCfg(
        id="test",
        pattern="paper",
        handler_mode="status_only",
        model="gpt-stub",
        description="test",
    )
    assert cfg.enforce_compute_stats is False
    forced = replace(cfg, enforce_compute_stats=True)
    assert forced.enforce_compute_stats is True
    # Original unchanged
    assert cfg.enforce_compute_stats is False


def test_load_scenario_enforce_compute_stats_defaults_false_from_yaml():
    """Existing YAMLs without the field load with enforce_compute_stats=False."""
    s = load_scenario(SCENARIO_DIR / "pattern-paper-status-only.yml")
    assert s.enforce_compute_stats is False
