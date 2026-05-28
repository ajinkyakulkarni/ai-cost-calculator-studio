"""Tests for eie/report.py — report generator.

Uses fixture trace JSONs written to tmp_path; does not require real LLM runs.
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_SCENARIOS = [
    ("pattern-paper-status-only", "paper", "status_only"),
    ("pattern-paper-key-fields",  "paper", "key_fields"),
    ("pattern-paper-freeform",    "paper", "freeform"),
    ("pattern-eie-status-only",   "eie",   "status_only"),
    ("pattern-eie-key-fields",    "eie",   "key_fields"),
    ("pattern-eie-freeform",      "eie",   "freeform"),
]


def _make_trace(scenario_id: str, pattern: str, handler_mode: str, *,
                input_tokens: int = 10_000,
                output_tokens: int = 1_000,
                cached_tokens: int = 5_000,
                turn_count: int = 5) -> dict:
    n = turn_count or 1
    cache_hit_rate = cached_tokens / input_tokens if input_tokens else 0.0
    return {
        "scenario_id": scenario_id,
        "pattern": pattern,
        "handler_mode": handler_mode,
        "model": "gpt-5.2",
        "turn_count": turn_count,
        "elapsed_s": 12.3,
        "totals": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cached_tokens": cached_tokens,
            "cache_hit_rate": cache_hit_rate,
        },
        "per_turn_avg": {
            "input_tokens": input_tokens / n,
            "output_tokens": output_tokens / n,
        },
        "turns": [],
    }


@pytest.fixture()
def reports_dir(tmp_path) -> Path:
    """Populate tmp_path with 6 fixture trace JSONs and return the dir."""
    for sid, pattern, mode in _SCENARIOS:
        trace = _make_trace(sid, pattern, mode)
        (tmp_path / f"{sid}-2026-05-26T00-00-00.trace.json").write_text(
            json.dumps(trace)
        )
    return tmp_path


# ---------------------------------------------------------------------------
# 1. _latest_traces returns one trace per scenario_id
# ---------------------------------------------------------------------------

def test_latest_traces_returns_six(reports_dir):
    from agent_cost_bench.eie import report as rmod

    with patch.object(rmod, "REPORTS_DIR", reports_dir):
        traces = rmod._latest_traces()

    assert len(traces) == 6
    for sid, _, _ in _SCENARIOS:
        assert (sid, False, False) in traces


def test_latest_traces_picks_newer_file(tmp_path):
    """When two files share a scenario_id, the newer mtime wins."""
    import time
    from agent_cost_bench.eie import report as rmod

    sid = "pattern-paper-status-only"
    old_trace = _make_trace(sid, "paper", "status_only", input_tokens=1_000)
    new_trace = _make_trace(sid, "paper", "status_only", input_tokens=9_999)

    old_file = tmp_path / f"{sid}-2026-05-25T00-00-00.trace.json"
    old_file.write_text(json.dumps(old_trace))
    # Ensure mtime ordering is obvious
    time.sleep(0.01)
    new_file = tmp_path / f"{sid}-2026-05-26T00-00-00.trace.json"
    new_file.write_text(json.dumps(new_trace))

    with patch.object(rmod, "REPORTS_DIR", tmp_path):
        traces = rmod._latest_traces()

    assert traces[(sid, False, False)]["totals"]["input_tokens"] == 9_999


def test_latest_traces_skips_malformed(tmp_path):
    (tmp_path / "bad.trace.json").write_text("not json{{")
    from agent_cost_bench.eie import report as rmod

    with patch.object(rmod, "REPORTS_DIR", tmp_path):
        traces = rmod._latest_traces()

    assert traces == {}


# ---------------------------------------------------------------------------
# 2. _cost_per_query produces expected value
# ---------------------------------------------------------------------------

def test_cost_per_query_formula():
    """Spot-check the cost formula against manually computed values."""
    from agent_cost_bench.eie.report import (
        _cost_per_query,
        GPT52_INPUT_PER_M,
        GPT52_CACHED_PER_M,
        GPT52_OUTPUT_PER_M,
    )

    t = _make_trace("x", "paper", "status_only",
                    input_tokens=10_000, output_tokens=2_000, cached_tokens=4_000)
    fresh = 10_000 - 4_000  # 6_000
    expected = (
        fresh   * GPT52_INPUT_PER_M  / 1e6
        + 4_000 * GPT52_CACHED_PER_M / 1e6
        + 2_000 * GPT52_OUTPUT_PER_M / 1e6
    )
    assert abs(_cost_per_query(t) - expected) < 1e-9


def test_cost_per_query_zero_tokens():
    """Zero tokens → zero cost (no division by zero)."""
    from agent_cost_bench.eie.report import _cost_per_query

    t = _make_trace("x", "paper", "status_only",
                    input_tokens=0, output_tokens=0, cached_tokens=0)
    assert _cost_per_query(t) == 0.0


# ---------------------------------------------------------------------------
# 3. emit_report writes a Markdown file with expected content
# ---------------------------------------------------------------------------

def test_emit_report_creates_file(reports_dir):
    from agent_cost_bench.eie import report as rmod

    with patch.object(rmod, "REPORTS_DIR", reports_dir):
        out = rmod.emit_report()

    assert out.exists()
    assert out.suffix == ".md"


def test_emit_report_contains_all_scenario_ids(reports_dir):
    from agent_cost_bench.eie import report as rmod

    with patch.object(rmod, "REPORTS_DIR", reports_dir):
        out = rmod.emit_report()

    content = out.read_text()
    for sid, _, _ in _SCENARIOS:
        assert sid in content, f"scenario {sid!r} missing from report"


def test_emit_report_uses_fixed_descriptive_filename(reports_dir):
    from agent_cost_bench.eie import report as rmod

    with patch.object(rmod, "REPORTS_DIR", reports_dir):
        out = rmod.emit_report()

    # Not date-stamped — a single durable, descriptively-named report.
    assert out.name == "eie-templating-bench-report.md"


def test_emit_report_preserves_handwritten_findings(reports_dir):
    """Regenerating must not clobber a hand-written Findings section."""
    from agent_cost_bench.eie import report as rmod

    with patch.object(rmod, "REPORTS_DIR", reports_dir):
        out = rmod.emit_report()  # first pass → placeholder findings
        # Replace the placeholder with hand-written analysis.
        text = out.read_text()
        head = text[: text.find("## Findings")]
        out.write_text(head + "## Findings\n\nThe lever is ~3-6x, not 7.5x.\n")
        # Regenerate — tables rebuild, but findings must survive.
        rmod.emit_report()

    final = out.read_text()
    assert "The lever is ~3-6x, not 7.5x." in final
    assert "this report builder leaves the" not in final


def test_emit_report_contains_ratio_rows(reports_dir):
    from agent_cost_bench.eie import report as rmod

    with patch.object(rmod, "REPORTS_DIR", reports_dir):
        out = rmod.emit_report()

    content = out.read_text()
    # Both patterns should have ratio rows
    assert "C/A ratio" in content
    assert "C/B ratio" in content


def test_emit_report_table_has_header(reports_dir):
    from agent_cost_bench.eie import report as rmod

    with patch.object(rmod, "REPORTS_DIR", reports_dir):
        out = rmod.emit_report()

    content = out.read_text()
    assert "cache hit %" in content
    assert "$/query" in content
    assert "$/month" in content


def test_emit_report_ratio_ordering(reports_dir):
    """C is freeform — highest-cost mode; A is status_only — lowest cost.

    With equal token counts across all modes, C/A == C/B == 1.0.
    But we just verify both ratios are present and parseable as floats.
    """
    from agent_cost_bench.eie import report as rmod
    import re

    with patch.object(rmod, "REPORTS_DIR", reports_dir):
        out = rmod.emit_report()

    content = out.read_text()
    ratios = re.findall(r"([\d.]+)×", content)
    assert len(ratios) >= 4  # 2 patterns × 2 ratios (C/A, C/B)
    for r in ratios:
        float(r)  # must be parseable


def test_emit_report_empty_dir(tmp_path):
    """emit_report on an empty directory should not crash; it writes an empty table."""
    from agent_cost_bench.eie import report as rmod

    with patch.object(rmod, "REPORTS_DIR", tmp_path):
        out = rmod.emit_report()

    assert out.exists()


# ---------------------------------------------------------------------------
# 4. emit_report returns path inside REPORTS_DIR
# ---------------------------------------------------------------------------

def test_emit_report_path_in_reports_dir(reports_dir):
    from agent_cost_bench.eie import report as rmod

    with patch.object(rmod, "REPORTS_DIR", reports_dir):
        out = rmod.emit_report()

    assert out.parent == reports_dir


# ---------------------------------------------------------------------------
# 5. enforce_compute_stats: natural and forced variants produce two rows
# ---------------------------------------------------------------------------

def _make_trace_forced(scenario_id: str, pattern: str, handler_mode: str,
                       enforce_compute_stats: bool, **kwargs) -> dict:
    """Like _make_trace but with enforce_compute_stats field."""
    t = _make_trace(scenario_id, pattern, handler_mode, **kwargs)
    t["enforce_compute_stats"] = enforce_compute_stats
    return t


def test_latest_traces_two_variants_produce_two_entries(tmp_path):
    """Natural and forced variants of same scenario_id are NOT collapsed."""
    from agent_cost_bench.eie import report as rmod

    sid = "pattern-paper-status-only"
    natural = _make_trace_forced(sid, "paper", "status_only", False, input_tokens=1_000)
    forced = _make_trace_forced(sid, "paper", "status_only", True, input_tokens=2_000)

    (tmp_path / f"{sid}-natural-2026-05-26T00-00-00.trace.json").write_text(
        json.dumps(natural)
    )
    (tmp_path / f"{sid}-forced-2026-05-26T00-00-00.trace.json").write_text(
        json.dumps(forced)
    )

    with patch.object(rmod, "REPORTS_DIR", tmp_path):
        traces = rmod._latest_traces()

    # Must produce two distinct entries, not one
    assert len(traces) == 2
    keys = list(traces.keys())
    assert (sid, False, False) in keys
    assert (sid, True, False) in keys


def test_emit_report_two_variants_produce_two_rows(tmp_path):
    """Report table has one row per (scenario, mode) pair."""
    from agent_cost_bench.eie import report as rmod

    sid = "pattern-paper-status-only"
    natural = _make_trace_forced(sid, "paper", "status_only", False)
    forced = _make_trace_forced(sid, "paper", "status_only", True)

    (tmp_path / f"{sid}-natural.trace.json").write_text(json.dumps(natural))
    (tmp_path / f"{sid}-forced.trace.json").write_text(json.dumps(forced))

    with patch.object(rmod, "REPORTS_DIR", tmp_path):
        out = rmod.emit_report()

    content = out.read_text()
    # Both N and Y must appear in the forced column
    assert "| N |" in content or "|N|" in content or " N " in content
    assert "| Y |" in content or "|Y|" in content or " Y " in content
    # scenario_id appears twice (once per row)
    assert content.count(sid) >= 2


def test_emit_report_forced_column_present(tmp_path):
    """Report header contains 'forced' column."""
    from agent_cost_bench.eie import report as rmod

    sid = "pattern-paper-status-only"
    natural = _make_trace_forced(sid, "paper", "status_only", False)
    (tmp_path / f"{sid}-natural.trace.json").write_text(json.dumps(natural))

    with patch.object(rmod, "REPORTS_DIR", tmp_path):
        out = rmod.emit_report()

    content = out.read_text()
    assert "forced" in content.lower()


def test_latest_traces_backward_compat_no_field(tmp_path):
    """Old traces without enforce_compute_stats key are treated as natural (False)."""
    from agent_cost_bench.eie import report as rmod

    sid = "pattern-paper-freeform"
    # Old-style trace without the new field
    old_trace = _make_trace(sid, "paper", "freeform")  # no enforce_compute_stats key
    (tmp_path / f"{sid}-old.trace.json").write_text(json.dumps(old_trace))

    with patch.object(rmod, "REPORTS_DIR", tmp_path):
        traces = rmod._latest_traces()

    assert len(traces) == 1
    assert (sid, False, False) in traces
