"""federal.py — Federal additive line items and ATO compliance.

Mirrors: public/lib/cost-engine.js
  - computeFederal() lines 1941-1976
  - computeAtoFromPrices() lines 2577-2595
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from .llm import hosting_multiplier
from .prices import Prices


def compute_federal(
    workload: Dict[str, Any],
    monthly_queries: float,
    api_result: Optional[Dict[str, Any]] = None,
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Mirrors computeFederal(). Returns hosting premium + additive line items."""
    f = workload.get("federal") or {}
    ato = float(f.get("ato_monthly") or 0)
    egress_gb = float(f.get("egress_gb_per_query") or 0) * monthly_queries
    egress = egress_gb * float(f.get("egress_cost_per_gb") or 0)

    # Audit retention: KB/query × queries / 1024² → GB/mo × 12 × years × $/GB-mo
    audit_gb_per_month = float(f.get("audit_log_kb_per_query") or 0) * monthly_queries / (1024 * 1024)
    audit_total_gb = audit_gb_per_month * 12 * float(f.get("audit_retention_years") or 0)
    audit = audit_total_gb * float(f.get("audit_storage_per_gb_month") or 0)

    retrieval = float(f.get("retrieval_infra_monthly") or 0)

    pii = 0.0
    if f.get("pii_redaction_per_million_tokens") and workload.get("anchor_query"):
        anchor = workload["anchor_query"]
        tokens_per_q = float(anchor.get("input_tokens") or 0) + float(anchor.get("output_tokens") or 0)
        pii = monthly_queries * tokens_per_q * float(f.get("pii_redaction_per_million_tokens") or 0) / 1e6

    additive = ato + egress + audit + retrieval + pii

    hosting_premium_api = 0.0
    if api_result:
        hosting_premium_api = float(api_result.get("monthly_capped") or 0) - float(api_result.get("monthly_capped_pre_federal") or 0)

    return {
        "hosting_multiplier": hosting_multiplier(workload),
        "fedramp_tier": f.get("fedramp_tier") or "none",
        "multi_region": f.get("multi_region") or "single",
        "breakdown": {
            "ato_monthly": ato,
            "egress_monthly": egress,
            "egress_gb_total": egress_gb,
            "audit_retention_monthly": audit,
            "audit_total_gb": audit_total_gb,
            "retrieval_infra_monthly": retrieval,
            "pii_redaction_monthly": pii,
        },
        "additive_total": additive,
        "hosting_premium_api": hosting_premium_api,
    }


def compute_ato_from_prices(workload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Mirrors computeAtoFromPrices()."""
    c = workload.get("compliance") or {}
    tier = c.get("ato_tier")
    if not tier or tier == "none":
        return None
    defn = (Prices.get("ato") or {}).get(tier)
    if not defn:
        return None
    amort_months = int(c.get("upfront_amortization_months") or 36)
    upfront_monthly = float(defn.get("upfront") or 0) / amort_months
    continuous_monthly = float(defn.get("annual_continuous_monitoring") or 0) / 12
    return {
        "tier": tier,
        "upfront": defn.get("upfront"),
        "annual_continuous": defn.get("annual_continuous_monitoring"),
        "amortization_months": amort_months,
        "upfront_monthly": upfront_monthly,
        "continuous_monthly": continuous_monthly,
        "monthly": upfront_monthly + continuous_monthly,
    }
