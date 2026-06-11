"""selfhost.py — Self-host GPU sizing and cost.

Mirrors: public/lib/cost-engine.js
  - computeSelfHost() lines 1183-1272
  - computeSelfHostCapped() lines 1879-1929
  - computeBreakEven() lines 1288-1363
  - computeHybrid() lines 2767-2795
"""
from __future__ import annotations

import math
from typing import Any, Dict, Optional

from .llm import hosting_multiplier


def compute_self_host(
    workload: Dict[str, Any],
    monthly_queries: float,
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Mirrors computeSelfHost()."""
    opts = options or {}
    sh = workload["self_host"]
    gpu_id = opts.get("gpu") or next(iter(sh["gpu_options"].keys()))
    commitment_id = opts.get("commitment") or "ri-1y"
    replicas = opts["replicas"] if opts.get("replicas") is not None else sh["min_replicas"]
    tokens_per_q_base = opts.get("tokensPerQ") or sh["tokens_per_query_default"]
    cost_mode = opts.get("costMode") or "optimistic"

    gpu = sh["gpu_options"][gpu_id]
    params = sh["cost_modes"][cost_mode]

    if commitment_id == "on-demand":
        disc = 0.0
    elif commitment_id == "ri-1y":
        disc = float(params["discount_1yr"])
    else:
        disc = float(params["discount_3yr"])

    # Language multiplier + compression (same as API side)
    lang_mult_raw = opts.get("langMult")
    lang_mult_sh = float(lang_mult_raw) if (lang_mult_raw is not None and float(lang_mult_raw) > 0) else 1.0
    compression_raw = opts.get("contextCompressionPct")
    compression_savings_sh = max(0.0, min(0.7, float(compression_raw) if compression_raw is not None else 0.0))
    token_scalar_sh = lang_mult_sh * (1.0 - compression_savings_sh)
    tokens_per_q = float(tokens_per_q_base) * token_scalar_sh

    eff_tput = float(gpu["tput_tps"]) * float(params["throughput_derate"])
    qps_avg = monthly_queries / (30 * 86400)

    # Diurnal peak factor: opts override only when > 1 (lazy default 1× doesn't undercut safer 4×)
    user_peak_raw = opts.get("diurnalPeakFactor")
    user_peak = float(user_peak_raw) if user_peak_raw is not None else 0.0
    effective_peak = (
        user_peak
        if (math.isfinite(user_peak) and user_peak > 1)
        else float(sh["diurnal_peak_factor"])
    )
    peak_tps = qps_avg * tokens_per_q * effective_peak * float(sh["headroom"])
    needed_by_load = math.ceil(peak_tps / eff_tput) if eff_tput > 0 else 0
    min_floor = max(int(sh["min_replicas"]), int(replicas))
    instances = max(needed_by_load, min_floor)

    gpu_hourly_eff = float(gpu["hourly"]) * (1.0 - disc)
    host_mult = hosting_multiplier(workload)

    # Duty cycle
    duty_cycle = max(0.05, min(1.0, float(sh.get("duty_cycle") or 1.0)))
    effective_hours = 730.0 * duty_cycle

    gpu_monthly = instances * gpu_hourly_eff * effective_hours * host_mult
    ops_monthly_eff = float(params["ops_monthly"]) * host_mult

    platform = sh.get("compute_platform") or "fargate"
    k8s_hidden = float(sh.get("k8s_hidden_cost") or 5333) if platform == "k8s" else 0.0

    total = (
        gpu_monthly
        + ops_monthly_eff
        + float(params["fte_monthly"])
        + float(params["setup_amortized"])
        + k8s_hidden
    )

    return {
        "gpu_spec": gpu,
        "cost_mode": cost_mode,
        "compute_platform": platform,
        "qps_avg": qps_avg,
        "tokens_per_query": tokens_per_q,
        "tokens_per_query_base": float(tokens_per_q_base),
        "token_scalar": token_scalar_sh,
        "peak_tps": peak_tps,
        "effective_tput": eff_tput,
        "needed_by_load": needed_by_load,
        "instances": instances,
        "gpu_monthly": gpu_monthly,
        "ops_monthly": ops_monthly_eff,
        "fte_monthly": float(params["fte_monthly"]),
        "setup_amortized": float(params["setup_amortized"]),
        "k8s_hidden_cost": k8s_hidden,
        "hosting_multiplier": host_mult,
        "duty_cycle": duty_cycle,
        "effective_hours": effective_hours,
        "total": total,
        "effective_per_query": total / monthly_queries if monthly_queries > 0 else 0.0,
    }


def compute_self_host_capped(
    workload: Dict[str, Any],
    monthly_queries: float,
    peer_self_host: Dict[str, Any],
    options: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Mirrors computeSelfHostCapped(). Equal-budget scenario."""
    opts = options or {}
    dc = workload.get("daily_cap") or {}
    if not dc.get("enabled"):
        return None
    monthly_budget = float(dc.get("amount_usd") or 0) * 30
    if monthly_budget <= 0:
        return None

    cost_mode = opts.get("costMode") or "optimistic"
    gpu_id = opts.get("gpu") or next(iter(workload["self_host"]["gpu_options"].keys()))
    commitment_id = opts.get("commitment") or "ri-1y"
    params = workload["self_host"]["cost_modes"][cost_mode]
    gpu = workload["self_host"]["gpu_options"][gpu_id]

    if commitment_id == "on-demand":
        disc = 0.0
    elif commitment_id == "ri-1y":
        disc = float(params["discount_1yr"])
    else:
        disc = float(params["discount_3yr"])

    host_mult = hosting_multiplier(workload)
    fixed = float(params["ops_monthly"]) * host_mult + float(params["fte_monthly"]) + float(params["setup_amortized"])
    gpu_hourly_eff = float(gpu["hourly"]) * (1.0 - disc) * host_mult
    duty_cycle = max(0.05, min(1.0, float(workload["self_host"].get("duty_cycle") or 1.0)))
    effective_hours = 730.0 * duty_cycle
    budget_for_gpu = max(0.0, monthly_budget - fixed)
    gpu_hour_cost = gpu_hourly_eff * effective_hours
    instances_affordable = math.floor(budget_for_gpu / gpu_hour_cost) if gpu_hour_cost > 0 else 0
    instances = max(0, min(instances_affordable, peer_self_host["instances"]))
    gpu_monthly = instances * gpu_hour_cost
    total = gpu_monthly + fixed

    capacity = instances * float(peer_self_host.get("effective_tput") or 0)
    peak_tps = float(peer_self_host.get("peak_tps") or 0)
    frac_served = min(1.0, capacity / peak_tps) if peak_tps > 0 else 1.0
    served = monthly_queries * frac_served
    refused = monthly_queries - served

    return {
        "scenario": "equal-budget",
        "monthly_budget": monthly_budget,
        "instances": instances,
        "instances_affordable": instances_affordable,
        "gpu_monthly": gpu_monthly,
        "total": total,
        "fraction_served": frac_served,
        "queries_served": served,
        "queries_refused": refused,
        "budget_binding": instances_affordable < peer_self_host["instances"],
        "note": "Equal-budget projection only.",
    }


def compute_hybrid(
    workload: Dict[str, Any],
    queries: Dict[str, Any],
    options: Optional[Dict[str, Any]] = None,
    *,
    compute_api_cost_fn: Any = None,
) -> Dict[str, Any]:
    """Mirrors computeHybrid(). Injects compute_api_cost_fn to avoid circular import."""
    import copy
    opts = options or {}
    split = min(1.0, max(0.0, opts.get("apiSplit") if opts.get("apiSplit") is not None else 0.5))

    def scale_queries(q: Dict[str, Any], frac: float) -> Dict[str, Any]:
        out = copy.deepcopy(q)
        out["total"] = q["total"] * frac
        out["bySegment"] = {k: v * frac for k, v in (q.get("bySegment") or {}).items()}
        out["auth"] = float(q.get("auth") or 0) * frac
        out["anon"] = float(q.get("anon") or 0) * frac
        return out

    api_q = scale_queries(queries, split)
    sh_q = scale_queries(queries, 1.0 - split)
    api_part = compute_api_cost_fn(workload, api_q, opts) if compute_api_cost_fn else {}
    sh_part = compute_self_host(workload, sh_q["total"], opts)

    return {
        "api_share": split,
        "self_share": 1.0 - split,
        "api_part": api_part,
        "self_part": sh_part,
        "api_queries": api_q["total"],
        "self_queries": sh_q["total"],
        "total": float(api_part.get("monthly_capped") or 0) + sh_part["total"],
    }
