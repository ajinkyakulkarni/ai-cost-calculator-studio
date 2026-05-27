"""Scenario YAMLs round-trip through the loader to typed config."""

from pathlib import Path
import pytest
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
