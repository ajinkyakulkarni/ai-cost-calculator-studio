"""archetype.py — cost estimation for variable, non-fixed-pipeline agents.

See python/docs/archetype-cost-spec.md for the full model.

Unlike the engine's anchor-query model (one query profile scaled by per-shape
factors — exact for a fixed pipeline), this estimates an agent whose queries
fan out across archetypes with genuinely different absolute token profiles.
Each archetype carries its own cumulative {input, cached, output} token totals;
the helper prices each per cycle and blends by an expected mix.

Pricing reuses the SAME primitives as llm.py: per-million input/cached/output
rates from prices.DEFAULT_RATE_CARDS and the tier multiplier from
prices.DEFAULT_TIER_MULTIPLIERS — so numbers stay consistent with the calc.

Pure functions, stdlib only. Does not import or affect any engine module.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from .prices import DEFAULT_RATE_CARDS, DEFAULT_TIER_MULTIPLIERS


def _cycle_cost(
    input_tokens: float,
    cached_tokens: float,
    output_tokens: float,
    rates: Dict[str, float],
    tier_mult: float,
) -> float:
    """Cost of one cycle. Mirrors llm.py's cached-input math:
    (fresh·in + cached·cached + output·out) / 1e6 × tier_multiplier."""
    fresh = input_tokens - cached_tokens
    return (
        fresh * rates["input_per_million"]
        + cached_tokens * rates["cached_per_million"]
        + output_tokens * rates["output_per_million"]
    ) / 1e6 * tier_mult


def _scaled_profile(arch: Dict[str, Any], factor: float) -> Dict[str, float]:
    """Scale a profile's token counts by `factor`, holding the cached *ratio*
    constant so a band still satisfies cached ≤ input."""
    inp = float(arch["input_tokens"]) * factor
    cached = float(arch["cached_tokens"]) * factor
    out = float(arch["output_tokens"]) * factor
    return {"input": inp, "cached": cached, "output": out}


def archetype_cost(
    archetypes: List[Dict[str, Any]],
    model: str = "gpt-5.4",
    tier: str = "standard",
    cycles_per_month: float = 0.0,
    *,
    rate_cards: Optional[Dict[str, Any]] = None,
    tier_multipliers: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    """Estimate per-cycle and blended monthly cost for an archetype mix.

    Args:
        archetypes: list of profiles, each with keys
            name, share, input_tokens, cached_tokens, output_tokens
            (optional: tool_calls, turns, low_factor, high_factor — informational
             / band controls).
        model: rate-card key (default gpt-5.4).
        tier: tier-multiplier key (standard/flex/batch/priority).
        cycles_per_month: total cycles/month across all archetypes; blended
            monthly = Σ share_normalized × cycle_cost × cycles_per_month.
        rate_cards / tier_multipliers: override the price book (for tests).

    Returns dict:
        {
          "model", "tier", "tier_multiplier", "cycles_per_month",
          "shares_sum_raw",            # pre-normalization, for a warning
          "archetypes": [ {name, share, share_normalized, tool_calls, turns,
                           input, cached, output, fresh,
                           cost_cycle, cost_cycle_low, cost_cycle_high,
                           monthly} ],
          "blended": {"cost_per_cycle", "monthly", "monthly_low", "monthly_high"}
        }

    Raises:
        ValueError on unknown model/tier, empty list, or cached>input.
    """
    cards = rate_cards if rate_cards is not None else DEFAULT_RATE_CARDS
    tiers = tier_multipliers if tier_multipliers is not None else DEFAULT_TIER_MULTIPLIERS

    if not archetypes:
        raise ValueError("archetype_cost: archetypes list is empty")
    rates = cards.get(model)
    if not rates:
        raise ValueError(f"archetype_cost: unknown model {model!r}")
    if tier not in tiers:
        raise ValueError(f"archetype_cost: unknown tier {tier!r}")
    tier_mult = float(tiers[tier])

    # Validate + normalize shares.
    shares_sum = 0.0
    for a in archetypes:
        if float(a["cached_tokens"]) > float(a["input_tokens"]):
            raise ValueError(
                f"archetype {a.get('name', '?')!r}: cached_tokens "
                f"({a['cached_tokens']}) > input_tokens ({a['input_tokens']}) — "
                "cached is a subset of input."
            )
        shares_sum += float(a.get("share", 0))
    norm = shares_sum if shares_sum > 0 else 1.0

    rows: List[Dict[str, Any]] = []
    blended_cycle = 0.0
    blended_low = 0.0
    blended_high = 0.0
    for a in archetypes:
        share = float(a.get("share", 0))
        share_n = share / norm
        exp = _scaled_profile(a, 1.0)
        cost = _cycle_cost(exp["input"], exp["cached"], exp["output"], rates, tier_mult)

        lo = _scaled_profile(a, float(a.get("low_factor", 1.0)))
        hi = _scaled_profile(a, float(a.get("high_factor", 1.0)))
        cost_lo = _cycle_cost(lo["input"], lo["cached"], lo["output"], rates, tier_mult)
        cost_hi = _cycle_cost(hi["input"], hi["cached"], hi["output"], rates, tier_mult)

        rows.append({
            "name": a.get("name", "?"),
            "share": share,
            "share_normalized": share_n,
            "tool_calls": a.get("tool_calls"),
            "turns": a.get("turns"),
            "input": exp["input"],
            "cached": exp["cached"],
            "output": exp["output"],
            "fresh": exp["input"] - exp["cached"],
            "cost_cycle": cost,
            "cost_cycle_low": cost_lo,
            "cost_cycle_high": cost_hi,
            "monthly": share_n * cost * cycles_per_month,
        })
        blended_cycle += share_n * cost
        blended_low += share_n * cost_lo
        blended_high += share_n * cost_hi

    return {
        "model": model,
        "tier": tier,
        "tier_multiplier": tier_mult,
        "cycles_per_month": cycles_per_month,
        "shares_sum_raw": shares_sum,
        "archetypes": rows,
        "blended": {
            "cost_per_cycle": blended_cycle,
            "monthly": blended_cycle * cycles_per_month,
            "monthly_low": blended_low * cycles_per_month,
            "monthly_high": blended_high * cycles_per_month,
        },
    }
