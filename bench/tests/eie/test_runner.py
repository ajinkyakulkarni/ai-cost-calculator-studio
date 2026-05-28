"""Scenario runner — glues ScenarioCfg + pattern + handler into a trace JSON.

Tests stub both call_llm and dispatch_tool_call so no real provider or
STAC calls happen. We verify:
  1. run_scenario returns a valid Path to a .trace.json file.
  2. The trace JSON has the expected top-level keys.
  3. Token totals aggregate correctly from per-turn _usage data.
  4. Pattern 'paper' and pattern 'eie' both route to the right graph.
  5. Unknown pattern / unknown handler_mode raise ValueError.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from agent_cost_bench.eie.scenario_loader import ScenarioCfg
from agent_cost_bench.eie.runner import run_scenario


# ---------------------------------------------------------------------------
# Shared stub helpers
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
            "prompt_tokens": 20,
            "completion_tokens": 8,
            "total_tokens": 28,
            "prompt_tokens_details": {"cached_tokens": 5},
        },
    }


def _final(text: str) -> dict:
    return {
        "role": "assistant",
        "content": text,
        "_usage": {
            "prompt_tokens": 60,
            "completion_tokens": 40,
            "total_tokens": 100,
            "prompt_tokens_details": {"cached_tokens": 20},
        },
    }


def _paper_stub_responses():
    return [
        _tc("parse_datetime", {"value": "June 2020"}, "tc-1"),
        _tc("geocode", {"query": "mendocino", "level": "county"}, "tc-2"),
        _tc("search_collections", {"query": "global primary production"}, "tc-3"),
        _tc("search_items", {"collection_id": "lis-global-da-gpp",
                              "bbox": [-124, 38, -122, 40],
                              "datetime_range": "2020-06/2020-11"}, "tc-4"),
        _tc("compute_stats", {"item_refs": [], "band": "cog_default",
                               "geometry": {"type": "Polygon", "coordinates": []}}, "tc-5"),
        _final("Mean GPP: 0.12 gC/m2/day."),
    ]


def _eie_stub_responses():
    return [
        _tc("parse_datetime", {"value": "summer 2020"}, "tc-e1"),
        _tc("ask_user", {"gate": "datetime", "prompt": "Confirm range?"}, "tc-e2"),
        _tc("ask_user", {"gate": "state", "prompt": "Which state?"}, "tc-e3"),
        _tc("geocode", {"query": "California", "level": "state"}, "tc-e4"),
        _tc("ask_user", {"gate": "county", "prompt": "Which county?"}, "tc-e5"),
        _tc("geocode", {"query": "Mendocino County", "level": "county"}, "tc-e6"),
        _tc("ask_user", {"gate": "dataset", "prompt": "Which dataset?"}, "tc-e7"),
        _tc("ask_user", {"gate": "variable", "prompt": "Which band?"}, "tc-e8"),
        _final("Mean GPP over Mendocino: 0.18 gC/m2/day."),
    ]


def _fake_dispatch(name, args, handler, tool_call_id):
    return f"ok:{name}"


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_run_scenario_paper_returns_trace_path(tmp_path):
    cfg = ScenarioCfg(
        id="pattern-paper-status-only",
        pattern="paper",
        handler_mode="status_only",
        model="gpt-stub",
        description="test",
    )
    responses = iter(_paper_stub_responses())

    with patch("agent_cost_bench.eie.pattern_paper.call_llm",
               side_effect=lambda **kw: next(responses)), \
         patch("agent_cost_bench.eie.pattern_paper.dispatch_tool_call",
               side_effect=_fake_dispatch), \
         patch("agent_cost_bench.eie.runner.REPORTS_DIR", tmp_path):
        out_path = run_scenario(cfg)

    assert out_path.exists()
    assert out_path.suffix == ".json"
    assert "pattern-paper-status-only" in out_path.name


def test_run_scenario_paper_trace_structure(tmp_path):
    cfg = ScenarioCfg(
        id="pattern-paper-key-fields",
        pattern="paper",
        handler_mode="key_fields",
        model="gpt-stub",
        description="test",
    )
    responses = iter(_paper_stub_responses())

    with patch("agent_cost_bench.eie.pattern_paper.call_llm",
               side_effect=lambda **kw: next(responses)), \
         patch("agent_cost_bench.eie.pattern_paper.dispatch_tool_call",
               side_effect=_fake_dispatch), \
         patch("agent_cost_bench.eie.runner.REPORTS_DIR", tmp_path):
        out_path = run_scenario(cfg)

    trace = json.loads(out_path.read_text())
    assert trace["scenario_id"] == "pattern-paper-key-fields"
    assert trace["pattern"] == "paper"
    assert trace["handler_mode"] == "key_fields"
    assert "turn_count" in trace
    assert "elapsed_s" in trace
    assert "totals" in trace
    assert "per_turn_avg" in trace
    assert "turns" in trace


def test_run_scenario_paper_token_totals(tmp_path):
    cfg = ScenarioCfg(
        id="pattern-paper-freeform",
        pattern="paper",
        handler_mode="freeform",
        model="gpt-stub",
        description="test",
    )
    responses = iter(_paper_stub_responses())

    with patch("agent_cost_bench.eie.pattern_paper.call_llm",
               side_effect=lambda **kw: next(responses)), \
         patch("agent_cost_bench.eie.pattern_paper.dispatch_tool_call",
               side_effect=_fake_dispatch), \
         patch("agent_cost_bench.eie.runner.REPORTS_DIR", tmp_path):
        out_path = run_scenario(cfg)

    trace = json.loads(out_path.read_text())
    totals = trace["totals"]
    # 5 tool-call turns × (20 in, 8 out, 5 cached) + 1 final × (60 in, 40 out, 20 cached)
    assert totals["input_tokens"] == 5 * 20 + 60       # 160
    assert totals["output_tokens"] == 5 * 8 + 40        # 80
    assert totals["cached_tokens"] == 5 * 5 + 20        # 45
    assert 0.0 <= totals["cache_hit_rate"] <= 1.0
    assert trace["turn_count"] == 6


def test_run_scenario_eie_returns_trace_path(tmp_path):
    cfg = ScenarioCfg(
        id="pattern-eie-status-only",
        pattern="eie",
        handler_mode="status_only",
        model="gpt-stub",
        description="test",
    )
    responses = iter(_eie_stub_responses())

    with patch("agent_cost_bench.eie.pattern_eie.call_llm",
               side_effect=lambda **kw: next(responses)), \
         patch("agent_cost_bench.eie.pattern_eie.dispatch_tool_call",
               side_effect=_fake_dispatch), \
         patch("agent_cost_bench.eie.runner.REPORTS_DIR", tmp_path):
        out_path = run_scenario(cfg)

    assert out_path.exists()
    assert "pattern-eie-status-only" in out_path.name


def test_run_scenario_eie_turn_count(tmp_path):
    cfg = ScenarioCfg(
        id="pattern-eie-key-fields",
        pattern="eie",
        handler_mode="key_fields",
        model="gpt-stub",
        description="test",
    )
    responses = iter(_eie_stub_responses())

    with patch("agent_cost_bench.eie.pattern_eie.call_llm",
               side_effect=lambda **kw: next(responses)), \
         patch("agent_cost_bench.eie.pattern_eie.dispatch_tool_call",
               side_effect=_fake_dispatch), \
         patch("agent_cost_bench.eie.runner.REPORTS_DIR", tmp_path):
        out_path = run_scenario(cfg)

    trace = json.loads(out_path.read_text())
    assert trace["turn_count"] == 9
    assert trace["pattern"] == "eie"


def test_run_scenario_cache_hit_rate_calculation(tmp_path):
    """cache_hit_rate = cached_tokens / input_tokens."""
    cfg = ScenarioCfg(
        id="pattern-paper-status-only",
        pattern="paper",
        handler_mode="status_only",
        model="gpt-stub",
        description="test",
    )
    responses = iter(_paper_stub_responses())

    with patch("agent_cost_bench.eie.pattern_paper.call_llm",
               side_effect=lambda **kw: next(responses)), \
         patch("agent_cost_bench.eie.pattern_paper.dispatch_tool_call",
               side_effect=_fake_dispatch), \
         patch("agent_cost_bench.eie.runner.REPORTS_DIR", tmp_path):
        out_path = run_scenario(cfg)

    trace = json.loads(out_path.read_text())
    totals = trace["totals"]
    expected_rate = totals["cached_tokens"] / totals["input_tokens"]
    assert abs(totals["cache_hit_rate"] - expected_rate) < 1e-9


def test_run_scenario_unknown_pattern_raises():
    cfg = ScenarioCfg(
        id="bad",
        pattern="unknown_pattern",
        handler_mode="status_only",
        model="gpt-stub",
        description="test",
    )
    with pytest.raises(ValueError, match="unknown pattern"):
        run_scenario(cfg)


def test_run_scenario_unknown_handler_raises():
    cfg = ScenarioCfg(
        id="bad",
        pattern="paper",
        handler_mode="no_such_mode",
        model="gpt-stub",
        description="test",
    )
    with pytest.raises(ValueError, match="unknown handler mode"):
        run_scenario(cfg)


def test_per_turn_avg_populated(tmp_path):
    cfg = ScenarioCfg(
        id="pattern-paper-freeform",
        pattern="paper",
        handler_mode="freeform",
        model="gpt-stub",
        description="test",
    )
    responses = iter(_paper_stub_responses())

    with patch("agent_cost_bench.eie.pattern_paper.call_llm",
               side_effect=lambda **kw: next(responses)), \
         patch("agent_cost_bench.eie.pattern_paper.dispatch_tool_call",
               side_effect=_fake_dispatch), \
         patch("agent_cost_bench.eie.runner.REPORTS_DIR", tmp_path):
        out_path = run_scenario(cfg)

    trace = json.loads(out_path.read_text())
    avg = trace["per_turn_avg"]
    assert avg["input_tokens"] > 0
    assert avg["output_tokens"] > 0
    # per-turn avg should equal total / turn_count
    n = trace["turn_count"]
    assert abs(avg["input_tokens"] - trace["totals"]["input_tokens"] / n) < 0.01


# ---------------------------------------------------------------------------
# enforce_compute_stats: system prompt injection + trace JSON field
# ---------------------------------------------------------------------------

_FORCED_INSTRUCTION = (
    "You MUST call the compute_stats tool and base your final answer on its returned "
    "aggregates. Do not produce the final answer without first invoking compute_stats."
)


def _extract_system_content(msgs) -> str | None:
    """Extract the system message content from a list that may contain
    raw dicts or LangChain message objects (SystemMessage, etc.)."""
    for m in msgs:
        if isinstance(m, dict):
            if m.get("role") == "system":
                return m["content"]
        else:
            # LangChain BaseMessage subclass — check .type attribute
            msg_type = getattr(m, "type", None)
            if msg_type == "system":
                return getattr(m, "content", None)
    return None


def test_enforce_compute_stats_paper_injects_instruction_into_system_prompt(tmp_path):
    """When cfg.enforce_compute_stats=True, system prompt passed to call_llm contains
    the forced instruction for a paper-pattern scenario."""
    cfg = ScenarioCfg(
        id="pattern-paper-status-only",
        pattern="paper",
        handler_mode="status_only",
        model="gpt-stub",
        description="test",
        enforce_compute_stats=True,
    )
    responses = iter(_paper_stub_responses())
    captured_prompts: list[str] = []

    def capturing_llm(**kw):
        content = _extract_system_content(kw.get("messages", []))
        if content is not None:
            captured_prompts.append(content)
        return next(responses)

    with patch("agent_cost_bench.eie.pattern_paper.call_llm",
               side_effect=capturing_llm), \
         patch("agent_cost_bench.eie.pattern_paper.dispatch_tool_call",
               side_effect=_fake_dispatch), \
         patch("agent_cost_bench.eie.runner.REPORTS_DIR", tmp_path):
        run_scenario(cfg)

    assert captured_prompts, "call_llm was never called with a system message"
    assert _FORCED_INSTRUCTION in captured_prompts[0], (
        "Forced instruction missing from system prompt"
    )


def test_enforce_compute_stats_eie_injects_instruction_into_system_prompt(tmp_path):
    """When cfg.enforce_compute_stats=True, system prompt passed to call_llm contains
    the forced instruction for an eie-pattern scenario."""
    cfg = ScenarioCfg(
        id="pattern-eie-status-only",
        pattern="eie",
        handler_mode="status_only",
        model="gpt-stub",
        description="test",
        enforce_compute_stats=True,
    )
    responses = iter(_eie_stub_responses())
    captured_prompts: list[str] = []

    def capturing_llm(**kw):
        content = _extract_system_content(kw.get("messages", []))
        if content is not None:
            captured_prompts.append(content)
        return next(responses)

    with patch("agent_cost_bench.eie.pattern_eie.call_llm",
               side_effect=capturing_llm), \
         patch("agent_cost_bench.eie.pattern_eie.dispatch_tool_call",
               side_effect=_fake_dispatch), \
         patch("agent_cost_bench.eie.runner.REPORTS_DIR", tmp_path):
        run_scenario(cfg)

    assert captured_prompts, "call_llm was never called with a system message"
    assert _FORCED_INSTRUCTION in captured_prompts[0], (
        "Forced instruction missing from system prompt"
    )


def test_enforce_compute_stats_false_does_not_inject_instruction(tmp_path):
    """When cfg.enforce_compute_stats=False (default), forced instruction is absent."""
    cfg = ScenarioCfg(
        id="pattern-paper-status-only",
        pattern="paper",
        handler_mode="status_only",
        model="gpt-stub",
        description="test",
        enforce_compute_stats=False,
    )
    responses = iter(_paper_stub_responses())
    captured_prompts: list[str] = []

    def capturing_llm(**kw):
        content = _extract_system_content(kw.get("messages", []))
        if content is not None:
            captured_prompts.append(content)
        return next(responses)

    with patch("agent_cost_bench.eie.pattern_paper.call_llm",
               side_effect=capturing_llm), \
         patch("agent_cost_bench.eie.pattern_paper.dispatch_tool_call",
               side_effect=_fake_dispatch), \
         patch("agent_cost_bench.eie.runner.REPORTS_DIR", tmp_path):
        run_scenario(cfg)

    assert captured_prompts, "call_llm was never called with a system message"
    assert _FORCED_INSTRUCTION not in captured_prompts[0]


def test_enforce_compute_stats_trace_json_contains_field_true(tmp_path):
    """Trace JSON includes enforce_compute_stats: true when set on cfg."""
    cfg = ScenarioCfg(
        id="pattern-paper-status-only",
        pattern="paper",
        handler_mode="status_only",
        model="gpt-stub",
        description="test",
        enforce_compute_stats=True,
    )
    responses = iter(_paper_stub_responses())

    with patch("agent_cost_bench.eie.pattern_paper.call_llm",
               side_effect=lambda **kw: next(responses)), \
         patch("agent_cost_bench.eie.pattern_paper.dispatch_tool_call",
               side_effect=_fake_dispatch), \
         patch("agent_cost_bench.eie.runner.REPORTS_DIR", tmp_path):
        out_path = run_scenario(cfg)

    trace = json.loads(out_path.read_text())
    assert trace["enforce_compute_stats"] is True


def test_enforce_compute_stats_trace_json_contains_field_false(tmp_path):
    """Trace JSON includes enforce_compute_stats: false when not set."""
    cfg = ScenarioCfg(
        id="pattern-paper-status-only",
        pattern="paper",
        handler_mode="status_only",
        model="gpt-stub",
        description="test",
    )
    responses = iter(_paper_stub_responses())

    with patch("agent_cost_bench.eie.pattern_paper.call_llm",
               side_effect=lambda **kw: next(responses)), \
         patch("agent_cost_bench.eie.pattern_paper.dispatch_tool_call",
               side_effect=_fake_dispatch), \
         patch("agent_cost_bench.eie.runner.REPORTS_DIR", tmp_path):
        out_path = run_scenario(cfg)

    trace = json.loads(out_path.read_text())
    assert trace["enforce_compute_stats"] is False
