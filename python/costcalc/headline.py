"""headline.py — Headline composition math.

Mirrors: public/lib/headline-math.js function composeHeadline().

LLM line selection (first match wins):
  hybrid  → r.hybrid.total
  self    → r.self_host.total
  onprem  → workload.on_prem_monthly
  reservation enabled → r.reservation.effective_monthly
  else    → api.monthly_with_retry (preferred) or api.monthly_capped × retryInflate

headline = llm + fixed + verif + toolFees + fed + emb + pers + ae
"""
from __future__ import annotations

from typing import Any, Dict, Optional


def compose_headline(
    r: Dict[str, Any],
    w: Dict[str, Any],
    opts: Dict[str, Any],
    retry_inflate: float,
    ae_monthly: float = 0.0,
) -> Dict[str, Any]:
    """Mirrors composeHeadline() from headline-math.js.

    Parameters
    ----------
    r            : full engine result dict
    w            : normalized workload (only on_prem_monthly is read)
    opts         : options dict ({ hosting: ... })
    retry_inflate: fallback retryInflate multiplier (for callers without monthly_with_retry)
    ae_monthly   : agent engineering monthly cost (0 when disabled)
    """
    api_block = r.get("api") or {}
    if api_block.get("monthly_with_retry") is not None:
        api_bill = float(api_block["monthly_with_retry"])
    else:
        api_bill = float(api_block.get("monthly_capped") or 0) * (
            1.0 if retry_inflate is None else float(retry_inflate)
        )

    fixed = float((r.get("fixed_costs") or {}).get("total") or 0)
    verif = float((r.get("verification") or {}).get("monthly") or 0)
    tool_fees = float((r.get("tool_fees") or {}).get("monthly") or 0)
    fed = float((r.get("federal") or {}).get("additive_total") or 0)
    emb = float((r.get("embedding") or {}).get("monthly") or 0) if (r.get("embedding") or {}).get("enabled") else 0.0
    pers = float((r.get("personnel") or {}).get("monthly") or 0) if (r.get("personnel") or {}).get("enabled") else 0.0
    ae = float(ae_monthly) if ae_monthly else 0.0

    hosting = opts.get("hosting") or "api"
    if hosting == "hybrid" and r.get("hybrid"):
        llm = float(r["hybrid"].get("total") or 0)
    elif hosting == "self":
        llm = float((r.get("self_host") or {}).get("total") or 0)
    elif hosting == "onprem":
        llm = float(w.get("on_prem_monthly") or 0)
    elif (r.get("reservation") or {}).get("enabled"):
        llm = float(r["reservation"]["effective_monthly"])
    else:
        llm = api_bill

    headline = llm + fixed + verif + tool_fees + fed + emb + pers + ae
    return {
        "headline": headline,
        "llm": llm,
        "api_bill": api_bill,
        "fixed": fixed,
        "verif": verif,
        "tool_fees": tool_fees,
        "fed": fed,
        "emb": emb,
        "pers": pers,
        "ae": ae,
    }
