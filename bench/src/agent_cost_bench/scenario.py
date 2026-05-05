"""Scenario loader — parses YAML specs into typed dataclasses.

A scenario describes:
  - an agent topology (single agent vs multi-agent)
  - prompt templates for each agent
  - the conversation/query flow (turns, parallelism)
  - which provider/model each agent uses

Keeping the spec in YAML — not Python — means a non-engineer can
write a new scenario, and the diff is readable. The runner consumes
the dataclasses below.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


@dataclass
class AgentSpec:
    """One agent in a scenario.

    Multiple agents in one scenario form a fleet (parallel) or a
    pipeline (sequential), depending on `topology` at the scenario
    level. Each agent gets its own LLM call per turn.
    """

    id: str
    role: str  # 'orchestrator' | 'specialist' | 'critic' | 'verifier' | etc.
    model: str  # LiteLLM identifier
    system_prompt: str
    temperature: float = 0.2
    max_output_tokens: int = 1000
    tools: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class TurnSpec:
    """One conversational turn — the user message that drives this turn."""

    user: str
    # If set, overrides the default agent for this turn (useful for
    # routing scenarios where different turns hit different agents).
    target_agent: str | None = None


@dataclass
class Scenario:
    """A complete benchmark scenario."""

    name: str
    description: str
    topology: str  # 'single' | 'sequential' | 'parallel' | 'orchestrator-specialists'
    agents: list[AgentSpec]
    turns: list[TurnSpec]
    # If set, runs the scenario this many times and aggregates
    # results. Useful for averaging out cache-warmup variability.
    repeat: int = 1
    # Hard cost cap per scenario run (in USD); the runner aborts
    # early if exceeded. Default is generous; CLI can override.
    max_cost_usd: float = 5.00
    # Free-form metadata: paper section, version, etc.
    meta: dict[str, Any] = field(default_factory=dict)


def load_scenario(path: Path) -> Scenario:
    """Parse a scenario YAML file into a Scenario object.

    Format:

        name: long-chat
        description: 30-turn analytical dialog with prompt caching enabled.
        topology: single
        agents:
          - id: analyst
            role: specialist
            model: claude-sonnet-4.6
            system_prompt: |
              You are a senior data analyst...
            temperature: 0.2
            max_output_tokens: 600
        turns:
          - user: "Tell me about NO2 trends over NYC, 2020-2024."
          - user: "How does that compare to Houston?"
          ...
    """
    raw = yaml.safe_load(path.read_text())

    agents = [
        AgentSpec(
            id=a["id"],
            role=a.get("role", "specialist"),
            model=a["model"],
            system_prompt=a.get("system_prompt", ""),
            temperature=a.get("temperature", 0.2),
            max_output_tokens=a.get("max_output_tokens", 1000),
            tools=a.get("tools", []),
        )
        for a in raw.get("agents", [])
    ]

    turns = [
        TurnSpec(
            user=t["user"] if isinstance(t, dict) else str(t),
            target_agent=t.get("target_agent") if isinstance(t, dict) else None,
        )
        for t in raw.get("turns", [])
    ]

    return Scenario(
        name=raw["name"],
        description=raw.get("description", ""),
        topology=raw.get("topology", "single"),
        agents=agents,
        turns=turns,
        repeat=raw.get("repeat", 1),
        max_cost_usd=raw.get("max_cost_usd", 5.00),
        meta=raw.get("meta", {}),
    )


def config_hash(scenario: Scenario) -> str:
    """Stable hash of the scenario config — used for trace artifact
    naming and reproducibility checks. Two runs with the same hash
    used the same prompts, models, and topology."""
    payload = {
        "name": scenario.name,
        "topology": scenario.topology,
        "agents": [
            {
                "id": a.id,
                "role": a.role,
                "model": a.model,
                "system_prompt": a.system_prompt,
                "temperature": a.temperature,
                "max_output_tokens": a.max_output_tokens,
                "tools": a.tools,
            }
            for a in scenario.agents
        ],
        "turns": [{"user": t.user, "target_agent": t.target_agent} for t in scenario.turns],
    }
    return "sha256:" + hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
