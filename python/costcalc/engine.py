"""engine.py — Top-level compute() orchestrator.

Mirrors: public/lib/cost-engine.js function compute() lines 2800-2883.

Wires all modules together. agent_per_query_fn is injected into
compute_api_cost to resolve the circular import between llm.py and agents.py.

Note: This implementation does NOT compute migration, risk_bands, break_even
or derivation traces — those are UI-only fields stripped by dump-engine.mjs
before parity testing.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from .workload import normalize_workload, compute_queries
from .llm import compute_api_cost
from .agents import per_query_cost_agents
from .selfhost import compute_self_host, compute_self_host_capped, compute_hybrid
from .verification import compute_verification
from .tools import compute_tool_fees
from .federal import compute_federal, compute_ato_from_prices
from .extras import compute_reservation, compute_embedding, compute_personnel, compute_agent_engineering
from .fixed import compute_fixed_costs
from .headline import compose_headline
from .prices import Prices


def compute(
    raw_workload: Dict[str, Any],
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Main entry point. Mirrors compute() from cost-engine.js.

    Parameters
    ----------
    raw_workload : workload JSON (parsed from .json file or programmatically built)
    options      : opts dict. Expected keys (mirroring buildOpts()):
                   hosting, model, tier, mix, costMode, botFactor,
                   cacheRate, verifCoverage, and optional:
                   batchShare, langMult, contextCompressionPct,
                   extraInputTokensPerQuery, retryInflate, apiSplit,
                   gpu, commitment, replicas, tokensPerQ,
                   diurnalPeakFactor, cacheWriteShare
    """
    workload = normalize_workload(raw_workload)
    opts = options or {}

    queries = compute_queries(workload, opts)

    # Inject agent function to avoid circular import
    def _agent_fn(wl, model_id, tier_id, eff_cache, o):
        return per_query_cost_agents(wl, model_id, tier_id, eff_cache, o)

    api = compute_api_cost(workload, queries, opts, agent_per_query_fn=_agent_fn)
    self_host = compute_self_host(workload, queries["total"], opts)
    self_host_capped = compute_self_host_capped(workload, queries["total"], self_host, opts)

    verification = compute_verification(workload, queries["total"], opts)
    tool_fees = compute_tool_fees(workload, queries, opts)
    federal = compute_federal(workload, queries["total"], api, opts)

    # ATO from prices.ato tiers overrides flat ato_monthly when set
    ato_from_prices = compute_ato_from_prices(workload)
    if ato_from_prices:
        federal["ato_from_tier"] = ato_from_prices
        federal["additive_total"] = (
            (federal.get("additive_total") or 0)
            - (federal.get("breakdown", {}).get("ato_monthly") or 0)
            + ato_from_prices["monthly"]
        )
        federal["breakdown"]["ato_monthly"] = ato_from_prices["monthly"]
        federal["breakdown"]["ato_tier"] = ato_from_prices["tier"]

    reservation = compute_reservation(workload, api["monthly_capped"], opts)
    embedding = compute_embedding(workload, queries["total"], opts)
    personnel = compute_personnel(workload, opts)
    fixed_costs = compute_fixed_costs(workload, queries["total"])

    # Hybrid: split traffic between API and self-host
    hybrid = None
    if opts.get("hosting") == "hybrid":
        hybrid = compute_hybrid(
            workload, queries, opts,
            compute_api_cost_fn=lambda wl, q, o: compute_api_cost(
                wl, q, o, agent_per_query_fn=_agent_fn
            ),
        )

    # Agent engineering
    ae_result = compute_agent_engineering(
        workload.get("agent_engineering"),
        Prices.get("personnel"),
    )
    ae_monthly = ae_result["monthly"] if ae_result.get("enabled") else 0.0

    # Headline composition
    retry_inflate = float(api.get("retry_inflate") or 1.0)
    headline_result = compose_headline(
        {
            "api": api,
            "fixed_costs": fixed_costs,
            "verification": verification,
            "tool_fees": tool_fees,
            "federal": federal,
            "embedding": embedding,
            "personnel": personnel,
            "reservation": reservation,
            "self_host": self_host,
            "hybrid": hybrid,
        },
        workload,
        opts,
        retry_inflate,
        ae_monthly,
    )

    return {
        "workload": workload,
        "queries": queries,
        "api": api,
        "self_host": self_host,
        "self_host_capped": self_host_capped,
        "verification": verification,
        "federal": federal,
        "tool_fees": tool_fees,
        "hybrid": hybrid,
        "reservation": reservation,
        "embedding": embedding,
        "personnel": personnel,
        "fixed_costs": fixed_costs,
        "agent_engineering": ae_result,
        "headline": headline_result,
    }
