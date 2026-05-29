"""Pattern Gated — 5-gate drill-down (gated drill-down conversation).

User submits an under-specified query. The agent runs a tool, emits an
ask_user gate call to surface an intermediate finding, waits for the
UserActor's scripted answer, then proceeds to the next phase. Five
confirmation gates: datetime → state → county → dataset → variable.
After the variable gate the agent calls search_items and compute_stats
autonomously and writes a terse final paragraph.

State machine has three node types:
  - agent_step: LLM produces tool_calls (ask_user or real tools) or a
                final answer
  - tool_step:  execute real tool calls (parse_datetime, geocode, …)
  - gate_step:  intercept ask_user calls; route to UserActor; inject
                the scripted answer as a tool result
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Annotated, Any, TypedDict

log = logging.getLogger(__name__)

from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from .dispatch import get_tool_calls as _get_tool_calls, get_tool_schemas, dispatch_tool_call
from .provider_shim import call_llm
from .user_actor import UserActor


ASK_USER_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "ask_user",
        "description": (
            "Pause execution and present a clarifying question to the user. "
            "Use exactly once per gate in the sequence: datetime, state, county, "
            "dataset, variable. Do not chain multiple ask_user calls in one turn."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "gate": {
                    "type": "string",
                    "enum": ["datetime", "state", "county", "dataset", "variable"],
                },
                "prompt": {"type": "string"},
            },
            "required": ["gate", "prompt"],
        },
    },
}

GATED_SYSTEM_PROMPT = (
    "You are a measurement instrument running a geospatial analysis workflow. "
    "The user's query is under-specified. Proceed through these five gate phases "
    "in order, one gate per turn:\n\n"
    "  1. Call parse_datetime with a reasonable default window, then ask_user(gate='datetime') "
    "to confirm the range.\n"
    "  2. Call ask_user(gate='state') to learn the target US state.\n"
    "  3. Call geocode on that state, then ask_user(gate='county') to drill to a county.\n"
    "  4. Call geocode on the county and search_collections, then ask_user(gate='dataset') "
    "to select a collection.\n"
    "  5. Call ask_user(gate='variable') to choose the band.\n\n"
    "Once all five gates are resolved, call search_items then compute_stats with no further "
    "gates, and write a single terse paragraph reporting the stats. "
    "No emoji. No follow-up offers. This is a measurement run."
)

GATED_USER_QUERY = (
    "Analyze carbon flux anomalies linked to major 2020 California wildfire events "
    "using model-estimated land carbon flux data."
)

FORCE_COMPUTE_STATS_INSTRUCTION = (
    "You MUST call the compute_stats tool and base your final answer on its returned "
    "aggregates. Do not produce the final answer without first invoking compute_stats."
)

RENDER_MAP_INSTRUCTION = (
    "After compute_stats, call render_map with the same collection_id, item_id "
    "(use the first item), and bbox to produce a map layer URL, then include that "
    "URL verbatim in your final answer."
)

# Injected when the live model emits a gate key UserActor has no scripted
# answer for — keeps the run alive instead of raising (see _gate_step).
_UNKNOWN_GATE_FALLBACK = "Please proceed with the defaults."


class State(TypedDict):
    messages: Annotated[list[dict[str, Any]], add_messages]
    handler_ref: Any
    user_actor: Any
    model: str
    turn_count: int
    emit_map: bool


def _parse_tc(tc: Any) -> tuple[str, dict, str]:
    """Return (name, args_dict, call_id) regardless of tool_call shape."""
    if isinstance(tc, dict) and "function" in tc:
        name = tc["function"]["name"]
        raw_args = tc["function"]["arguments"]
        call_id = tc.get("id", str(uuid.uuid4()))
    else:
        name = tc["name"] if isinstance(tc, dict) else tc.name
        raw_args_val = tc["args"] if isinstance(tc, dict) else tc.args
        raw_args = json.dumps(raw_args_val) if not isinstance(raw_args_val, str) else raw_args_val
        call_id = (tc.get("id") if isinstance(tc, dict) else tc.id) or str(uuid.uuid4())
    args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
    return name, args, call_id


def _agent_step(state: State) -> dict[str, Any]:
    msg = call_llm(
        model=state.get("model", "gpt-5.2"),
        messages=state["messages"],
        tools=get_tool_schemas(with_map=state.get("emit_map", False)) + [ASK_USER_TOOL],
        temperature=0.0,
    )
    return {"messages": [msg], "turn_count": state["turn_count"] + 1}


def _route(state: State) -> str:
    last = state["messages"][-1]
    tool_calls = _get_tool_calls(last)
    if not tool_calls:
        return END
    for tc in tool_calls:
        name, _, _ = _parse_tc(tc)
        if name == "ask_user":
            return "gate_step"
    return "tool_step"


def _tool_step(state: State) -> dict[str, Any]:
    last = state["messages"][-1]
    tool_calls = _get_tool_calls(last)
    new_messages: list[dict[str, Any]] = []
    for tc in tool_calls:
        name, args, call_id = _parse_tc(tc)
        if name == "ask_user":
            continue
        try:
            result_str = dispatch_tool_call(name, args, state["handler_ref"], call_id)
        except Exception as exc:  # noqa: BLE001
            result_str = f"ERROR: {type(exc).__name__}: {exc}"
        new_messages.append({"role": "tool", "tool_call_id": call_id, "content": result_str})
    return {"messages": new_messages}


def _gate_step(state: State) -> dict[str, Any]:
    last = state["messages"][-1]
    tool_calls = _get_tool_calls(last)
    actor: UserActor = state["user_actor"]
    new_messages: list[dict[str, Any]] = []
    for tc in tool_calls:
        name, args, call_id = _parse_tc(tc)
        if name != "ask_user":
            continue
        gate = args["gate"]
        prompt = args.get("prompt", "")
        # I3 robustness: if the live model emits an unscripted gate key, do
        # NOT raise — that would kill the LangGraph node and lose the trace.
        # Instead, log the surprise and inject a short generic answer so the
        # state machine can continue.  UserActor keeps its strict KeyError
        # behaviour (useful for test fixtures); only this call-site degrades
        # gracefully.
        try:
            response = actor.respond(gate, prompt)
        except KeyError:
            log.warning(
                "gate_step: unexpected gate %r not in UserActor answers; "
                "substituting fallback. agent_prompt=%r",
                gate,
                prompt,
            )
            response = _UNKNOWN_GATE_FALLBACK
        new_messages.append({"role": "tool", "tool_call_id": call_id, "content": response})
    return {"messages": new_messages}


def build_pattern_gated_graph(handler: Any, user_actor: UserActor, model: str = "gpt-5.2"):
    """Build the gated drill-down LangGraph state machine."""
    g = StateGraph(State)
    g.add_node("agent_step", _agent_step)
    g.add_node("tool_step", _tool_step)
    g.add_node("gate_step", _gate_step)
    g.add_edge(START, "agent_step")
    g.add_conditional_edges(
        "agent_step",
        _route,
        {"tool_step": "tool_step", "gate_step": "gate_step", END: END},
    )
    g.add_edge("tool_step", "agent_step")
    g.add_edge("gate_step", "agent_step")
    return g.compile()


def initial_state(
    handler: Any,
    user_actor: UserActor,
    model: str = "gpt-5.2",
    enforce_compute_stats: bool = False,
    emit_map: bool = False,
) -> State:
    system_prompt = GATED_SYSTEM_PROMPT
    if enforce_compute_stats:
        system_prompt = system_prompt + "\n\n" + FORCE_COMPUTE_STATS_INSTRUCTION
    if emit_map:
        system_prompt = system_prompt + "\n\n" + RENDER_MAP_INSTRUCTION
    return {
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": GATED_USER_QUERY},
        ],
        "handler_ref": handler,
        "user_actor": user_actor,
        "model": model,
        "turn_count": 0,
        "emit_map": emit_map,
    }
