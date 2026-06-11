"""llm.py — Per-query token math, cache split, tier multipliers, retry, daily cap.

Mirrors: public/lib/cost-engine.js
  - effectiveCacheRate() / resolveEffectiveCacheRate() lines 825-846
  - effectiveCachedRate() lines 859-875
  - CACHE_RATE_PER_TURN_ADJ / TURN_ADJ_BOUND constants lines 813-823
  - taskMixOutputMultiplier() / taskMixOutputMultiplierForAgent() lines 902-936
  - perQueryCost() lines 938-973
  - computeApiCost() lines 1019-1178
  - hostingMultiplier() lines 1009-1014

Key JS behavior to match:
  - effectiveCachedRate: when rates has no cached_write_per_million, return p_read
    (OpenAI auto-prefix: no write-share premium at all). This is NOT the same as
    w*p_in + (1-w)*p_read when p_write=p_in, because the explicit write fields
    absence is the signal that write-share should be ignored entirely.
  - Daily-cap clamping order: apply host mult FIRST, cap on real-dollar spend,
    then divide back out for monthly_capped_pre_federal (pre-mult view).
  - retryInflate applied to (cappedScaled + extraInputCost) * llmScalar.
  - per_query_blended = blended * hostMult * llmScalar (no retry in per-query).
"""
from __future__ import annotations

import math
from typing import Any, Dict, Optional

from .prices import FEDRAMP_MULTIPLIERS, MULTI_REGION_MULTIPLIERS

# ---------------------------------------------------------------------------
# Constants (cost-engine.js lines 813-823)
# ---------------------------------------------------------------------------
CACHE_RATE_PER_TURN_ADJ = 0.01
TURN_ADJ_BOUND = 0.15

# Task-mix output multipliers (cost-engine.js lines 886-913)
TASK_MIX_OUT_MULT: Dict[str, float] = {
    "classify": 0.30,
    "summary": 0.65,
    "rag": 0.85,
    "code": 2.80,
    "longform": 3.60,
    "agent": 4.30,
}
TASK_MIX_DEFAULT_PCT: Dict[str, float] = {
    "classify": 20, "summary": 25, "rag": 20, "code": 15, "longform": 10, "agent": 10,
}

def _compute_baseline_wom() -> float:
    t = 0.0
    s = 0.0
    for k, mult in TASK_MIX_OUT_MULT.items():
        p = TASK_MIX_DEFAULT_PCT.get(k, 0.0)
        t += p
        s += p * mult
    return s / t if t > 0 else 1.0

TASK_MIX_BASELINE_WOM: float = _compute_baseline_wom()


# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------

def effective_cache_rate(
    baseline: float,
    questions_per_session: float,
    baseline_turns: float,
) -> float:
    """Eq. 3 per-turn cache adjustment. Mirrors effectiveCacheRate()."""
    raw_adj = (questions_per_session - baseline_turns) * CACHE_RATE_PER_TURN_ADJ
    turn_adj = min(TURN_ADJ_BOUND, max(-TURN_ADJ_BOUND, raw_adj))
    return min(0.99, max(0.0, baseline + turn_adj))


def resolve_effective_cache_rate(
    workload: Dict[str, Any],
    baseline: float,
    questions_per_session: float,
) -> float:
    """Mirrors resolveEffectiveCacheRate(): honors cache_baseline_pre_averaged."""
    anchor = workload.get("anchor_query") or {}
    if anchor.get("cache_baseline_pre_averaged") is True:
        return min(0.99, max(0.0, baseline))
    baseline_turns = anchor.get("session_baseline_turns") or 6
    return effective_cache_rate(baseline, questions_per_session, baseline_turns)


def effective_cached_rate(rates: Dict[str, Any], write_share: Optional[float]) -> float:
    """Eq. 2 cache blend. Mirrors effectiveCachedRate().

    Critical: if rates has no cached_write_per_million key, return p_read
    (OpenAI auto-prefix — no separate write surcharge).
    """
    p_in = rates["input_per_million"]
    p_read_raw = rates.get("cached_per_million")
    p_read = p_read_raw if p_read_raw is not None else p_in * 0.1

    # If no explicit cached_write_per_million: pure cached_read (OpenAI/Gemini style)
    if rates.get("cached_write_per_million") is None:
        return p_read

    p_write = rates["cached_write_per_million"]
    w = write_share if (write_share is not None and not _is_nan(write_share)) else 0.0
    return w * p_write + (1 - w) * p_read


def _is_nan(x: Any) -> bool:
    try:
        return math.isnan(float(x))
    except (TypeError, ValueError):
        return False


# ---------------------------------------------------------------------------
# Task mix multiplier
# ---------------------------------------------------------------------------

def task_mix_output_multiplier(w: Dict[str, Any]) -> float:
    """Mirrors taskMixOutputMultiplier()."""
    tm = w.get("task_mix")
    if not tm or not isinstance(tm, dict):
        return 1.0
    total = 0.0
    wom = 0.0
    for k, mult in TASK_MIX_OUT_MULT.items():
        pct = tm.get(k)
        if pct is None:
            continue
        try:
            pct = float(pct)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(pct) or pct < 0:
            continue
        total += pct
        wom += pct * mult
    if total <= 0:
        return 1.0
    return (wom / total) / TASK_MIX_BASELINE_WOM


def task_mix_output_multiplier_for_agent(agent: Dict[str, Any], w: Dict[str, Any]) -> float:
    """Mirrors taskMixOutputMultiplierForAgent()."""
    bias = (agent or {}).get("task_bias")
    if bias and bias in TASK_MIX_OUT_MULT:
        mix_sim = {k: (60.0 if k == bias else 8.0) for k in TASK_MIX_OUT_MULT}
        return task_mix_output_multiplier({"task_mix": mix_sim})
    return task_mix_output_multiplier(w)


# ---------------------------------------------------------------------------
# Hosting multiplier (FedRAMP × multi-region)
# ---------------------------------------------------------------------------

def hosting_multiplier(workload: Dict[str, Any]) -> float:
    """Mirrors hostingMultiplier()."""
    f = (workload or {}).get("federal") or {}
    fr = FEDRAMP_MULTIPLIERS.get(f.get("fedramp_tier") or "none", 1.0)
    mr = MULTI_REGION_MULTIPLIERS.get(f.get("multi_region") or "single", 1.0)
    return fr * mr


# ---------------------------------------------------------------------------
# Clarification strategy
# ---------------------------------------------------------------------------

def apply_clarification_strategy(workload: Dict[str, Any], cycle_cost: float) -> float:
    """Mirrors applyClarificationStrategy()."""
    cs = workload.get("clarification_strategy")
    if not cs or not cs.get("selected") or cs["selected"] == "none":
        return cycle_cost
    tunables = cs.get("tunables") or {}
    f = float(tunables["f_naive"] if tunables.get("f_naive") is not None else 0.5)
    r = float(tunables["recovery_rate"] if tunables.get("recovery_rate") is not None else 0.9)
    opt = (cs.get("options") or {}).get(cs["selected"]) or {}

    if cs["selected"] == "pre_flight_gate":
        g = float(opt["gate_cost_per_call_usd"] if opt.get("gate_cost_per_call_usd") is not None else 0.0014)
        return g * (1 + r * f) + (1 - f * (1 - r)) * cycle_cost

    if cs["selected"] == "per_stage_confirm":
        mode = workload.get("tool_response_mode")
        if mode == "freeform":
            mult = float(opt["cycle_cost_multiplier_freeform"] if opt.get("cycle_cost_multiplier_freeform") is not None else 1.31)
        else:
            mult = float(opt["cycle_cost_multiplier_templated"] if opt.get("cycle_cost_multiplier_templated") is not None else 1.73)
        return cycle_cost * mult

    return cycle_cost


# ---------------------------------------------------------------------------
# Per-query cost: shape × mix blend (workload mode)
# ---------------------------------------------------------------------------

def per_query_cost(
    workload: Dict[str, Any],
    model_id: str,
    tier_id: str,
    mix_id: str,
    cache_rate: float,
    write_share: Optional[float] = 0.0,
) -> float:
    """Mirrors perQueryCost(). Returns cost per query in dollars."""
    rates = workload["rate_cards"].get(model_id)
    if not rates:
        return 0.0
    mult = workload["tier_multipliers"].get(tier_id, 1.0)
    mix = (workload.get("mix") or {}).get(mix_id)
    if not mix or not mix.get("weights"):
        return 0.0

    anchor_in = float((workload["anchor_query"] or {}).get("input_tokens") or 0)
    anchor_out = float((workload["anchor_query"] or {}).get("output_tokens") or 0) * task_mix_output_multiplier(workload)
    p_cached_eff = effective_cached_rate(rates, write_share)

    total = 0.0
    total_weight = 0.0
    for shape_name, weight in (mix.get("weights") or {}).items():
        shape = (workload.get("shapes") or {}).get(shape_name)
        if not shape:
            continue
        in_t = anchor_in * float(shape.get("input_factor") or 1)
        out_t = anchor_out * float(shape.get("output_factor") or 1)
        eff = cache_rate if shape.get("cache_eligible") else 0.0
        cached = in_t * eff
        uncached = in_t - cached
        shape_cost = (
            uncached * rates["input_per_million"] / 1e6
            + cached * p_cached_eff / 1e6
            + out_t * rates["output_per_million"] / 1e6
        ) * mult
        total += weight * shape_cost
        total_weight += weight

    cycle_cost = total / total_weight if total_weight > 0 else 0.0
    return apply_clarification_strategy(workload, cycle_cost)


# ---------------------------------------------------------------------------
# API monthly cost
# ---------------------------------------------------------------------------

def compute_api_cost(
    workload: Dict[str, Any],
    queries: Dict[str, Any],
    options: Optional[Dict[str, Any]] = None,
    *,
    agent_per_query_fn: Any = None,
) -> Dict[str, Any]:
    """Mirrors computeApiCost().

    agent_per_query_fn is injected from engine.py to avoid circular imports.
    Signature: agent_per_query_fn(workload, model_id, tier_id, eff_cache, opts) -> dict
    """
    opts = options or {}
    model_id = opts.get("model") or workload["defaults"]["model"]
    tier_id = opts.get("tier") or workload["defaults"]["tier"]
    mix_id = opts.get("mix") or workload["defaults"]["mix"]

    cache_base = (
        opts["cacheRate"]
        if opts.get("cacheRate") is not None
        else (workload.get("anchor_query") or {}).get("cache_rate_baseline", 0.7)
    )

    # write_share: opts → anchor_query → rate-card default → 0
    if opts.get("cacheWriteShare") is not None:
        write_share = opts["cacheWriteShare"]
    elif (workload.get("anchor_query") or {}).get("cache_write_share") is not None:
        write_share = workload["anchor_query"]["cache_write_share"]
    elif (workload.get("rate_cards") or {}).get(model_id, {}).get("cache_write_share_default") is not None:
        write_share = workload["rate_cards"][model_id]["cache_write_share_default"]
    else:
        write_share = 0.0

    agent_mode = bool(workload.get("agents")) and len(workload["agents"]) > 0

    seg_per_query: Dict[str, Any] = {}
    total_cost = 0.0
    agent_breakdown = None

    for seg in workload.get("segments") or []:
        eff = resolve_effective_cache_rate(
            workload, cache_base, float(seg.get("questions_per_session") or 0)
        )
        if agent_mode and agent_per_query_fn is not None:
            ar = agent_per_query_fn(workload, model_id, tier_id, eff, opts)
            pq = ar["per_query"]
            if agent_breakdown is None:
                agent_breakdown = ar["breakdown"]
        else:
            pq = per_query_cost(workload, model_id, tier_id, mix_id, eff, write_share)
        seg_per_query[seg["id"]] = {"eff_cache": eff, "per_query": pq}
        total_cost += float(queries["bySegment"].get(seg["id"]) or 0) * pq

    blended = total_cost / queries["total"] if queries["total"] > 0 else 0.0

    # FedRAMP/multi-region multiplier applied before daily cap
    host_mult = hosting_multiplier(workload)
    gross_with_host = total_cost * host_mult

    # Daily-cap clamping (paper §2.5)
    cap = workload.get("daily_cap") or {}
    capped_with_host = gross_with_host
    monthly_refused = 0.0
    if cap.get("enabled") and (cap.get("amount_usd") or 0) > 0:
        daily_avg = gross_with_host / 30.0
        burst_days = float(cap.get("burst_days") or 0)
        steady_days = 30.0 - burst_days
        burst_factor = float(cap.get("burst_factor") or 1)
        daily_burst = daily_avg * burst_factor
        daily_steady_capped = min(daily_avg, cap["amount_usd"])
        daily_burst_capped = min(daily_burst, cap["amount_usd"])
        capped_with_host = steady_days * daily_steady_capped + burst_days * daily_burst_capped
        refused_fraction = (
            max(0.0, (gross_with_host - capped_with_host) / gross_with_host)
            if gross_with_host > 0 else 0.0
        )
        monthly_refused = queries["total"] * refused_fraction

    monthly_capped = capped_with_host / (host_mult or 1)  # pre-multiplier view

    # Language multiplier
    lang_mult_raw = opts.get("langMult")
    lang_mult = float(lang_mult_raw) if (lang_mult_raw is not None and float(lang_mult_raw) > 0) else 1.0

    # Batch tier share
    batch_share_raw = opts.get("batchShare")
    batch_share = float(batch_share_raw) if batch_share_raw is not None else 0.0
    batch_share = max(0.0, min(1.0, batch_share))
    batch_tier_mult = (workload.get("tier_multipliers") or {}).get("batch") or 0.5
    batch_scalar = (1 - batch_share) + batch_share * batch_tier_mult

    # Context compression
    compression_pct_raw = opts.get("contextCompressionPct")
    compression_savings = max(0.0, min(0.7, float(compression_pct_raw) if compression_pct_raw is not None else 0.0))
    compression_scalar = 1.0 - compression_savings

    # Extra input tokens per query
    extra_in_tokens_per_q = max(0.0, float(opts.get("extraInputTokensPerQuery") or 0))
    extra_input_cost = 0.0
    if extra_in_tokens_per_q > 0:
        rates = workload["rate_cards"].get(model_id)
        if rates:
            first_seg = (workload.get("segments") or [{}])[0]
            eff_first = resolve_effective_cache_rate(
                workload, cache_base, float(first_seg.get("questions_per_session") or 6)
            )
            p_cached_eff_extra = effective_cached_rate(rates, write_share)
            tokens = extra_in_tokens_per_q * queries["total"]
            uncached_e = tokens * (1 - eff_first)
            cached_e = tokens * eff_first
            tier_mult_e = (workload.get("tier_multipliers") or {}).get(tier_id, 1.0)
            extra_input_cost = (
                uncached_e * rates["input_per_million"] / 1e6
                + cached_e * p_cached_eff_extra / 1e6
            ) * tier_mult_e * host_mult

    llm_scalar = lang_mult * batch_scalar * compression_scalar
    capped_scaled = (capped_with_host + extra_input_cost) * llm_scalar

    # Retry inflate (Eq. 5: LLM_api × (1 + 1.5r))
    if opts.get("retryInflate") is not None:
        retry_inflate = float(opts["retryInflate"])
    else:
        retry_inflate = 1.0 + 1.5 * float(opts.get("retry_rate") or 0)

    monthly_with_retry = capped_scaled * retry_inflate

    return {
        "monthly_gross": gross_with_host,
        "monthly_capped": capped_scaled,
        "monthly_with_retry": monthly_with_retry,
        "retry_inflate": retry_inflate,
        "lang_mult": lang_mult,
        "batch_share": batch_share,
        "batch_scalar": batch_scalar,
        "monthly_gross_pre_federal": total_cost,
        "monthly_capped_pre_federal": monthly_capped * llm_scalar,
        "hosting_multiplier": host_mult,
        "monthly_refused_queries": monthly_refused,
        "per_query_blended": blended * host_mult * llm_scalar,
        "per_segment": seg_per_query,
        "agent_mode": agent_mode,
        "agent_breakdown": agent_breakdown,
    }
