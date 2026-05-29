"""Pattern P — 6-turn ReAct loop, no gates, single user query.

Test verifies the state machine compiles and runs to completion on a
mocked LLM (no real provider calls). We assert the conversation has
the expected turn count and the agent ends in 'final_answer' state.
"""

from unittest.mock import patch
from agent_cost_bench.geo_qa.pattern_paper import build_pattern_p_graph
from agent_cost_bench.geo_qa.handlers import StatusOnlyHandler


def test_pattern_p_compiles_and_runs_to_end():
    handler = StatusOnlyHandler()
    graph = build_pattern_p_graph(handler=handler, model="gpt-5.2-mock")
    # Confirm the graph compiled (graph.invoke would call LLM; here we
    # just check structure).
    assert graph is not None
    # The graph should have nodes for: agent_step, tool_step, answer.
    node_names = {n for n in graph.get_graph().nodes}
    assert "agent_step" in node_names
    assert "tool_step" in node_names


def test_pattern_p_invoke_with_stub_provider():
    """Run the full state machine with a deterministic fake LLM.

    Both call_llm (provider) and dispatch_tool_call are patched so no
    real API calls or STAC lookups happen. We verify turn count and that
    the graph terminates on a plain-text final answer.
    """
    import json
    from agent_cost_bench.geo_qa.pattern_paper import build_pattern_p_graph, initial_state
    from agent_cost_bench.geo_qa.handlers import StatusOnlyHandler

    def _make_tool_call(name: str, args: dict, call_id: str) -> dict:
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

    def _make_final(text: str) -> dict:
        return {
            "role": "assistant",
            "content": text,
            "_usage": {"prompt_tokens": 50, "completion_tokens": 40, "total_tokens": 90},
        }

    stub_llm_responses = [
        _make_tool_call("parse_datetime", {"value": "June 2020 to November 2020"}, "tc-1"),
        _make_tool_call("geocode", {"query": "mendocino county, ca", "level": "county"}, "tc-2"),
        _make_tool_call("search_collections", {"query": "global primary production"}, "tc-3"),
        _make_tool_call("search_items", {"collection_id": "lis-global-da-gpp", "bbox": [-124.0, 38.0, -122.5, 40.0], "datetime_range": "2020-06-01/2020-11-30"}, "tc-4"),
        _make_tool_call("compute_stats", {"item_refs": [], "band": "cog_default", "geometry": {"type": "Polygon", "coordinates": [[[0, 0]]]}}, "tc-5"),
        _make_final("Mean GPP: 0.12 gC/m2/day across June–November 2020."),
    ]

    llm_iter = iter(stub_llm_responses)

    def fake_call_llm(**kwargs):
        return next(llm_iter)

    def fake_dispatch(name, args, handler, tool_call_id):
        # Return a terse status string so handler.wrap is not needed here.
        return f"ok:{name}:{tool_call_id}"

    with patch("agent_cost_bench.geo_qa.pattern_paper.call_llm", side_effect=lambda **kw: fake_call_llm(**kw)), \
         patch("agent_cost_bench.geo_qa.pattern_paper.dispatch_tool_call", side_effect=fake_dispatch):
        handler = StatusOnlyHandler()
        graph = build_pattern_p_graph(handler=handler, model="gpt-stub")
        state = initial_state(handler=handler, model="gpt-stub")
        result = graph.invoke(state)

    # 6 LLM turns (5 tool calls + 1 final answer)
    assert result["turn_count"] == 6
    # Last message is the final assistant answer with no tool_calls.
    # LangGraph returns LangChain message objects; use attribute access.
    last = result["messages"][-1]
    content = last["content"] if isinstance(last, dict) else last.content
    tool_calls = (last.get("tool_calls") if isinstance(last, dict)
                  else getattr(last, "tool_calls", None))
    assert not tool_calls
    assert "GPP" in content
