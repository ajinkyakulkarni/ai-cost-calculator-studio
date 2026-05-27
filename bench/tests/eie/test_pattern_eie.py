"""Pattern E — 5-gate drill-down state machine.

Tests verify:
  1. The graph compiles with agent_step / tool_step / gate_step nodes.
  2. A full run with a stub LLM completes in ~9-10 turns (5 gates + 4-5 tool
     calls + 1 final answer), with UserActor consulted at each gate.
"""

import json
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
        _final("Mean FIRE flux over Mendocino County June–November 2020: 0.18 gC/m2/day."),
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
    assert "FIRE" in content
