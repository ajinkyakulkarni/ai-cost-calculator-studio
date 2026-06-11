"""verification.py — FactReasoner-style verification overhead.

Mirrors: public/lib/cost-engine.js
  - VARIANT_NLI_CALLS, VERIFIER_PRESETS lines 1390-1420
  - NLI_HOSTING_FLAT, NLI_HOSTING_FLAT_THROUGHPUT, NLI_HOSTING_TOKEN_MULT lines 1460-1505
  - _nliFlatUnitsRequired() lines 1489-1495
  - _verifCostForPreset() lines 1508-1570
  - computeVerification() lines 1635-1863

Verification shapes:
  nliBased     — atomize + per-claim NLI + revise (FactReasoner, MiniCheck, FactScore)
  selfCheck    — main LLM checks itself (RAGAS faithfulness, Anthropic citations)
  flatPerCheck — commercial fact-check API (Patronus, Galileo)

Per-agent mode: when any agent declares verify_enabled, walk agents and sum.
Workload-wide mode: one preset, one coverage fraction.
Cascading (escalation): primary verifier → secondary on flagged subset.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

# Per-query NLI call totals (already includes atoms_per_response multiplication)
VARIANT_NLI_CALLS: Dict[str, int] = {"fr1": 24, "fr2": 160, "fr3": 350}

VERIFIER_PRESETS: Dict[str, Any] = {
    "fr1":                {"label": "FactReasoner FR1 (lean)",                  "calibration": "measured",      "shape": "nliBased",     "nliCallsPerQuery": 24,  "latency_sec": 10,  "latency_class": "audit"},
    "fr2":                {"label": "FactReasoner FR2 (dense)",                 "calibration": "measured",      "shape": "nliBased",     "nliCallsPerQuery": 160, "latency_sec": 60,  "latency_class": "audit"},
    "fr3":                {"label": "FactReasoner FR3 (exhaustive)",            "calibration": "estimated",     "shape": "nliBased",     "nliCallsPerQuery": 350, "latency_sec": 120, "latency_class": "batch"},
    "minicheck":          {"label": "MiniCheck (CMU 2024) — single-call NLI",   "calibration": "estimated",     "shape": "nliBased",     "nliCallsPerQuery": 1,   "latency_sec": 1,   "latency_class": "inline", "skipAtomizer": True, "skipReviser": True},
    "factscore":          {"label": "FactScore (Min et al., UW 2023)",          "calibration": "estimated",     "shape": "nliBased",     "nliCallsPerQuery": 0,   "latency_sec": 20,  "latency_class": "audit",  "llmPerAtomTokens": {"input": 800, "output": 60}},
    "ragas-faithfulness": {"label": "RAGAS faithfulness — LLM self-check",      "calibration": "estimated",     "shape": "selfCheck",    "outputOverheadPct": 0.30, "latency_sec": 4, "latency_class": "inline"},
    "anthropic-citations":{"label": "Anthropic Claude citations (inline)",      "calibration": "estimated",     "shape": "selfCheck",    "outputOverheadPct": 0.10, "latency_sec": 0, "latency_class": "inline"},
    "patronus":           {"label": "Patronus AI (commercial)",                 "calibration": "vendor-listed", "shape": "flatPerCheck", "perCheckUsd": 0.010,    "latency_sec": 2,   "latency_class": "inline"},
    "galileo":            {"label": "Galileo Luna (commercial)",                "calibration": "vendor-listed", "shape": "flatPerCheck", "perCheckUsd": 0.015,    "latency_sec": 2,   "latency_class": "inline"},
    "custom":             {"label": "Custom (sliders below)",                   "calibration": "user-defined",  "shape": "nliBased",                               "latency_sec": 5,   "latency_class": "inline"},
}

NLI_HOSTING_FLAT: Dict[str, float] = {
    "ec2-g6": 588.0,
    "ec2-g5": 735.0,
    "bedrock-provisioned": 10950.0,
    "azure-ptu": 10000.0,
}

NLI_HOSTING_FLAT_THROUGHPUT: Dict[str, float] = {
    "ec2-g6": 80.0,
    "ec2-g5": 120.0,
    "bedrock-provisioned": 250.0,
    "azure-ptu": 250.0,
}

NLI_HOSTING_TOKEN_MULT: Dict[str, float] = {
    "api": 1.0,
    "bedrock-ondemand": 1.0,
    "azure-openai": 1.0,
}


def _nli_flat_units_required(
    verified_count: float,
    nli_calls_per_query: float,
    nli_hosting: str,
    workload: Dict[str, Any],
) -> int:
    """Mirrors _nliFlatUnitsRequired()."""
    throughput_per_unit = NLI_HOSTING_FLAT_THROUGHPUT.get(nli_hosting) or 100.0
    sh = (workload or {}).get("self_host") or {}
    diurnal = float(sh.get("diurnal_peak_factor") or 4)
    headroom = float(sh.get("headroom") or 1.5)
    mean_calls_per_sec = (verified_count * nli_calls_per_query) / (30 * 86400)
    peak_calls_per_sec = mean_calls_per_sec * diurnal * headroom
    return max(1, math.ceil(peak_calls_per_sec / throughput_per_unit))


def _token_cost_fn(rates: Dict[str, Any], mult: float):
    """Return a token-cost helper bound to rates/mult."""
    def tc(tokens: Dict[str, Any]) -> float:
        return (
            float(tokens.get("input") or 0) * rates["input_per_million"] / 1e6
            + float(tokens.get("output") or 0) * rates["output_per_million"] / 1e6
        ) * mult
    return tc


def _verif_cost_for_preset(
    preset: Dict[str, Any],
    verified_count: float,
    workload: Dict[str, Any],
    opts: Dict[str, Any],
    atoms: int,
) -> Dict[str, Any]:
    """Mirrors _verifCostForPreset(). Returns {monthly, breakdown, ...}."""
    v = workload.get("verification") or {}
    model_id = opts.get("verifModel") or opts.get("model") or workload["defaults"]["model"]
    tier_id = opts.get("tier") or workload["defaults"]["tier"]
    rates = workload["rate_cards"].get(model_id)
    mult = workload["tier_multipliers"].get(tier_id, 1.0)

    if preset.get("shape") == "selfCheck":
        anchor_out = float((workload.get("anchor_query") or {}).get("output_tokens") or 0)
        overhead_tokens = anchor_out * float(preset.get("outputOverheadPct") or 0)
        overhead_cost_per_q = (overhead_tokens * rates["output_per_million"] / 1e6 if rates else 0.0) * mult
        monthly = verified_count * overhead_cost_per_q
        return {"monthly": monthly, "breakdown": {"self_check_output_overhead": monthly}}

    if preset.get("shape") == "flatPerCheck":
        monthly = verified_count * float(preset.get("perCheckUsd") or 0)
        return {"monthly": monthly, "breakdown": {"commercial_flat": monthly}}

    # nliBased
    variant_key = preset.get("__variantKey", "fr1")
    nli_calls_per_query = (
        (v.get("atoms_per_response_nli_calls") or {}).get(variant_key)
        or preset.get("nliCallsPerQuery")
        or VARIANT_NLI_CALLS.get(variant_key, 24)
    )
    tc = _token_cost_fn(rates, mult) if rates else (lambda t: 0.0)

    atomizer_per_q = 0.0 if preset.get("skipAtomizer") else tc(v.get("atomizer_tokens") or {"input": 1500, "output": 400})
    reviser_per_q = 0.0 if preset.get("skipReviser") else atoms * tc(v.get("reviser_tokens") or {"input": 500, "output": 30})
    factscore_llm_per_q = (atoms * tc(preset["llmPerAtomTokens"])) if preset.get("llmPerAtomTokens") else 0.0

    nli_hosting = opts.get("nliHosting") or v.get("nli_hosting") or "api"
    nli_monthly = 0.0
    nli_flat_units = None
    if nli_hosting in NLI_HOSTING_TOKEN_MULT:
        nli_per_call = tc(v.get("nli_tokens") or {"input": 1200, "output": 20})
        nli_monthly = verified_count * nli_calls_per_query * nli_per_call * NLI_HOSTING_TOKEN_MULT[nli_hosting]
    elif nli_hosting in NLI_HOSTING_FLAT:
        nli_flat_units = _nli_flat_units_required(verified_count, nli_calls_per_query, nli_hosting, workload)
        nli_monthly = nli_flat_units * NLI_HOSTING_FLAT[nli_hosting]
    else:
        nli_monthly = 0.0

    retrieval = opts.get("retrieval") or v.get("retrieval") or "wikipedia"
    retrieval_monthly = verified_count * atoms * (5 / 1000) if retrieval == "serper" else 0.0

    atomizer_monthly = verified_count * atomizer_per_q
    reviser_monthly = verified_count * reviser_per_q
    factscore_llm_monthly = verified_count * factscore_llm_per_q
    monthly = atomizer_monthly + reviser_monthly + nli_monthly + factscore_llm_monthly + retrieval_monthly

    result = {
        "monthly": monthly,
        "breakdown": {
            "atomizer": atomizer_monthly,
            "reviser": reviser_monthly,
            "nli": nli_monthly,
            "factscore_llm_per_atom": factscore_llm_monthly,
            "retrieval": retrieval_monthly,
        },
        "nli_hosting": nli_hosting,
        "nli_calls_per_query": nli_calls_per_query,
    }
    if nli_flat_units is not None:
        result["nli_flat_units"] = nli_flat_units
    return result


def compute_verification(
    workload: Dict[str, Any],
    monthly_queries: float,
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Mirrors computeVerification(). Handles per-agent and workload-wide modes."""
    v = workload.get("verification")
    if not v or not v.get("enabled"):
        return {"enabled": False, "monthly": 0.0, "verified_queries": 0.0, "breakdown": {}}

    opts = options or {}
    coverage = (
        opts["verifCoverage"]
        if (opts.get("verifCoverage") is not None)
        else float(v.get("coverage") or 0)
    )
    variant = opts.get("verifVariant") or v.get("variant") or "fr1"
    atoms = int(v.get("atoms_per_response") or 8)
    service_pod = float(v.get("service_pod_monthly") or 0)

    base_preset_raw = VERIFIER_PRESETS.get(variant) or VERIFIER_PRESETS["fr1"]
    preset = dict(base_preset_raw, __variantKey=variant)

    # ----- Per-agent mode -----
    agents = workload.get("agents") or []
    per_agent_mode = any(a.get("verify_enabled") for a in agents)
    if per_agent_mode:
        total_monthly = 0.0
        total_verified = 0.0
        per_agent_breakdown: List[Dict[str, Any]] = []

        for a in agents:
            if not a.get("verify_enabled"):
                continue
            agent_preset_key = a.get("verifier_override") or variant
            agent_preset_raw = VERIFIER_PRESETS.get(agent_preset_key) or preset
            agent_preset = dict(agent_preset_raw, __variantKey=agent_preset_key)
            agent_cov = float(a["verify_coverage"]) if a.get("verify_coverage") is not None else coverage
            agent_calls = float(a.get("calls_per_query") or 1)
            agent_outputs = monthly_queries * agent_calls
            verified = agent_outputs * agent_cov
            total_verified += verified
            if verified <= 0:
                continue

            r = _verif_cost_for_preset(agent_preset, verified, workload, opts, atoms)

            # Cascading
            escalate_monthly = 0.0
            escalate_label = None
            escalate_key = a.get("verify_escalate_to") or v.get("escalate_to")
            if escalate_key and escalate_key in VERIFIER_PRESETS:
                esc_preset = dict(VERIFIER_PRESETS[escalate_key], __variantKey=escalate_key)
                esc_rate_raw = (
                    a.get("verify_escalate_rate") if a.get("verify_escalate_rate") is not None
                    else (v.get("escalate_rate") if v.get("escalate_rate") is not None else 0.10)
                )
                esc_rate = max(0.0, min(1.0, float(esc_rate_raw)))
                esc_outputs = verified * esc_rate
                if esc_outputs > 0:
                    er = _verif_cost_for_preset(esc_preset, esc_outputs, workload, opts, atoms)
                    escalate_monthly = er["monthly"]
                    escalate_label = esc_preset["label"]

            agent_monthly = r["monthly"] + escalate_monthly
            total_monthly += agent_monthly
            per_agent_breakdown.append({
                "id": a.get("id"),
                "label": a.get("label") or a.get("id"),
                "verifier": agent_preset.get("label"),
                "latency_class": agent_preset.get("latency_class"),
                "coverage": agent_cov,
                "verified_outputs": verified,
                "monthly": agent_monthly,
                "primary_monthly": r["monthly"],
                "escalate_to": escalate_label,
                "escalate_monthly": escalate_monthly,
            })

        return {
            "enabled": True,
            "coverage": coverage,
            "variant": variant,
            "per_agent_mode": True,
            "verified_queries": total_verified,
            "monthly": total_monthly + service_pod,
            "breakdown": {"service_pod": service_pod},
            "per_agent_breakdown": per_agent_breakdown,
            "preset": {
                "label": preset.get("label"),
                "calibration": preset.get("calibration"),
                "shape": preset.get("shape"),
                "latency_sec": preset.get("latency_sec"),
                "latency_class": preset.get("latency_class"),
            },
        }

    # ----- Workload-wide mode -----
    if coverage <= 0:
        return {
            "enabled": True, "coverage": 0.0, "monthly": 0.0,
            "verified_queries": 0.0, "breakdown": {},
            "variant": variant, "nli_hosting": v.get("nli_hosting"),
        }

    verified_queries = monthly_queries * coverage

    # Workload-wide cascading
    cascade_monthly = 0.0
    cascade_label = None
    cascade_rate = 0.0
    if v.get("escalate_to") and v["escalate_to"] in VERIFIER_PRESETS:
        esc_preset = dict(VERIFIER_PRESETS[v["escalate_to"]], __variantKey=v["escalate_to"])
        cascade_rate = max(0.0, min(1.0, float(v["escalate_rate"]) if v.get("escalate_rate") is not None else 0.10))
        esc_count = verified_queries * cascade_rate
        if esc_count > 0:
            er = _verif_cost_for_preset(esc_preset, esc_count, workload, opts, atoms)
            cascade_monthly = er["monthly"]
            cascade_label = esc_preset["label"]

    if preset.get("shape") == "selfCheck":
        rates = workload["rate_cards"].get(
            opts.get("verifModel") or opts.get("model") or workload["defaults"]["model"]
        )
        mult = workload["tier_multipliers"].get(opts.get("tier") or workload["defaults"]["tier"], 1.0)
        anchor_out = float((workload.get("anchor_query") or {}).get("output_tokens") or 0)
        overhead_tokens = anchor_out * float(preset.get("outputOverheadPct") or 0)
        overhead_per_q = (overhead_tokens * rates["output_per_million"] / 1e6 if rates else 0.0) * mult
        overhead_monthly = verified_queries * overhead_per_q
        return {
            "enabled": True, "coverage": coverage, "variant": variant,
            "verified_queries": verified_queries,
            "monthly": overhead_monthly + cascade_monthly,
            "breakdown": {
                "self_check_output_overhead": overhead_monthly,
                "cascade_escalation": cascade_monthly,
            },
            "preset": {"label": preset["label"], "calibration": preset["calibration"], "shape": preset["shape"]},
            "cascade": ({"escalate_to": cascade_label, "escalate_rate": cascade_rate, "monthly": cascade_monthly} if cascade_label else None),
            "nli_hosting": "none",
            "nli_calls_per_query": 0,
        }

    if preset.get("shape") == "flatPerCheck":
        flat_monthly = verified_queries * float(preset.get("perCheckUsd") or 0)
        return {
            "enabled": True, "coverage": coverage, "variant": variant,
            "verified_queries": verified_queries,
            "monthly": flat_monthly + service_pod + cascade_monthly,
            "breakdown": {
                "commercial_flat": flat_monthly,
                "service_pod": service_pod,
                "cascade_escalation": cascade_monthly,
            },
            "preset": {"label": preset["label"], "calibration": preset["calibration"], "shape": preset["shape"], "perCheckUsd": preset.get("perCheckUsd")},
            "cascade": ({"escalate_to": cascade_label, "escalate_rate": cascade_rate, "monthly": cascade_monthly} if cascade_label else None),
            "nli_hosting": "vendor",
            "nli_calls_per_query": 0,
        }

    # nliBased workload-wide
    r = _verif_cost_for_preset(preset, verified_queries, workload, opts, atoms)
    monthly = (
        r["monthly"] + service_pod + cascade_monthly
    )

    return {
        "enabled": True,
        "coverage": coverage,
        "variant": variant,
        "verified_queries": verified_queries,
        "monthly": monthly,
        "breakdown": {
            **r.get("breakdown", {}),
            "service_pod": service_pod,
            "cascade_escalation": cascade_monthly,
        },
        "preset": {"label": preset["label"], "calibration": preset["calibration"], "shape": preset["shape"]},
        "cascade": ({"escalate_to": cascade_label, "escalate_rate": cascade_rate, "monthly": cascade_monthly} if cascade_label else None),
        "nli_hosting": r.get("nli_hosting"),
        "nli_calls_per_query": r.get("nli_calls_per_query"),
    }
