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

from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from .provider import call_llm
from .scenario import AgentSpec, Scenario
from .tracing import init_tracing, reset_collected_spans, write_trace_artifact


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
        for m in state["messages"]:
            clean: dict = {"role": _msg_attr(m, "role"), "content": _msg_attr(m, "content")}
            tc = _msg_attr(m, "tool_calls")
            if tc:
                clean["tool_calls"] = tc
            tcid = _msg_attr(m, "tool_call_id")
            if tcid:
                clean["tool_call_id"] = tcid
            msgs.append(clean)

        result = call_llm(
            tracer,
            model=agent.model,
            messages=msgs,
            temperature=agent.temperature,
            max_tokens=agent.max_output_tokens,
            tools=agent.tools or None,
        )

        # Append the assistant turn to state so the next user message
        # builds on it.
        return {
            "messages": [{"role": "assistant", "content": result.content}],
            "total_cost_usd": state["total_cost_usd"] + result.cost_usd,
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
    state: RunState = {"messages": [], "turn_idx": 0, "total_cost_usd": 0.0}
    started_at = datetime.now(tz=timezone.utc).isoformat()

    for i, turn in enumerate(scenario.turns):
        if state["total_cost_usd"] >= scenario.max_cost_usd:
            print(
                f"[bench] aborting at turn {i}: cost {state['total_cost_usd']:.4f} "
                f">= max_cost_usd {scenario.max_cost_usd}"
            )
            break

        # Append the next user turn and invoke the graph.
        state["messages"].append({"role": "user", "content": turn.user})
        state["turn_idx"] = i

        # LangGraph's `.invoke()` runs to terminal nodes and returns
        # the merged state.
        result = graph.invoke(state)
        state = {
            "messages": result["messages"],
            "turn_idx": i + 1,
            "total_cost_usd": result.get("total_cost_usd", state["total_cost_usd"]),
        }

    from .scenario import config_hash

    return write_trace_artifact(
        scenario_name=scenario.name,
        output_dir=output_dir,
        started_at=started_at,
        config_hash=config_hash(scenario),
    )
