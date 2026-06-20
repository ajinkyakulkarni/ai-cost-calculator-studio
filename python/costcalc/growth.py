"""growth.py — intra-cycle context-growth model.

An archetype profile carries the CUMULATIVE {input, cached, output} tokens of a
whole cycle. Those cumulative totals are produced by a multi-turn cycle whose
input grows each turn as conversation history + tool results accumulate. This
module turns a per-turn description into the cumulative profile the archetype
helper consumes — the same accumulation the stakeholder doc did by hand, and the
same one python/examples/derive_planning_profile.py used for Planning.

Two entry points:
  cycle_from_turns(base, steps, cache_ratio)  — explicit per-turn trace.
  cycle_uniform(base, turns, added_per_turn, output_per_turn, cache_ratio)
                                              — a friendly uniform parameterization.

Accumulation (deterministic): each turn re-sends the full running context
(base + all history so far). input_t = base + running_history; the cycle's
cumulative input is Σ input_t.

Caching (the empirically fuzzy part): cached = round(cache_ratio × cumulative
input). The doc measured cache_ratio = 184,917 / 233,498 = 0.7919 for a
multi-turn tool-orchestration cycle; that is exposed as DOC_CACHE_RATIO and is
a reasonable default until you have per-call cached-token telemetry.

Pure functions, stdlib only.
"""
from __future__ import annotations

from typing import Any, Dict, List, Sequence, Tuple

# Empirical cache share for a multi-turn accumulating cycle, from the
# stakeholder doc's Multi-source numbers (184,917 cached / 233,498 input).
DOC_CACHE_RATIO = 184917 / 233498  # 0.79195...


def cycle_from_turns(
    base_tokens: float,
    steps: Sequence[Tuple[float, float]],
    cache_ratio: float = DOC_CACHE_RATIO,
) -> Dict[str, Any]:
    """Cumulative cycle profile from a per-turn trace.

    Args:
        base_tokens: constant context resent every turn (system prompt + tool
            schemas), before any conversation history.
        steps: ordered list of (added_to_context, output) per turn — tokens
            entering context this turn (user msg + incoming tool result) and the
            model's output that turn.
        cache_ratio: fraction of cumulative input that caches (default: the
            doc's measured 0.7919). Must be 0..1.

    Returns: {input_tokens, cached_tokens, output_tokens, turns}.
    """
    if not 0.0 <= cache_ratio <= 1.0:
        raise ValueError(f"cache_ratio must be in [0,1], got {cache_ratio}")
    running_history = 0.0
    cum_input = 0.0
    cum_output = 0.0
    prev_output = 0.0
    for added, out in steps:
        running_history += prev_output + float(added)
        input_t = base_tokens + running_history
        cum_input += input_t
        cum_output += float(out)
        prev_output = float(out)
    return {
        "input_tokens": round(cum_input),
        "cached_tokens": round(cum_input * cache_ratio),
        "output_tokens": round(cum_output),
        "turns": len(steps),
    }


def cycle_uniform(
    base_tokens: float,
    turns: int,
    added_per_turn: float,
    output_per_turn: float,
    cache_ratio: float = DOC_CACHE_RATIO,
) -> Dict[str, Any]:
    """Cumulative cycle profile assuming every turn adds the same amount.

    A friendly parameterization for the UI: instead of a full per-turn trace,
    give an average context-growth and output per turn. Equivalent to
    cycle_from_turns with a uniform steps list.
    """
    steps: List[Tuple[float, float]] = [
        (float(added_per_turn), float(output_per_turn)) for _ in range(int(turns))
    ]
    return cycle_from_turns(base_tokens, steps, cache_ratio)
