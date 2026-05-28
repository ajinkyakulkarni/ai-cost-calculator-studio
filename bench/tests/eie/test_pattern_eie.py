"""Pattern E — 5-gate drill-down state machine.

Tests verify:
  1. The graph compiles with agent_step / tool_step / gate_step nodes.
  2. A full run with a stub LLM completes in ~9-10 turns (5 gates + 4-5 tool
     calls + 1 final answer), with UserActor consulted at each gate.
"""

import json
from typing import Any
from unittest.mock import patch

from agent_cost_bench.eie.pattern_eie import build_pattern_e_graph, initial_state
from agent_cost_bench.eie.handlers import KeyFieldsHandler
from agent_cost_bench.eie.user_actor import UserActor


def test_pattern_e_compiles():
    handler = KeyFieldsHandler()
    actor = UserActor.frozen_default()
    graph = build_pattern_e_graph(handler=handler, user_actor=actor, model="gpt-5.2-mock")
    node_names = {n for n in graph.get_graph().nodes}
    assert "agent_step" in node_names
    assert "tool_step" in node_names
    assert "gate_step" in node_names


def test_pattern_e_invoke_with_stub():
    """Run state machine with deterministic stub; assert 9 turns and gate coverage."""

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
            "_usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }

    def _final(text: str) -> dict:
        return {
            "role": "assistant",
            "content": text,
            "_usage": {"prompt_tokens": 60, "completion_tokens": 45, "total_tokens": 105},
        }

    # Sequence: 5 gate calls interleaved with tool calls, then search_items +
    # compute_stats, then final answer. 9 agent turns total.
    stub_responses = [
        # Turn 1: parse_datetime then immediately ask gate[datetime]
        # LangGraph does one tool_call per turn here; we model that.
        _tc("parse_datetime", {"value": "summer–fall 2020"}, "tc-1"),
        # Turn 2 (after tool result): ask gate[datetime]
        _tc("ask_user", {"gate": "datetime", "prompt": "Confirm: June–November 2020?"}, "tc-2"),
        # Turn 3 (after gate answer): ask gate[state]
        _tc("ask_user", {"gate": "state", "prompt": "Which US state should I analyze?"}, "tc-3"),
        # Turn 4 (after gate answer): geocode state, ask gate[county]
        _tc("geocode", {"query": "California", "level": "state"}, "tc-4"),
        # Turn 5 (after tool result): ask gate[county]
        _tc("ask_user", {"gate": "county", "prompt": "Which county within California?"}, "tc-5"),
        # Turn 6 (after gate answer): geocode county + search_collections, ask gate[dataset]
        _tc("geocode", {"query": "Mendocino County, CA", "level": "county"}, "tc-6"),
        # Turn 7 (after tool result): ask gate[dataset]
        _tc("ask_user", {"gate": "dataset", "prompt": "Which dataset should I use?"}, "tc-7"),
        # Turn 8 (after gate answer): ask gate[variable]
        _tc("ask_user", {"gate": "variable", "prompt": "Which band/variable?"}, "tc-8"),
        # Turn 9 (after gate answer): search_items + compute_stats → final answer
        _final("Mean GPP over Mendocino County June–November 2020: 0.18 gC/m2/day."),
    ]

    llm_iter = iter(stub_responses)

    def fake_llm(**kwargs):
        return next(llm_iter)

    def fake_dispatch(name, args, handler, tool_call_id):
        return f"ok:{name}"

    with patch("agent_cost_bench.eie.pattern_eie.call_llm", side_effect=lambda **kw: fake_llm(**kw)), \
         patch("agent_cost_bench.eie.pattern_eie.dispatch_tool_call", side_effect=fake_dispatch):
        handler = KeyFieldsHandler()
        actor = UserActor.frozen_default()
        graph = build_pattern_e_graph(handler=handler, user_actor=actor, model="gpt-stub")
        state = initial_state(handler=handler, user_actor=actor, model="gpt-stub")
        result = graph.invoke(state)

    assert result["turn_count"] == 9

    last = result["messages"][-1]
    content = last["content"] if isinstance(last, dict) else last.content
    tool_calls = (last.get("tool_calls") if isinstance(last, dict)
                  else getattr(last, "tool_calls", None))
    assert not tool_calls
    assert "GPP" in content


def test_pattern_e_survives_novel_gate():
    """I3 robustness: GPT-5.2 emits an unscripted gate name.

    The run must complete without raising, and the transcript must contain
    a tool message with the fallback response so analysts can see it happened.
    """

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
            "_usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }

    def _final(text: str) -> dict:
        return {
            "role": "assistant",
            "content": text,
            "_usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30},
        }

    # GPT-5.2 emits a gate name "resolution" that is NOT in frozen_default.
    stub_responses = [
        _tc("ask_user", {"gate": "NOVEL_GATE_XYZ", "prompt": "Pick a resolution?"}, "tc-novel"),
        _final("Done."),
    ]

    llm_iter = iter(stub_responses)

    def fake_llm(**kwargs):
        return next(llm_iter)

    def fake_dispatch(name, args, handler, tool_call_id):
        return f"ok:{name}"

    with patch("agent_cost_bench.eie.pattern_eie.call_llm", side_effect=lambda **kw: fake_llm(**kw)), \
         patch("agent_cost_bench.eie.pattern_eie.dispatch_tool_call", side_effect=fake_dispatch):
        handler = KeyFieldsHandler()
        actor = UserActor.frozen_default()
        graph = build_pattern_e_graph(handler=handler, user_actor=actor, model="gpt-stub")
        state = initial_state(handler=handler, user_actor=actor, model="gpt-stub")
        # Must not raise KeyError
        result = graph.invoke(state)

    # Run completed
    assert result["turn_count"] == 2

    # Transcript must contain a tool message whose content is the fallback string.
    # LangGraph returns LangChain message objects, so check by class name OR role key.
    def _is_tool_msg(m: Any) -> bool:
        if isinstance(m, dict):
            return m.get("role") == "tool"
        # LangChain ToolMessage has no .role attr but its class is ToolMessage
        return type(m).__name__ == "ToolMessage"

    def _msg_content(m: Any) -> str:
        if isinstance(m, dict):
            return m.get("content", "")
        return getattr(m, "content", "")

    tool_messages = [m for m in result["messages"] if _is_tool_msg(m)]
    assert tool_messages, "no tool messages found in transcript"
    fallback_content = _msg_content(tool_messages[0])
    # The fallback must be a short generic string, not the KeyError
    assert isinstance(fallback_content, str) and len(fallback_content) > 0
    # It must NOT be an exception repr
    assert "KeyError" not in fallback_content
