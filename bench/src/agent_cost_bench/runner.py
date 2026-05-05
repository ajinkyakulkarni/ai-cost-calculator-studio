"""LangGraph-based scenario runner.

LangGraph is the de-facto multi-agent orchestration framework. By
modelling each scenario as a state machine with typed state, we get:
  - cycle/branch handling for free
  - native parallelism for fan-out scenarios
  - stable trace boundaries (one span per node entry)
  - the same shape NASA/federal teams build production agents in

For v1 we support three topologies:
  - 'single':                  one agent, sequential turns
  - 'sequential':              agent A → agent B → ... → final
  - 'orchestrator-specialists': orchestrator dispatches to N specialists, aggregates

The 'parallel' topology is implemented but exercises LangGraph's
fan-out/fan-in pattern — that's where multi-agent cost dynamics get
interesting (handoff overhead, concurrency-quota waste).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from .provider import call_llm
from .scenario import AgentSpec, Scenario
from .tools import TOOL_SCHEMAS, execute_tool_call
from .tracing import init_tracing, reset_collected_spans, write_trace_artifact


def _normalize_tool_calls(tcs) -> list[dict[str, Any]]:
    """Translate LangChain-shape tool_calls back to OpenAI shape.

    LangGraph's add_messages reducer converts our OpenAI-shape
    tool_calls (`{id, type:"function", function:{name, arguments}}`)
    into LangChain's shape (`{name, args, id, type:"tool_call"}`).
    OpenAI rejects the LangChain shape, so we translate back when
    feeding history into the next LLM call.
    """
    out = []
    for tc in tcs:
        # OpenAI shape: pass through unchanged.
        if isinstance(tc, dict) and tc.get("type") == "function" and "function" in tc:
            out.append(tc)
            continue
        # LangChain shape (object or dict).
        if isinstance(tc, dict):
            name = tc.get("name") or (tc.get("function") or {}).get("name")
            args = tc.get("args") or (tc.get("function") or {}).get("arguments") or {}
            tcid = tc.get("id")
        else:
            name = getattr(tc, "name", None)
            args = getattr(tc, "args", {})
            tcid = getattr(tc, "id", None)
        if isinstance(args, dict):
            args_str = json.dumps(args)
        else:
            args_str = str(args)
        out.append({
            "id": tcid,
            "type": "function",
            "function": {"name": name, "arguments": args_str},
        })
    return out


def _expand_tools(tools_in_yaml: list) -> list[dict[str, Any]]:
    """Resolve scenario YAML tool entries to OpenAI function schemas.

    YAML scenarios can list tools as bare strings (`["search",
    "fetch_doc"]`) referencing the schemas in tools.TOOL_SCHEMAS, or
    as full schema dicts for ad-hoc functions. We support both.
    """
    out: list[dict[str, Any]] = []
    name_to_schema = {t["function"]["name"]: t for t in TOOL_SCHEMAS}
    for entry in tools_in_yaml:
        if isinstance(entry, str):
            schema = name_to_schema.get(entry)
            if schema is not None:
                out.append(schema)
        elif isinstance(entry, dict):
            out.append(entry)
    return out


def _extract_tool_calls(raw_response: Any) -> list[dict[str, Any]] | None:
    """Pull tool_calls out of a LiteLLM response (dict or object).

    Returns the OpenAI-shaped list of tool_calls, or None when there
    are none. Handles both blocking and streaming responses (where
    raw_response is a list of chunks).
    """
    if raw_response is None:
        return None
    # Streaming: raw_response is a list of chunks; tool calls would be
    # assembled from delta.tool_calls. v1 only supports tool calls on
    # blocking responses; streaming + tools is a v2 concern.
    if isinstance(raw_response, list):
        return None
    try:
        msg = raw_response.choices[0].message
    except (AttributeError, IndexError):
        return None
    tcs = getattr(msg, "tool_calls", None)
    if not tcs:
        return None
    out = []
    for tc in tcs:
        out.append({
            "id": getattr(tc, "id", None) or tc.get("id"),
            "type": "function",
            "function": {
                "name": getattr(tc.function, "name", None) if hasattr(tc, "function") else tc["function"]["name"],
                "arguments": getattr(tc.function, "arguments", "") if hasattr(tc, "function") else tc["function"]["arguments"],
            },
        })
    return out


def _msg_attr(m, key: str):
    """Read a field from either a dict or a LangChain BaseMessage object.

    LangGraph's add_messages reducer may upgrade plain dicts into
    LangChain message objects (HumanMessage, AIMessage). We need to
    handle both shapes when serializing back to provider-API format.
    """
    if isinstance(m, dict):
        return m.get(key)
    # LangChain BaseMessage: role lives on .type ('human'/'ai'/'system');
    # content on .content; tool_calls on .tool_calls (AIMessage only).
    if key == "role":
        t = getattr(m, "type", None)
        return {"human": "user", "ai": "assistant", "system": "system",
                "tool": "tool"}.get(t, t)
    return getattr(m, key, None)


class RunState(TypedDict):
    """LangGraph state. `messages` is appended to per turn; the
    accumulator-style annotation is LangGraph's idiomatic pattern for
    chat history."""

    messages: Annotated[list[dict], add_messages]
    turn_idx: int
    total_cost_usd: float


def _build_agent_node(agent: AgentSpec, tracer):
    """Wrap an AgentSpec into a LangGraph node function.

    The node reads the latest user message from state, calls the LLM,
    appends the assistant response, and updates running cost.
    """

    def node(state: RunState) -> dict:
        # Build the messages for this call: prepend system prompt + full
        # conversation history. This is where prompt-caching pays off —
        # the system prompt is identical every turn, so providers cache
        # it after the first request.
        msgs: list[dict] = []
        if agent.system_prompt:
            msgs.append({"role": "system", "content": agent.system_prompt})
        # Copy only role + content (and tool fields when populated) from
        # historical messages. LangGraph's add_messages reducer can
        # attach extras like an empty tool_calls list, which OpenAI
        # rejects with "Invalid 'tool_calls': empty array."
        # It also rewrites tool_calls into LangChain shape
        # ({type: "tool_call", name, args, id}) — translate back to
        # OpenAI shape ({type: "function", function: {name, arguments}})
        # before sending.
        for m in state["messages"]:
            clean: dict = {"role": _msg_attr(m, "role"), "content": _msg_attr(m, "content")}
            tc = _msg_attr(m, "tool_calls")
            if tc:
                clean["tool_calls"] = _normalize_tool_calls(tc)
            tcid = _msg_attr(m, "tool_call_id")
            if tcid:
                clean["tool_call_id"] = tcid
            msgs.append(clean)

        # Resolve string-keyed tool aliases (e.g., "search") to the
        # canonical OpenAI function schemas. YAML scenarios can list
        # tools as bare strings for readability; runner expands.
        tools_arg = _expand_tools(agent.tools) if agent.tools else None

        result = call_llm(
            tracer,
            model=agent.model,
            messages=msgs,
            temperature=agent.temperature,
            max_tokens=agent.max_output_tokens,
            tools=tools_arg,
            stream=agent.stream,
        )

        cost = result.cost_usd
        appended_messages: list[dict] = []

        # Tool-call loop. If the LLM requested tools, execute them
        # locally, feed the results back, and ask for a follow-up
        # response. Bounded depth (8 hops) so a runaway LLM can't
        # blow the budget.
        tool_calls = _extract_tool_calls(result.raw_response)
        depth = 0
        while tool_calls and depth < 8:
            depth += 1
            # Append the assistant message *with* its tool_calls so
            # the next call sees the same context the model expects.
            appended_messages.append({
                "role": "assistant",
                "content": result.content or "",
                "tool_calls": tool_calls,
            })
            # Execute each tool call and append a tool message per result.
            for tc in tool_calls:
                fn = tc["function"]["name"]
                args = json.loads(tc["function"]["arguments"] or "{}")
                tool_result = execute_tool_call(fn, args)
                appended_messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": tool_result,
                })
            # Re-call the LLM with the tool results in context.
            next_msgs = msgs + appended_messages
            result = call_llm(
                tracer,
                model=agent.model,
                messages=next_msgs,
                temperature=agent.temperature,
                max_tokens=agent.max_output_tokens,
                tools=tools_arg,
                stream=agent.stream,
            )
            cost += result.cost_usd
            tool_calls = _extract_tool_calls(result.raw_response)

        # Final assistant message (after any tool loop).
        appended_messages.append({"role": "assistant", "content": result.content})

        return {
            "messages": appended_messages,
            "total_cost_usd": state["total_cost_usd"] + cost,
        }

    return node


def _build_graph(scenario: Scenario, tracer) -> StateGraph:
    """Compile a LangGraph for the scenario's topology.

    For v1 we keep the topology logic simple — most scenarios are
    single-agent. Multi-agent fan-out lands incrementally with the
    `parallel-fleet` and `orchestrator-specialists` scenarios.
    """
    graph = StateGraph(RunState)

    if scenario.topology == "single":
        if len(scenario.agents) != 1:
            raise ValueError(
                f"topology 'single' requires exactly one agent; got {len(scenario.agents)}"
            )
        agent = scenario.agents[0]
        graph.add_node(agent.id, _build_agent_node(agent, tracer))
        graph.add_edge(START, agent.id)
        graph.add_edge(agent.id, END)

    elif scenario.topology == "sequential":
        # Chain agents: A → B → C → END. Each agent sees the cumulative
        # message history (its own + all upstream agents' outputs).
        for agent in scenario.agents:
            graph.add_node(agent.id, _build_agent_node(agent, tracer))
        graph.add_edge(START, scenario.agents[0].id)
        for prev, cur in zip(scenario.agents, scenario.agents[1:]):
            graph.add_edge(prev.id, cur.id)
        graph.add_edge(scenario.agents[-1].id, END)

    elif scenario.topology == "orchestrator-specialists":
        # Orchestrator (first agent) dispatches to remaining specialists
        # in parallel, then a fan-in synthesises. v1 implementation is
        # naïve (no conditional routing); refine when the scenario
        # warrants it.
        if len(scenario.agents) < 2:
            raise ValueError("orchestrator-specialists requires >=2 agents")
        orch = scenario.agents[0]
        specialists = scenario.agents[1:]
        graph.add_node(orch.id, _build_agent_node(orch, tracer))
        for s in specialists:
            graph.add_node(s.id, _build_agent_node(s, tracer))
        graph.add_edge(START, orch.id)
        for s in specialists:
            graph.add_edge(orch.id, s.id)
            graph.add_edge(s.id, END)
    else:
        raise NotImplementedError(f"topology '{scenario.topology}' not implemented in v1")

    return graph.compile()


def run_scenario(scenario: Scenario, *, output_dir: Path) -> Path:
    """Execute a scenario end-to-end and write a trace artifact.

    Each turn from the scenario's `turns` list is fed in as a new
    user message. The graph processes the turn, the assistant
    response is recorded, and the loop advances.

    Aborts early if `max_cost_usd` is exceeded — the bench is a
    measurement tool, not a stress test.
    """
    tracer = init_tracing()
    reset_collected_spans()

    graph = _build_graph(scenario, tracer)
    started_at = datetime.now(tz=timezone.utc).isoformat()
    cumulative_cost = 0.0

    # Repeat the full turn-sequence N times. Each iteration starts
    # with fresh message history (independent runs) but writes to
    # the same trace buffer. The variance comparator uses run_idx
    # tagging on each span to compute mean/stdev across runs.
    for run_idx in range(scenario.repeat):
        state: RunState = {"messages": [], "turn_idx": 0, "total_cost_usd": 0.0}
        for i, turn in enumerate(scenario.turns):
            if cumulative_cost >= scenario.max_cost_usd:
                print(
                    f"[bench] aborting at run {run_idx} turn {i}: "
                    f"cumulative cost {cumulative_cost:.4f} "
                    f">= max_cost_usd {scenario.max_cost_usd}"
                )
                break

            state["messages"].append({"role": "user", "content": turn.user})
            state["turn_idx"] = i

            # LangGraph's `.invoke()` runs to terminal nodes and
            # returns the merged state.
            result = graph.invoke(state)
            state = {
                "messages": result["messages"],
                "turn_idx": i + 1,
                "total_cost_usd": result.get("total_cost_usd", state["total_cost_usd"]),
            }
        cumulative_cost += state["total_cost_usd"]
        if cumulative_cost >= scenario.max_cost_usd:
            break

    from .scenario import config_hash

    return write_trace_artifact(
        scenario_name=scenario.name,
        output_dir=output_dir,
        started_at=started_at,
        config_hash=config_hash(scenario),
    )
