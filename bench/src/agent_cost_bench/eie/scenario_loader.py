"""Typed loader for eie-templating scenario YAMLs."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass(frozen=True)
class ScenarioCfg:
    id: str
    pattern: str         # 'paper' | 'eie'
    handler_mode: str    # 'status_only' | 'key_fields' | 'freeform'
    model: str           # litellm model identifier
    description: str
    enforce_compute_stats: bool = False
    emit_map: bool = False


def load_scenario(path: Path) -> ScenarioCfg:
    with path.open() as f:
        data = yaml.safe_load(f)
    return ScenarioCfg(
        id=data["id"],
        pattern=data["pattern"],
        handler_mode=data["handler_mode"],
        model=data.get("model", "gpt-5.2"),
        description=data.get("description", ""),
        enforce_compute_stats=data.get("enforce_compute_stats", False),
        emit_map=data.get("emit_map", False),
    )
