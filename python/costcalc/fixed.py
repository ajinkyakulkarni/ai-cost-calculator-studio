"""fixed.py — Infrastructure fixed costs and rate-limit monthly cost.

Mirrors: public/lib/cost-engine.js
  - resolveInfraCost() lines 2340-2368
  - Fixed-cost accumulation in compute() lines 2838-2852

Cost shapes supported:
  number             — flat $/mo
  {flat: N}          — flat $/mo (alt form)
  {rate, per: 'per_query'}
  {rate, per: 'per_1k_queries'}
  {rate, per: 'per_million_queries'}
  {rate, per: 'per_gb_per_query', gb: N}
  {rate, per: 'per_mau'}
  {rate, per: 'per_session'}
"""
from __future__ import annotations

from typing import Any, Dict, Optional


def resolve_infra_cost(
    value: Any,
    monthly_queries: float,
    workload: Optional[Dict[str, Any]] = None,
) -> float:
    """Mirrors resolveInfraCost(). Also handles per_mau and per_session shapes."""
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, dict):
        return 0.0
    if value.get("flat") is not None:
        try:
            return float(value["flat"])
        except (TypeError, ValueError):
            return 0.0
    rate = float(value.get("rate") or 0)
    per = value.get("per")
    if per == "per_query":
        return rate * monthly_queries
    if per == "per_1k_queries":
        return rate * monthly_queries / 1000.0
    if per == "per_million_queries":
        return rate * monthly_queries / 1e6
    if per == "per_gb_per_query":
        gb = float(value.get("gb") or 0)
        return rate * monthly_queries * gb
    if per == "per_mau":
        segs = (workload or {}).get("segments") or [] if workload else []
        total_mau = sum(float(s.get("mau") or 0) for s in segs)
        return rate * total_mau
    if per == "per_session":
        turns = max(1.0, float(
            ((workload or {}).get("anchor_query") or {}).get("session_baseline_turns") or 8
        ))
        sessions = monthly_queries / turns
        return rate * sessions
    return 0.0


def compute_fixed_costs(
    workload: Dict[str, Any],
    monthly_queries: float,
) -> Dict[str, Any]:
    """Accumulate infra line items + rate_limit monthly cost."""
    infra_items = workload.get("infrastructure") or {}
    infra_breakdown: Dict[str, float] = {}
    infra_sum = 0.0
    for name, val in infra_items.items():
        cost = resolve_infra_cost(val, monthly_queries, workload)
        infra_breakdown[name] = cost
        infra_sum += cost
    rate_limit_cost = float((workload.get("rate_limit") or {}).get("monthly_cost") or 0)
    return {
        "infrastructure": infra_sum,
        "infrastructure_breakdown": infra_breakdown,
        "rate_limit": rate_limit_cost,
        "total": infra_sum + rate_limit_cost,
    }
