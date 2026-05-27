"""CLI subcommand `report-eie-templating` tests.

Uses typer's CliRunner with emit_report stubbed so no real trace files
are needed. We verify:
  1. The subcommand is registered and --help exits 0.
  2. Successful emit_report call exits 0 and prints the output path.
  3. emit_report exceptions surface as non-zero exit.
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from agent_cost_bench.cli import app

runner = CliRunner()


# ---------------------------------------------------------------------------
# 1. subcommand registration
# ---------------------------------------------------------------------------

def test_help_lists_report_subcommand():
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    assert "report-eie-templating" in result.output


def test_report_subcommand_help_exits_0():
    result = runner.invoke(app, ["report-eie-templating", "--help"])
    assert result.exit_code == 0


# ---------------------------------------------------------------------------
# 2. successful run prints output path
# ---------------------------------------------------------------------------

def test_report_prints_output_path(tmp_path):
    fake_out = tmp_path / "2026-05-26-summary.md"
    fake_out.write_text("# report")

    with patch("agent_cost_bench.eie.report.emit_report", return_value=fake_out):
        result = runner.invoke(app, ["report-eie-templating"])

    assert result.exit_code == 0, result.output
    collapsed = " ".join(result.output.split())
    assert fake_out.name in collapsed


# ---------------------------------------------------------------------------
# 3. emit_report exception propagates as non-zero exit
# ---------------------------------------------------------------------------

def test_report_exception_propagates():
    with patch(
        "agent_cost_bench.eie.report.emit_report",
        side_effect=RuntimeError("disk full"),
    ):
        result = runner.invoke(app, ["report-eie-templating"])

    assert result.exit_code != 0
