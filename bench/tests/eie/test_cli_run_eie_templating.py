"""CLI subcommand `run-eie-templating` tests.

Uses typer's CliRunner to invoke the subcommand with run_scenario stubbed
out so no real LLM calls occur. We verify:
  1. The subcommand is registered and --help exits 0.
  2. --scenario all iterates over every YAML in the scenarios directory.
  3. --scenario <id> runs exactly that one scenario.
  4. --model override replaces cfg.model before calling run_scenario.
  5. Successful run exits 0 and prints the trace path.
  6. run_scenario exceptions surface as non-zero exit.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, call, patch

import pytest
from typer.testing import CliRunner

from agent_cost_bench.cli import app

runner = CliRunner()

SCENARIO_DIR = (
    Path(__file__).resolve().parents[2]  # bench/
    / "scenarios"
    / "eie-templating"
)
ALL_SCENARIO_IDS = sorted(p.stem for p in SCENARIO_DIR.glob("*.yml"))


# ---------------------------------------------------------------------------
# 1. subcommand is registered
# ---------------------------------------------------------------------------

def test_help_lists_subcommand():
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    assert "run-eie-templating" in result.output


def test_subcommand_help_exits_0():
    result = runner.invoke(app, ["run-eie-templating", "--help"])
    assert result.exit_code == 0


# ---------------------------------------------------------------------------
# 2. --scenario all runs all 6 scenarios
# ---------------------------------------------------------------------------

def test_all_scenarios_run(tmp_path):
    fake_paths = {sid: tmp_path / f"{sid}.trace.json" for sid in ALL_SCENARIO_IDS}
    for p in fake_paths.values():
        p.write_text("{}")

    with patch("agent_cost_bench.cli.run_eie_scenario") as mock_run:
        mock_run.side_effect = lambda cfg, **kwargs: fake_paths[cfg.id]
        result = runner.invoke(app, ["run-eie-templating", "--scenario", "all"])

    assert result.exit_code == 0, result.output
    assert mock_run.call_count == len(ALL_SCENARIO_IDS)
    for sid in ALL_SCENARIO_IDS:
        assert sid in result.output


# ---------------------------------------------------------------------------
# --recursion-limit threads through to run_scenario(max_turns=…)
# ---------------------------------------------------------------------------

def test_recursion_limit_threaded(tmp_path):
    sid = ALL_SCENARIO_IDS[0]
    fake_path = tmp_path / f"{sid}.trace.json"
    fake_path.write_text("{}")

    with patch("agent_cost_bench.cli.run_eie_scenario") as mock_run:
        mock_run.return_value = fake_path
        result = runner.invoke(
            app,
            ["run-eie-templating", "--scenario", sid, "--recursion-limit", "60"],
        )

    assert result.exit_code == 0, result.output
    assert mock_run.call_args.kwargs["max_turns"] == 60


def test_recursion_limit_defaults_to_30(tmp_path):
    sid = ALL_SCENARIO_IDS[0]
    fake_path = tmp_path / f"{sid}.trace.json"
    fake_path.write_text("{}")

    with patch("agent_cost_bench.cli.run_eie_scenario") as mock_run:
        mock_run.return_value = fake_path
        result = runner.invoke(app, ["run-eie-templating", "--scenario", sid])

    assert result.exit_code == 0, result.output
    assert mock_run.call_args.kwargs["max_turns"] == 30


# ---------------------------------------------------------------------------
# 3. --scenario <id> runs exactly one
# ---------------------------------------------------------------------------

def test_single_scenario_run(tmp_path):
    sid = ALL_SCENARIO_IDS[0]
    fake_path = tmp_path / f"{sid}.trace.json"
    fake_path.write_text("{}")

    with patch("agent_cost_bench.cli.run_eie_scenario") as mock_run:
        mock_run.return_value = fake_path
        result = runner.invoke(app, ["run-eie-templating", "--scenario", sid])

    assert result.exit_code == 0, result.output
    assert mock_run.call_count == 1
    called_cfg = mock_run.call_args[0][0]
    assert called_cfg.id == sid


# ---------------------------------------------------------------------------
# 4. --model override replaces cfg.model
# ---------------------------------------------------------------------------

def test_model_override(tmp_path):
    sid = ALL_SCENARIO_IDS[0]
    fake_path = tmp_path / f"{sid}.trace.json"
    fake_path.write_text("{}")

    with patch("agent_cost_bench.cli.run_eie_scenario") as mock_run:
        mock_run.return_value = fake_path
        result = runner.invoke(
            app,
            ["run-eie-templating", "--scenario", sid, "--model", "my-test-model"],
        )

    assert result.exit_code == 0, result.output
    called_cfg = mock_run.call_args[0][0]
    assert called_cfg.model == "my-test-model"


# ---------------------------------------------------------------------------
# 5. successful run prints trace path and exits 0
# ---------------------------------------------------------------------------

def test_output_printed(tmp_path):
    sid = ALL_SCENARIO_IDS[0]
    fake_path = tmp_path / f"{sid}.trace.json"
    fake_path.write_text("{}")

    with patch("agent_cost_bench.cli.run_eie_scenario", return_value=fake_path):
        result = runner.invoke(app, ["run-eie-templating", "--scenario", sid])

    assert result.exit_code == 0
    # Rich may line-wrap long paths; collapse whitespace before checking.
    collapsed = " ".join(result.output.split())
    assert fake_path.name in collapsed


# ---------------------------------------------------------------------------
# 6. run_scenario exception surfaces as non-zero exit
# ---------------------------------------------------------------------------

def test_run_scenario_exception_propagates(tmp_path):
    sid = ALL_SCENARIO_IDS[0]

    with patch(
        "agent_cost_bench.cli.run_eie_scenario",
        side_effect=RuntimeError("boom"),
    ):
        result = runner.invoke(app, ["run-eie-templating", "--scenario", sid])

    assert result.exit_code != 0
