"""Pattern P — paper's 6-turn single-shot ReAct.

User asks one specific query; the agent runs the full tool chain
(parse_datetime → geocode → search_collections → search_items →
compute_stats) in a continuous tool-use loop and produces a final
answer. No confirmation gates.

The state machine has three node types:
  - agent_step: LLM produces either tool_calls or a final answer
  - tool_step:  execute every tool_call in the LLM's output via dispatch
  - END:        terminal when LLM returns final answer (no tool_calls)
"""

from __future__ import annotations

import json
import uuid
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from .dispatch import TOOL_SCHEMAS, dispatch_tool_call
from .provider_shim import call_llm


PAPER_SYSTEM_PROMPT = (
    "You are a measurement instrument running a geospatial analysis tool chain. "
    "Given the user's query, use the available tools in sequence to: "
    "1. Parse the datetime range "
    "2. Geocode the area of interest "
    "3. Search NASA VEDA STAC collections by keyword "
    "4. List items in the chosen collection within the bbox and datetime window "
    "5. Compute band stats over the polygon AOI\n\n"
    "When you have the final stats, write a one-paragraph answer summarizing the mean, "
    "min, max, and any pattern across the per-item monthly values. Be terse — this is "
    "a measurement run, not a customer chat. Do not add emoji, personality, or "
    "follow-up offers."
)

FORCE_COMPUTE_STATS_INSTRUCTION = (
    "You MUST call the compute_stats tool and base your final answer on its returned "
    "aggregates. Do not produce the final answer without first invoking compute_stats."
)

PAPER_USER_QUERY = (
    "Visualize FIRE band flux from MiCASA Land Carbon Flux v1 over Mendocino County, "
    "California, June 2020 to November 2020. Report mean/median/min/max plus per-month values."
)


class State(TypedDict):
    messages: Annotated[list[dict[str, Any]], add_messages]
    handler_ref: Any  # the StatusOnly/KeyFields/Freeform handler instance
    model: str
    turn_count: int


def _agent_step(state: State) -> dict[str, Any]:
    """LLM turn. Real provider call happens here at run time; mocked in tests."""
    msg = call_llm(
        model=state.get("model", "gpt-5.2"),
        messages=state["messages"],
        tools=TOOL_SCHEMAS,
        temperature=0.0,
    )
    return {"messages": [msg], "turn_count": state["turn_count"] + 1}


def _get_tool_calls(msg: Any) -> list[Any]:
    """Extract tool_calls from either a LangChain message object or a raw dict."""
    if isinstance(msg, dict):
        return msg.get("tool_calls") or []
    # LangChain AIMessage — .tool_calls is a list of ToolCall dicts with keys
    # 'name', 'args', 'id', 'type'.
    return getattr(msg, "tool_calls", None) or []


def _tool_step(state: State) -> dict[str, Any]:
    """Execute every tool_call from the last assistant message."""
    last = state["messages"][-1]
    tool_calls = _get_tool_calls(last)
    new_messages: list[dict[str, Any]] = []
    for tc in tool_calls:
        # Support both raw-dict format (from stub) and AIMessage ToolCall format.
        if isinstance(tc, dict) and "function" in tc:
            # OpenAI-style: {"id": ..., "function": {"name": ..., "arguments": ...}}
            name = tc["function"]["name"]
            raw_args = tc["function"]["arguments"]
            tool_call_id = tc.get("id", str(uuid.uuid4()))
        else:
            # LangChain ToolCall: {"name": ..., "args": {...}, "id": ..., "type": "tool_call"}
            name = tc["name"] if isinstance(tc, dict) else tc.name
            raw_args_val = tc["args"] if isinstance(tc, dict) else tc.args
            raw_args = json.dumps(raw_args_val) if not isinstance(raw_args_val, str) else raw_args_val
            tool_call_id = (tc.get("id") if isinstance(tc, dict) else tc.id) or str(uuid.uuid4())
        args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
        result_str = dispatch_tool_call(name, args, state["handler_ref"], tool_call_id)
        new_messages.append(
            {"role": "tool", "tool_call_id": tool_call_id, "content": result_str}
        )
    return {"messages": new_messages}


def _route(state: State) -> str:
    """End when the LLM stops calling tools."""
    last = state["messages"][-1]
    return "tool_step" if _get_tool_calls(last) else END


def build_pattern_p_graph(handler: Any, model: str = "gpt-5.2"):
    """Build the Pattern P LangGraph state machine."""
    g = StateGraph(State)
    g.add_node("agent_step", _agent_step)
    g.add_node("tool_step", _tool_step)
    g.add_edge(START, "agent_step")
    g.add_conditional_edges(
        "agent_step", _route, {"tool_step": "tool_step", END: END}
    )
    g.add_edge("tool_step", "agent_step")
    return g.compile()


def initial_state(
    handler: Any,
    model: str = "gpt-5.2",
    enforce_compute_stats: bool = False,
) -> State:
    system_prompt = PAPER_SYSTEM_PROMPT
    if enforce_compute_stats:
        system_prompt = system_prompt + "\n\n" + FORCE_COMPUTE_STATS_INSTRUCTION
    return {
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": PAPER_USER_QUERY},
        ],
        "handler_ref": handler,
        "model": model,
        "turn_count": 0,
    }
