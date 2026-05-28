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


# ---------------------------------------------------------------------------
# Enrichment fields: user_query, final_answer, map_url, tool_calls_detail,
# assistant_text
# ---------------------------------------------------------------------------

def _tc_with_text(name: str, args: dict, call_id: str, text: str = "") -> dict:
    """Assistant turn: tool call + optional text."""
    return {
        "role": "assistant",
        "content": text,
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


def _paper_enriched_responses():
    """Responses that yield text on two turns so assistant_text is non-empty."""
    return [
        _tc_with_text("parse_datetime", {"value": "June 2020"}, "tc-1", "Parsing date."),
        _tc("geocode", {"query": "mendocino", "level": "county"}, "tc-2"),
        _tc("search_collections", {"query": "global primary production"}, "tc-3"),
        _tc("search_items", {"collection_id": "lis-global-da-gpp",
                              "bbox": [-124, 38, -122, 40],
                              "datetime_range": "2020-06/2020-11"}, "tc-4"),
        _tc("compute_stats", {"item_refs": [], "band": "cog_default",
                               "geometry": {"type": "Polygon", "coordinates": []}}, "tc-5"),
        _final("Mean GPP: 0.12 gC/m2/day."),
    ]


def test_trace_contains_user_query(tmp_path):
    """Trace top level must include user_query from the initial user message."""
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
    assert "user_query" in trace
    # Should contain the paper query text
    assert "GPP" in trace["user_query"] or len(trace["user_query"]) > 0


def test_trace_contains_final_answer(tmp_path):
    """Trace top level must include final_answer (last assistant text content)."""
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
    assert "final_answer" in trace
    assert "Mean GPP" in trace["final_answer"]


def test_trace_final_answer_truncated_at_2000(tmp_path):
    """final_answer is truncated to 2000 chars."""
    cfg = ScenarioCfg(
        id="pattern-paper-freeform",
        pattern="paper",
        handler_mode="freeform",
        model="gpt-stub",
        description="test",
    )
    long_answer = "x" * 3000
    responses = iter([
        _tc("parse_datetime", {"value": "June 2020"}, "tc-1"),
        _tc("geocode", {"query": "mendocino", "level": "county"}, "tc-2"),
        _tc("search_collections", {"query": "primary production"}, "tc-3"),
        _tc("search_items", {"collection_id": "gpp", "bbox": [-124, 38, -122, 40],
                              "datetime_range": "2020-06/2020-11"}, "tc-4"),
        _tc("compute_stats", {"item_refs": [], "band": "cog_default",
                               "geometry": {}}, "tc-5"),
        _final(long_answer),
    ])

    with patch("agent_cost_bench.eie.pattern_paper.call_llm",
               side_effect=lambda **kw: next(responses)), \
         patch("agent_cost_bench.eie.pattern_paper.dispatch_tool_call",
               side_effect=_fake_dispatch), \
         patch("agent_cost_bench.eie.runner.REPORTS_DIR", tmp_path):
        out_path = run_scenario(cfg)

    trace = json.loads(out_path.read_text())
    assert len(trace["final_answer"]) <= 2000


def test_trace_map_url_null_when_no_render_map(tmp_path):
    """map_url must be null in a trace that never calls render_map."""
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
    assert "map_url" in trace
    assert trace["map_url"] is None


def test_trace_map_url_extracted_from_render_map_result(tmp_path):
    """map_url is extracted from the tool result message for render_map."""
    import json as _json
    cfg = ScenarioCfg(
        id="pattern-paper-key-fields",
        pattern="paper",
        handler_mode="key_fields",
        model="gpt-stub",
        description="test",
    )
    fake_map_url = "https://veda.example.com/map?collection=lis-global-da-gpp"

    def _dispatch_with_map(name, args, handler, tool_call_id):
        if name == "render_map":
            return _json.dumps({"map_url": fake_map_url, "item_id": "item-1"})
        return f"ok:{name}"

    responses = iter([
        _tc("parse_datetime", {"value": "June 2020"}, "tc-1"),
        _tc("geocode", {"query": "mendocino", "level": "county"}, "tc-2"),
        _tc("search_collections", {"query": "primary production"}, "tc-3"),
        _tc("search_items", {"collection_id": "gpp", "bbox": [-124, 38, -122, 40],
                              "datetime_range": "2020-06/2020-11"}, "tc-4"),
        _tc("compute_stats", {"item_refs": [], "band": "cog_default",
                               "geometry": {}}, "tc-5"),
        _tc("render_map", {"collection_id": "lis-global-da-gpp",
                            "item_id": "item-1",
                            "bbox": [-124, 38, -122, 40]}, "tc-6"),
        _final("Map: " + fake_map_url),
    ])

    with patch("agent_cost_bench.eie.pattern_paper.call_llm",
               side_effect=lambda **kw: next(responses)), \
         patch("agent_cost_bench.eie.pattern_paper.dispatch_tool_call",
               side_effect=_dispatch_with_map), \
         patch("agent_cost_bench.eie.runner.REPORTS_DIR", tmp_path):
        out_path = run_scenario(cfg)

    trace = json.loads(out_path.read_text())
    assert trace["map_url"] == fake_map_url


def test_trace_per_turn_tool_calls_detail(tmp_path):
    """Each turn must include tool_calls_detail with name+args."""
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
    # First turn calls parse_datetime
    first_turn = trace["turns"][0]
    assert "tool_calls_detail" in first_turn
    assert len(first_turn["tool_calls_detail"]) == 1
    detail = first_turn["tool_calls_detail"][0]
    assert detail["name"] == "parse_datetime"
    assert "args" in detail
    # Existing tool_calls list still present for backward compat
    assert "tool_calls" in first_turn
    assert first_turn["tool_calls"] == ["parse_datetime"]


def test_trace_per_turn_assistant_text(tmp_path):
    """Turns with text content must expose it in assistant_text."""
    cfg = ScenarioCfg(
        id="pattern-paper-freeform",
        pattern="paper",
        handler_mode="freeform",
        model="gpt-stub",
        description="test",
    )
    responses = iter(_paper_enriched_responses())

    with patch("agent_cost_bench.eie.pattern_paper.call_llm",
               side_effect=lambda **kw: next(responses)), \
         patch("agent_cost_bench.eie.pattern_paper.dispatch_tool_call",
               side_effect=_fake_dispatch), \
         patch("agent_cost_bench.eie.runner.REPORTS_DIR", tmp_path):
        out_path = run_scenario(cfg)

    trace = json.loads(out_path.read_text())
    # First turn has text "Parsing date."
    assert trace["turns"][0]["assistant_text"] == "Parsing date."
    # Second turn has no text — must be empty string, not missing
    assert "assistant_text" in trace["turns"][1]
    assert trace["turns"][1]["assistant_text"] == ""


def test_trace_per_turn_assistant_text_truncated_at_500(tmp_path):
    """assistant_text is truncated to 500 chars."""
    long_text = "w" * 1000
    cfg = ScenarioCfg(
        id="pattern-paper-status-only",
        pattern="paper",
        handler_mode="status_only",
        model="gpt-stub",
        description="test",
    )
    responses = iter([
        _tc_with_text("parse_datetime", {"value": "June 2020"}, "tc-1", long_text),
        _tc("geocode", {"query": "mendocino", "level": "county"}, "tc-2"),
        _tc("search_collections", {"query": "primary production"}, "tc-3"),
        _tc("search_items", {"collection_id": "gpp", "bbox": [-124, 38, -122, 40],
                              "datetime_range": "2020-06/2020-11"}, "tc-4"),
        _tc("compute_stats", {"item_refs": [], "band": "cog_default",
                               "geometry": {}}, "tc-5"),
        _final("done"),
    ])

    with patch("agent_cost_bench.eie.pattern_paper.call_llm",
               side_effect=lambda **kw: next(responses)), \
         patch("agent_cost_bench.eie.pattern_paper.dispatch_tool_call",
               side_effect=_fake_dispatch), \
         patch("agent_cost_bench.eie.runner.REPORTS_DIR", tmp_path):
        out_path = run_scenario(cfg)

    trace = json.loads(out_path.read_text())
    assert len(trace["turns"][0]["assistant_text"]) <= 500
