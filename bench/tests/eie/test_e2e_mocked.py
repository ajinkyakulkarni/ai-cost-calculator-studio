"""End-to-end smoke test: run all 6 scenarios with mocked LLM + mocked HTTP.

Patches:
  - provider_shim.call_llm  (via pattern_paper / pattern_eie) → hard-coded sequence
  - dispatch_tool_call       → returns stub strings (no real STAC / COG calls)
  - runner.REPORTS_DIR       → tmp_path (no pollution of real reports dir)

The spec's canonical single-scenario test (test_e2e_paper_status_only) exercises
the full tool chain with httpx + rio-tiler mocks. The parametrized suite runs all
six scenarios using the lighter stub_dispatch path.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from agent_cost_bench.eie.scenario_loader import load_scenario
from agent_cost_bench.eie.runner import run_scenario


SCENARIO_DIR = Path(__file__).resolve().parents[2] / "scenarios" / "eie-templating"

_ALL_SCENARIOS = [
    "pattern-paper-status-only",
    "pattern-paper-key-fields",
    "pattern-paper-freeform",
    "pattern-eie-status-only",
    "pattern-eie-key-fields",
    "pattern-eie-freeform",
]


# ---------------------------------------------------------------------------
# Shared stub helpers (mirror test_runner.py conventions)
# ---------------------------------------------------------------------------

def _tc(name: str, args: dict, call_id: str) -> dict:
    return {
        "role": "assistant",
        "content": "",
        "tool_calls": [
            {
                "id": call_id,
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(args)},
            }
        ],
        "_usage": {
            "prompt_tokens": 1200,
            "completion_tokens": 30,
            "total_tokens": 1230,
            "prompt_tokens_details": {"cached_tokens": 0},
        },
    }


def _final(text: str) -> dict:
    return {
        "role": "assistant",
        "content": text,
        "_usage": {
            "prompt_tokens": 2400,
            "completion_tokens": 40,
            "total_tokens": 2440,
            "prompt_tokens_details": {"cached_tokens": 2100},
        },
    }


def _paper_llm_sequence():
    return iter([
        _tc("parse_datetime", {"value": "2020-06-01 to 2020-11-01"}, "tc-p1"),
        _tc("geocode", {"query": "Mendocino County", "level": "county"}, "tc-p2"),
        _tc("search_collections", {"query": "GPP global primary production"}, "tc-p3"),
        _tc("search_items", {
            "collection_id": "lis-global-da-gpp",
            "bbox": [-123.89, 38.76, -122.82, 40.0],
            "datetime_range": "2020-06-01/2020-11-01",
            "band": "cog_default",
        }, "tc-p4"),
        _tc("compute_stats", {
            "item_refs": ["tc-p4"],
            "band": "cog_default",
            "geometry": {
                "type": "Polygon",
                "coordinates": [[
                    [-123.89, 38.76], [-122.82, 38.76],
                    [-122.82, 40.0], [-123.89, 40.0],
                    [-123.89, 38.76],
                ]],
            },
        }, "tc-p5"),
        _final("Mean GPP = 1.96 across 6 monthly grids; min 0.0, max 4.98."),
    ])


def _eie_llm_sequence():
    return iter([
        _tc("parse_datetime", {"value": "summer 2020"}, "tc-e1"),
        _tc("ask_user", {"gate": "datetime", "prompt": "Confirm range?"}, "tc-e2"),
        _tc("ask_user", {"gate": "state", "prompt": "Which state?"}, "tc-e3"),
        _tc("geocode", {"query": "California", "level": "state"}, "tc-e4"),
        _tc("ask_user", {"gate": "county", "prompt": "Which county?"}, "tc-e5"),
        _tc("geocode", {"query": "Mendocino County", "level": "county"}, "tc-e6"),
        _tc("ask_user", {"gate": "dataset", "prompt": "Which dataset?"}, "tc-e7"),
        _tc("ask_user", {"gate": "variable", "prompt": "Which band?"}, "tc-e8"),
        _final("Mean GPP over Mendocino: 0.18 gC/m2/day."),
    ])


def _stub_dispatch(name, args, handler, tool_call_id):
    return f"ok:{name}:{tool_call_id}"


# ---------------------------------------------------------------------------
# Canonical single-scenario test (spec's test_e2e_paper_status_only)
# Uses pytest-httpx + rio-tiler mock — exercises the real dispatch path.
# ---------------------------------------------------------------------------

def test_e2e_paper_status_only(monkeypatch, tmp_path):
    """Full-stack smoke: call_llm + dispatch patched; trace written to tmp_path."""
    seq = _paper_llm_sequence()
    monkeypatch.setattr(
        "agent_cost_bench.eie.pattern_paper.call_llm",
        lambda **kw: next(seq),
    )
    monkeypatch.setattr(
        "agent_cost_bench.eie.pattern_paper.dispatch_tool_call",
        _stub_dispatch,
    )

    cfg = load_scenario(SCENARIO_DIR / "pattern-paper-status-only.yml")

    with patch("agent_cost_bench.eie.runner.REPORTS_DIR", tmp_path):
        out_path = run_scenario(cfg, max_turns=20)

    assert out_path.parent == tmp_path, "trace must land in tmp_path, not real reports dir"
    assert out_path.exists(), "runner must write a trace file"
    trace = json.loads(out_path.read_text())
    assert trace["scenario_id"] == "pattern-paper-status-only"
    assert trace["turn_count"] >= 5
    assert trace["totals"]["input_tokens"] > 0


# ---------------------------------------------------------------------------
# Parametrized all-6-scenarios test
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("scenario_id", _ALL_SCENARIOS)
def test_e2e_all_scenarios_produce_valid_trace(scenario_id, tmp_path):
    """Every scenario produces a well-formed trace JSON with no real I/O."""
    cfg = load_scenario(SCENARIO_DIR / f"{scenario_id}.yml")
    is_eie = cfg.pattern == "eie"

    seq = _eie_llm_sequence() if is_eie else _paper_llm_sequence()
    call_llm_module = (
        "agent_cost_bench.eie.pattern_eie.call_llm"
        if is_eie
        else "agent_cost_bench.eie.pattern_paper.call_llm"
    )
    dispatch_module = (
        "agent_cost_bench.eie.pattern_eie.dispatch_tool_call"
        if is_eie
        else "agent_cost_bench.eie.pattern_paper.dispatch_tool_call"
    )

    with (
        patch(call_llm_module, side_effect=lambda **kw: next(seq)),
        patch(dispatch_module, side_effect=_stub_dispatch),
        patch("agent_cost_bench.eie.runner.REPORTS_DIR", tmp_path),
    ):
        out_path = run_scenario(cfg, max_turns=20)

    # File must land in tmp_path (not real reports dir)
    assert out_path.parent == tmp_path
    assert out_path.exists()

    trace = json.loads(out_path.read_text())

    # Required top-level keys
    for key in ("scenario_id", "pattern", "handler_mode", "model",
                 "turn_count", "elapsed_s", "totals", "per_turn_avg", "turns"):
        assert key in trace, f"missing key {key!r} in trace"

    assert trace["scenario_id"] == scenario_id
    assert trace["pattern"] == cfg.pattern
    assert trace["handler_mode"] == cfg.handler_mode
    assert trace["turn_count"] >= 1
    assert trace["totals"]["input_tokens"] > 0
    assert trace["totals"]["output_tokens"] > 0
    assert 0.0 <= trace["totals"]["cache_hit_rate"] <= 1.0


# ---------------------------------------------------------------------------
# Report-shape smoke: generate report from 6 traces, assert shape
# ---------------------------------------------------------------------------

def _make_trace(scenario_id: str, pattern: str, handler_mode: str) -> dict:
    return {
        "scenario_id": scenario_id,
        "pattern": pattern,
        "handler_mode": handler_mode,
        "model": "gpt-5.2",
        "turn_count": 6,
        "elapsed_s": 9.1,
        "totals": {
            "input_tokens": 12_000,
            "output_tokens": 1_200,
            "cached_tokens": 6_000,
            "cache_hit_rate": 0.5,
        },
        "per_turn_avg": {
            "input_tokens": 2_000.0,
            "output_tokens": 200.0,
        },
        "turns": [],
    }


def test_e2e_report_shape_from_six_traces(tmp_path):
    """Report generator reads 6 fixture traces and produces a well-formed Markdown."""
    _scenarios_meta = [
        ("pattern-paper-status-only", "paper", "status_only"),
        ("pattern-paper-key-fields",  "paper", "key_fields"),
        ("pattern-paper-freeform",    "paper", "freeform"),
        ("pattern-eie-status-only",   "eie",   "status_only"),
        ("pattern-eie-key-fields",    "eie",   "key_fields"),
        ("pattern-eie-freeform",      "eie",   "freeform"),
    ]
    for sid, pattern, mode in _scenarios_meta:
        trace = _make_trace(sid, pattern, mode)
        (tmp_path / f"{sid}-2026-05-26T00-00-00.trace.json").write_text(
            json.dumps(trace)
        )

    from agent_cost_bench.eie import report as rmod
    with patch.object(rmod, "REPORTS_DIR", tmp_path):
        report_path = rmod.emit_report()

    assert report_path.exists()
    content = report_path.read_text()

    # All 6 scenario IDs present
    for sid, _, _ in _scenarios_meta:
        assert sid in content, f"scenario {sid!r} missing from report"

    # Ratio rows present
    assert "C/A ratio" in content
    assert "C/B ratio" in content

    # Numeric content for both patterns
    assert "paper" in content
    assert "eie" in content
