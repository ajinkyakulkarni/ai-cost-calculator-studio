"""Run one eie-templating scenario end-to-end and write a trace JSON.

The runner is the thinnest possible glue between:
  - scenario_loader (which scenario YAML to run)
  - handlers (which middleware to wrap tool returns with)
  - pattern_paper / pattern_eie (which state machine to drive)
  - the LLM provider (real calls through provider_shim.call_llm)

Trace artifact captures per-turn input/output/cached tokens, every
LLM message, every tool call, and a final summary suitable for the
report generator to read.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .handlers import FreeformHandler, KeyFieldsHandler, StatusOnlyHandler
from .pattern_paper import build_pattern_p_graph, initial_state as paper_initial
from .pattern_eie import build_pattern_e_graph, initial_state as eie_initial
from .scenario_loader import ScenarioCfg
from .user_actor import UserActor


REPORTS_DIR = Path(__file__).resolve().parents[3] / "reports" / "eie-templating"


def _make_handler(mode: str):
    if mode == "status_only":
        return StatusOnlyHandler()
    if mode == "key_fields":
        return KeyFieldsHandler()
    if mode == "freeform":
        return FreeformHandler()
    raise ValueError(f"unknown handler mode: {mode!r}")


def run_scenario(cfg: ScenarioCfg, max_turns: int = 30) -> Path:
    """Execute one scenario, write trace JSON, return the trace path."""
    handler = _make_handler(cfg.handler_mode)
    if cfg.pattern == "paper":
        graph = build_pattern_p_graph(handler=handler, model=cfg.model)
        state = paper_initial(
            handler=handler,
            model=cfg.model,
            enforce_compute_stats=cfg.enforce_compute_stats,
            emit_map=cfg.emit_map,
        )
    elif cfg.pattern == "eie":
        actor = UserActor.frozen_default()
        graph = build_pattern_e_graph(handler=handler, user_actor=actor, model=cfg.model)
        state = eie_initial(
            handler=handler,
            user_actor=actor,
            model=cfg.model,
            enforce_compute_stats=cfg.enforce_compute_stats,
            emit_map=cfg.emit_map,
        )
    else:
        raise ValueError(f"unknown pattern: {cfg.pattern!r}")
    state["model"] = cfg.model
    t0 = time.time()
    final = graph.invoke(state, {"recursion_limit": max_turns})
    elapsed = time.time() - t0
    trace = _build_trace(cfg, final, elapsed)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    out_path = REPORTS_DIR / f"{cfg.id}-{ts}.trace.json"
    with out_path.open("w") as f:
        json.dump(trace, f, indent=2)
    return out_path


def _extract_text_content(msg: Any) -> str:
    """Return the text content of a message (raw dict or LangChain object)."""
    if isinstance(msg, dict):
        content = msg.get("content") or ""
    else:
        content = getattr(msg, "content", "") or ""
    if isinstance(content, str):
        return content
    # LangChain can store content as a list of content blocks
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                parts.append(block.get("text") or "")
        return "".join(parts)
    return ""


def _extract_map_url_from_messages(messages: list[Any]) -> str | None:
    """Scan tool result messages for a render_map result containing map_url.

    Tool result messages have role 'tool'. Their content is the string returned
    by the handler — for KeyFields/Freeform it is JSON with a ``map_url`` key;
    for StatusOnly it is a JSON object with ``summary`` containing the URL.
    """
    for msg in messages:
        role = msg.get("role") if isinstance(msg, dict) else getattr(msg, "type", None)
        if role not in ("tool", "function"):
            continue
        content = _extract_text_content(msg)
        if not content:
            continue
        # Try to parse as JSON and look for map_url
        try:
            parsed = json.loads(content)
            if isinstance(parsed, dict):
                if "map_url" in parsed:
                    return str(parsed["map_url"])
                # StatusOnly wraps map_url in summary: "map ready: <url>"
                summary = parsed.get("summary") or ""
                if summary.startswith("map ready: "):
                    return summary[len("map ready: "):]
        except (json.JSONDecodeError, ValueError):
            pass
    return None


def _build_trace(cfg: ScenarioCfg, final_state: dict[str, Any], elapsed_s: float) -> dict[str, Any]:
    """Aggregate per-turn usage and build a trace dict."""
    messages = final_state.get("messages", [])
    turns: list[dict[str, Any]] = []
    total_input = total_output = total_cached = 0

    # Extract top-level enrichment fields from messages
    # LangGraph converts {"role": "user", ...} dicts to HumanMessage (type="human")
    user_query: str = ""
    for msg in messages:
        role = msg.get("role") if isinstance(msg, dict) else getattr(msg, "type", None)
        if role in ("user", "human"):
            user_query = _extract_text_content(msg)
            break

    final_answer: str = ""
    for msg in reversed(messages):
        role = msg.get("role") if isinstance(msg, dict) else getattr(msg, "type", None)
        if role in ("assistant", "ai"):
            text = _extract_text_content(msg)
            if text:
                final_answer = text[:2000]
                break

    map_url: str | None = _extract_map_url_from_messages(messages)

    for msg in messages:
        # Support both raw dict messages and LangChain message objects
        role = msg.get("role") if isinstance(msg, dict) else getattr(msg, "type", None)
        # LangChain AIMessage has type == "ai"; raw dicts use role == "assistant"
        if role not in ("assistant", "ai"):
            continue
        if isinstance(msg, dict):
            usage = msg.get("_usage") or {}
        else:
            # LangGraph stores extra raw-dict keys in additional_kwargs
            additional = getattr(msg, "additional_kwargs", {}) or {}
            usage = additional.get("_usage") or {}
        in_t = int(usage.get("prompt_tokens") or 0)
        out_t = int(usage.get("completion_tokens") or 0)
        # OpenAI returns cached_tokens inside prompt_tokens_details
        cached = 0
        details = usage.get("prompt_tokens_details") or {}
        if isinstance(details, dict):
            cached = int(details.get("cached_tokens") or 0)
        tool_calls_raw = (msg.get("tool_calls") if isinstance(msg, dict)
                          else getattr(msg, "tool_calls", None)) or []
        tool_names: list[str] = []
        tool_calls_detail: list[dict[str, Any]] = []
        for tc in tool_calls_raw:
            if isinstance(tc, dict) and "function" in tc:
                name = tc["function"]["name"]
                raw_args = tc["function"].get("arguments") or "{}"
                try:
                    args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                except (json.JSONDecodeError, ValueError):
                    args = {}
            elif isinstance(tc, dict):
                name = tc.get("name", "unknown")
                args = tc.get("args") or {}
            else:
                name = getattr(tc, "name", "unknown")
                args = getattr(tc, "args", {}) or {}
            tool_names.append(name)
            tool_calls_detail.append({"name": name, "args": args})
        assistant_text = _extract_text_content(msg)[:500]
        turns.append({
            "input_tokens": in_t,
            "output_tokens": out_t,
            "cached_tokens": cached,
            "tool_calls": tool_names,
            "tool_calls_detail": tool_calls_detail,
            "assistant_text": assistant_text,
        })
        total_input += in_t
        total_output += out_t
        total_cached += cached
    n_turns = len(turns)
    cache_hit_rate = (total_cached / total_input) if total_input else 0.0
    return {
        "scenario_id": cfg.id,
        "pattern": cfg.pattern,
        "handler_mode": cfg.handler_mode,
        "model": cfg.model,
        "enforce_compute_stats": cfg.enforce_compute_stats,
        "emit_map": cfg.emit_map,
        "turn_count": n_turns,
        "elapsed_s": elapsed_s,
        "user_query": user_query,
        "final_answer": final_answer,
        "map_url": map_url,
        "totals": {
            "input_tokens": total_input,
            "output_tokens": total_output,
            "cached_tokens": total_cached,
            "cache_hit_rate": cache_hit_rate,
        },
        "per_turn_avg": {
            "input_tokens": (total_input / n_turns) if n_turns else 0,
            "output_tokens": (total_output / n_turns) if n_turns else 0,
        },
        "turns": turns,
    }
