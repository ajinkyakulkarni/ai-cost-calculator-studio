"""extras.py — Embeddings, personnel, reservations, and agent engineering.

Mirrors: public/lib/cost-engine.js
  - computeEmbedding() lines 2510-2539
  - computePersonnel() lines 2545-2569
  - computeReservation() + ptuSizing() lines 2450-2501
  - TPS_PER_PTU lines 2386-2401

Agent engineering (computeAgentEngineering) from public/lib/headline-math.js
and scripts/calc.js:
  upfront = Σ fte_i × loaded_annual_i × (duration/12) + helper_monthly × duration
  amortized_monthly = upfront / amortization_months
  maintenance_monthly = lead_loaded_hourly × hours_per_session / interval_months
"""
from __future__ import annotations

import math
from typing import Any, Dict, Optional

from .prices import Prices
from .llm import task_mix_output_multiplier
from .workload import compute_queries

# Per-model TPS per PTU (Azure published table)
TPS_PER_PTU: Dict[str, float] = {
    "gpt-4o": 50.0,
    "gpt-4o-mini": 200.0,
    "gpt-5": 30.0,
    "gpt-5.5": 25.0,
    "gpt-5.4": 35.0,
    "gpt-5.2": 40.0,
    "gpt-5.1": 50.0,
    "gpt-5-mini": 150.0,
    "gpt-5-nano": 400.0,
    "claude-opus-4.7": 30.0,
    "claude-sonnet-4.6": 50.0,
    "claude-haiku-4.5": 200.0,
    "gemini-3.1-pro": 50.0,
    "_default": 50.0,
}


def compute_embedding(
    workload: Dict[str, Any],
    monthly_queries: float,
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Mirrors computeEmbedding()."""
    e = workload.get("embedding") or {}
    if not e.get("enabled"):
        return {"enabled": False, "monthly": 0.0, "ingest_amortized": 0.0, "query_monthly": 0.0}
    model_id = e.get("model") or "text-embedding-3-small"
    model = (Prices.get("embeddings") or {}).get(model_id)
    if not model:
        return {"enabled": False, "monthly": 0.0, "ingest_amortized": 0.0, "query_monthly": 0.0}
    rate_per_m = float(model.get("dollar_per_million_tokens") or 0)
    corpus_tokens = float(e.get("corpus_size_tokens") or 0)
    reembed_months = max(1, int(e.get("reembed_frequency_months") or 12))
    ingest_total = corpus_tokens * rate_per_m / 1e6
    ingest_amortized = ingest_total / reembed_months
    query_tokens = float(e.get("query_embedding_tokens") or 8)
    query_monthly = query_tokens * monthly_queries * rate_per_m / 1e6
    return {
        "enabled": True,
        "model": model_id,
        "provider": model.get("provider"),
        "rate_per_million": rate_per_m,
        "corpus_tokens": corpus_tokens,
        "reembed_months": reembed_months,
        "ingest_total_cost": ingest_total,
        "ingest_amortized": ingest_amortized,
        "query_tokens": query_tokens,
        "query_monthly": query_monthly,
        "monthly": ingest_amortized + query_monthly,
    }


def compute_personnel(
    workload: Dict[str, Any],
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Mirrors computePersonnel()."""
    p = workload.get("personnel") or {}
    if not p.get("enabled") or not isinstance(p.get("roles"), list) or not p["roles"]:
        return {"enabled": False, "monthly": 0.0, "breakdown": []}
    breakdown = []
    monthly = 0.0
    for r in p["roles"]:
        defn = (Prices.get("personnel") or {}).get(r.get("role"))
        if not defn:
            continue
        fte = float(r.get("fte") or 0)
        loaded = float(defn.get("annual_base") or 0) * float(defn.get("total_comp_multiplier") or 1)
        m = fte * loaded / 12.0
        monthly += m
        breakdown.append({
            "role": r.get("role"),
            "fte": fte,
            "annual_base": defn.get("annual_base"),
            "total_comp_multiplier": defn.get("total_comp_multiplier"),
            "loaded_annual": loaded,
            "monthly": m,
        })
    return {"enabled": True, "monthly": monthly, "breakdown": breakdown}


def ptu_sizing(workload: Dict[str, Any], options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Mirrors ptuSizing()."""
    opts = options or {}
    r = workload.get("reservations") or {}
    model_id = opts.get("model") or (workload.get("defaults") or {}).get("model")
    tps_per_ptu = (
        r.get("tps_per_ptu")
        if r.get("tps_per_ptu") is not None
        else TPS_PER_PTU.get(model_id, TPS_PER_PTU["_default"])
    )
    mix_id = opts.get("mix") or (workload.get("defaults") or {}).get("mix")
    mix = (workload.get("mix") or {}).get(mix_id, {})
    mix_weights = (mix.get("weights") if mix else None) or {"full": 1.0}
    anchor = workload.get("anchor_query") or {}
    tm_out_mult = task_mix_output_multiplier(workload)
    tokens_per_query = 0.0
    for shape_name, weight in mix_weights.items():
        s = (workload.get("shapes") or {}).get(shape_name)
        if not s:
            continue
        in_t = float(s.get("input_factor") or 0) * float(anchor.get("input_tokens") or 0)
        out_t = float(s.get("output_factor") or 0) * float(anchor.get("output_tokens") or 0) * tm_out_mult
        tokens_per_query += weight * (in_t + out_t)
    if tokens_per_query == 0:
        tokens_per_query = float((workload.get("self_host") or {}).get("tokens_per_query_default") or 2000)

    baseline_queries = compute_queries(workload, opts)
    qps_avg = baseline_queries["total"] / (30 * 86400)
    diurnal = float((workload.get("self_host") or {}).get("diurnal_peak_factor") or 4)
    headroom = float((workload.get("self_host") or {}).get("headroom") or 1.5)
    peak_tps = qps_avg * tokens_per_query * diurnal * headroom
    units = max(1, math.ceil(peak_tps / tps_per_ptu))
    return {
        "units": units,
        "peak_tps": peak_tps,
        "qps_avg": qps_avg,
        "tokens_per_query": tokens_per_query,
        "tps_per_ptu": tps_per_ptu,
        "model": model_id,
        "diurnal_peak_factor": diurnal,
        "headroom": headroom,
    }


def compute_reservation(
    workload: Dict[str, Any],
    api_cost_monthly: float,
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Mirrors computeReservation()."""
    r = workload.get("reservations") or {}
    if not r.get("enabled") or not r.get("type") or r["type"] == "none":
        return {"enabled": False, "applied_discount": 0.0, "fixed_monthly": 0.0, "effective_monthly": api_cost_monthly, "savings": 0.0}

    spec = (Prices.get("api_reservations") or {}).get(r["type"])
    if not spec:
        return {"enabled": False, "applied_discount": 0.0, "fixed_monthly": 0.0, "effective_monthly": api_cost_monthly, "savings": 0.0}

    if spec.get("dollar_per_unit_per_month") is not None:
        units = r.get("units") or 1
        sizing_detail = None
        if r.get("auto_size_ptu"):
            sizing_detail = ptu_sizing(workload, options)
            units = sizing_detail["units"]
        fixed = float(units) * float(spec["dollar_per_unit_per_month"])
        savings = max(0.0, api_cost_monthly - fixed)
        return {
            "enabled": True,
            "type": r["type"],
            "spec": spec,
            "units": units,
            "auto_sized": bool(r.get("auto_size_ptu")),
            "sizing_detail": sizing_detail,
            "applied_discount": 0.0,
            "fixed_monthly": fixed,
            "effective_monthly": fixed,
            "savings": savings,
            "notes": f"{units} PTU × ${spec['dollar_per_unit_per_month']}/mo = ${fixed:.0f}/mo flat",
        }

    if spec.get("discount") and spec["discount"] > 0:
        discounted = api_cost_monthly * (1.0 - spec["discount"])
        savings = api_cost_monthly - discounted
        return {
            "enabled": True,
            "type": r["type"],
            "spec": spec,
            "applied_discount": spec["discount"],
            "fixed_monthly": 0.0,
            "effective_monthly": discounted,
            "savings": savings,
            "notes": f"{int(spec['discount']*100)}% discount on API spend",
        }

    return {"enabled": False, "applied_discount": 0.0, "fixed_monthly": 0.0, "effective_monthly": api_cost_monthly, "savings": 0.0}


def compute_agent_engineering(
    ae: Optional[Dict[str, Any]],
    personnel_prices: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Mirrors computeAgentEngineering() from headline-math.js / calc.js.

    Inputs:
      ae                 workload.agent_engineering block
      personnel_prices   Prices.personnel map (role → {annual_base, total_comp_multiplier})
    """
    ae = ae or {}
    if not ae.get("enabled"):
        return {"enabled": False, "upfront": 0.0, "amortized_monthly": 0.0, "maintenance_monthly": 0.0, "monthly": 0.0}

    prices = personnel_prices or {}
    dur = max(0.0, float(ae.get("duration_months") or 0))
    amort = max(1.0, float(ae.get("amortization_months") or 36))
    helper = max(0.0, float(ae.get("helper_agent_monthly") or 0))
    roles = ae.get("roles") if isinstance(ae.get("roles"), list) else []

    upfront = 0.0
    for r in roles:
        defn = prices.get(r.get("role")) or {}
        loaded = float(defn.get("annual_base") or 0) * float(defn.get("total_comp_multiplier") or 1)
        upfront += float(r.get("fte") or 0) * loaded * (dur / 12.0)
    upfront += helper * dur

    amortized_monthly = upfront / amort
    lead = prices.get("agent_design_lead")
    maintenance_monthly = 0.0
    if lead and lead.get("annual_base"):
        lead_loaded = float(lead["annual_base"]) * float(lead.get("total_comp_multiplier") or 1)
        lead_hourly = lead_loaded / 2080.0
        interval = max(1.0, float(ae.get("maintenance_interval_months") or 6))
        hours_per_session = max(0.0, float(ae.get("maintenance_hours_per_session") or 0))
        maintenance_monthly = (lead_hourly * hours_per_session) / interval

    return {
        "enabled": True,
        "upfront": upfront,
        "amortized_monthly": amortized_monthly,
        "maintenance_monthly": maintenance_monthly,
        "monthly": amortized_monthly + maintenance_monthly,
    }
