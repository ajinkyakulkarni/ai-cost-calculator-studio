"""tools.py — External tool fees (per-call / per-session provider charges).

Mirrors: public/lib/cost-engine.js computeToolFees() lines 1582-1633.

Billed for agents that have enabled_tools with rate_usd > 0.
cost_shape:
  'per_session' — billed per monthly session (sessions = Σ MAU × sess/day × 30 × bot)
  'per_call'/'free' — billed per monthly query
memoize reduces effective calls; trigger_rate gates per-tool.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional


def _to_float(x: Any, default: float = 0.0) -> float:
    if x is None:
        return default
    try:
        v = float(x)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def compute_tool_fees(
    workload: Dict[str, Any],
    queries: Dict[str, Any],
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Mirrors computeToolFees(). Returns {monthly, breakdown}."""
    reg = workload.get("tools_registry") or {}
    agents = workload.get("agents") or []
    if not agents:
        return {"monthly": 0.0, "breakdown": []}

    q_total = float((queries or {}).get("total") or 0)
    DAYS = 30

    # Monthly sessions: Σ seg.mau × sess/day × 30 × bot_factor (for anon segs)
    sessions_monthly = 0.0
    bot_effective = float((queries or {}).get("botEffective") or 1.0)
    for seg in workload.get("segments") or []:
        seg_apply_bot = seg.get("applyBotFactor")
        if seg_apply_bot is None:
            seg_apply_bot = seg.get("apply_bot_factor")
        beta = bot_effective if seg_apply_bot else 1.0
        sessions_monthly += float(seg.get("mau") or 0) * float(seg.get("sessions_per_day") or 0) * DAYS * beta

    monthly = 0.0
    breakdown: List[Dict[str, Any]] = []

    for agent in agents:
        a_rate_raw = agent.get("activation_rate")
        a_rate = _to_float(a_rate_raw, 1.0) if a_rate_raw is not None else 1.0
        ag_active = a_rate if (math.isfinite(a_rate) and 0.0 <= a_rate <= 1.0) else 1.0

        enabled = agent.get("enabled_tools") or {}
        for tid, spec in enabled.items():
            t = reg.get(tid)
            # Bill only when rate_usd > 0
            if not t or not t.get("rate_usd"):
                continue
            cpq = float((spec or {}).get("calls_per_query") or 0)
            if cpq <= 0:
                continue
            memo = _to_float(t.get("memoize_hit_rate") if t.get("memoize") else 0)
            call_mult = max(0.0, 1.0 - memo)
            trig_raw = (spec or {}).get("trigger_rate")
            trig = (
                _to_float(trig_raw)
                if (trig_raw is not None and 0.0 <= _to_float(trig_raw) <= 1.0)
                else 1.0
            )
            fee = 0.0
            if t.get("cost_shape") == "per_session":
                fee = cpq * t["rate_usd"] * sessions_monthly * call_mult * trig * ag_active
            else:
                # per_call or 'free' (default aggregation = per call)
                fee = cpq * t["rate_usd"] * q_total * call_mult * trig * ag_active
            if fee > 0:
                monthly += fee
                breakdown.append({
                    "agent": agent.get("id"),
                    "tool": tid,
                    "cost_shape": t.get("cost_shape"),
                    "monthly": fee,
                })

    return {"monthly": monthly, "breakdown": breakdown}
