"""workload.py — Workload normalization and query volume derivation.

Mirrors: public/lib/cost-engine.js
  - normalizeWorkload() lines 286-348
  - computeQueries() lines 978-1001
  - DEFAULT_TOOLS_REGISTRY lines 138-284
  - DEFAULT_FEDERAL lines 92-103

Python semantics note: JS `x || y` for objects/arrays becomes
`x if x is not None else y` here, matching JS falsy-for-null behavior
while preserving 0 and False (which are valid numeric values in some
fields like burst_factor and mau).
"""
from __future__ import annotations

import copy
import math
from typing import Any, Dict, List, Optional

from .prices import (
    DEFAULT_RATE_CARDS,
    DEFAULT_GPU_CATALOG,
    DEFAULT_COST_MODES,
    DEFAULT_TIER_MULTIPLIERS,
)

# ---------------------------------------------------------------------------
# Default tools registry (mirrors cost-engine.js lines 138-284)
# ---------------------------------------------------------------------------
DEFAULT_TOOLS_REGISTRY: Dict[str, Any] = {
    "web_search": {
        "label": "Web Search",
        "description": "Provider-managed web search (OpenAI / Anthropic / Vertex grounding)",
        "cost_shape": "per_call",
        "rate_usd": 0.010,
        "schema_tokens": 120,
        "result_tokens_avg": 800,
        "return_shape": "freeform",
        "cap_tokens": 80,
        "memoize": False,
        "memoize_hit_rate": 0.0,
        "provider": "managed",
        "builtin": True,
    },
    "file_search": {
        "label": "File Search",
        "description": "Provider-managed vector retrieval over attached docs",
        "cost_shape": "per_call",
        "rate_usd": 0.0025,
        "schema_tokens": 80,
        "result_tokens_avg": 1200,
        "return_shape": "freeform",
        "cap_tokens": 60,
        "memoize": False,
        "memoize_hit_rate": 0.0,
        "provider": "managed",
        "builtin": True,
    },
    "container_session": {
        "label": "Code Interpreter / Container",
        "description": "Sandboxed code-execution session (1GB, 30-min default)",
        "cost_shape": "per_session",
        "rate_usd": 0.03,
        "schema_tokens": 200,
        "result_tokens_avg": 400,
        "return_shape": "freeform",
        "cap_tokens": 80,
        "memoize": False,
        "memoize_hit_rate": 0.0,
        "provider": "managed",
        "builtin": True,
    },
    "wikipedia_retrieval": {
        "label": "Wikipedia Retrieval (free)",
        "description": "Self-hosted or free public Wikipedia lookup",
        "cost_shape": "free",
        "rate_usd": 0,
        "schema_tokens": 80,
        "result_tokens_avg": 600,
        "return_shape": "freeform",
        "cap_tokens": 50,
        "memoize": False,
        "memoize_hit_rate": 0.0,
        "provider": "self-hosted",
        "builtin": True,
    },
    "internal_db_query": {
        "label": "Internal DB Query (placeholder)",
        "description": "Example custom MCP server entry",
        "cost_shape": "free",
        "rate_usd": 0,
        "schema_tokens": 150,
        "result_tokens_avg": 500,
        "return_shape": "freeform",
        "cap_tokens": 40,
        "memoize": False,
        "memoize_hit_rate": 0.0,
        "provider": "self-hosted",
        "builtin": False,
    },
    "image_gen_dalle3": {
        "label": "Image gen · DALL-E 3 (1024×1024 standard)",
        "description": "OpenAI DALL-E 3 standard quality, 1024×1024. $0.040/image.",
        "cost_shape": "per_call",
        "rate_usd": 0.040,
        "schema_tokens": 80,
        "result_tokens_avg": 30,
        "return_shape": "freeform",
        "cap_tokens": 40,
        "memoize": False,
        "memoize_hit_rate": 0.0,
        "provider": "managed",
        "builtin": True,
    },
    "image_gen_dalle3_hd": {
        "label": "Image gen · DALL-E 3 HD (1024×1024)",
        "description": "OpenAI DALL-E 3 HD quality, 1024×1024. $0.080/image.",
        "cost_shape": "per_call",
        "rate_usd": 0.080,
        "schema_tokens": 80,
        "result_tokens_avg": 30,
        "return_shape": "freeform",
        "cap_tokens": 40,
        "memoize": False,
        "memoize_hit_rate": 0.0,
        "provider": "managed",
        "builtin": True,
    },
    "image_gen_stable_diffusion": {
        "label": "Image gen · Stable Diffusion XL (Stability API)",
        "description": "Stability AI hosted SDXL via REST API. ~$0.040/image.",
        "cost_shape": "per_call",
        "rate_usd": 0.040,
        "schema_tokens": 80,
        "result_tokens_avg": 30,
        "return_shape": "freeform",
        "cap_tokens": 40,
        "memoize": False,
        "memoize_hit_rate": 0.0,
        "provider": "managed",
        "builtin": True,
    },
    "image_gen_bedrock_titan": {
        "label": "Image gen · AWS Bedrock Titan Image",
        "description": "Amazon Titan Image Generator G1 on Bedrock. ~$0.008/image.",
        "cost_shape": "per_call",
        "rate_usd": 0.008,
        "schema_tokens": 80,
        "result_tokens_avg": 30,
        "return_shape": "freeform",
        "cap_tokens": 40,
        "memoize": False,
        "memoize_hit_rate": 0.0,
        "provider": "bedrock",
        "builtin": True,
    },
    "image_gen_self_hosted": {
        "label": "Image gen · Self-hosted SDXL (free per call)",
        "description": "Self-hosted Stable Diffusion XL on your own GPU.",
        "cost_shape": "free",
        "rate_usd": 0,
        "schema_tokens": 80,
        "result_tokens_avg": 30,
        "return_shape": "freeform",
        "cap_tokens": 40,
        "memoize": False,
        "memoize_hit_rate": 0.0,
        "provider": "self-hosted",
        "builtin": True,
    },
}

DEFAULT_FEDERAL: Dict[str, Any] = {
    "fedramp_tier": "none",
    "multi_region": "single",
    "ato_monthly": 0,
    "egress_gb_per_query": 0.001,
    "egress_cost_per_gb": 0.09,
    "audit_log_kb_per_query": 5,
    "audit_retention_years": 7,
    "audit_storage_per_gb_month": 0.004,
    "retrieval_infra_monthly": 0,
    "pii_redaction_per_million_tokens": 0,
}


def _merge(defaults: Dict[str, Any], override: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Shallow merge: override wins. Mirrors JS Object.assign({}, defaults, override)."""
    out = dict(defaults)
    if override:
        out.update(override)
    return out


def _non_negative(obj: Optional[Dict[str, Any]], keys: List[str]) -> None:
    """Clamp named numeric keys to >= 0 (mirrors JS nonNegative helper)."""
    if not obj:
        return
    for k in keys:
        v = obj.get(k)
        if v is not None:
            try:
                fv = float(v)
                if math.isfinite(fv) and fv < 0:
                    obj[k] = 0
            except (TypeError, ValueError):
                pass


def normalize_workload(spec: Dict[str, Any]) -> Dict[str, Any]:
    """Full workload normalization. Mirrors cost-engine.js normalizeWorkload."""
    w: Dict[str, Any] = copy.deepcopy(spec)

    # Rate cards and tier multipliers
    w["rate_cards"] = _merge(DEFAULT_RATE_CARDS, w.get("rate_cards"))
    w["tier_multipliers"] = _merge(DEFAULT_TIER_MULTIPLIERS, w.get("tier_multipliers"))

    # Self-host block
    sh: Dict[str, Any] = w.get("self_host") or {}
    sh["gpu_options"] = _merge(DEFAULT_GPU_CATALOG, sh.get("gpu_options"))
    sh["diurnal_peak_factor"] = sh.get("diurnal_peak_factor") or 4
    sh["headroom"] = sh.get("headroom") or 1.5
    sh["min_replicas"] = sh.get("min_replicas") or 2
    sh["tokens_per_query_default"] = sh.get("tokens_per_query_default") or 2000
    cm: Dict[str, Any] = sh.get("cost_modes") or {}
    cm["optimistic"] = _merge(DEFAULT_COST_MODES.get("optimistic", {}), cm.get("optimistic"))
    cm["realistic"] = _merge(DEFAULT_COST_MODES.get("realistic", {}), cm.get("realistic"))
    sh["cost_modes"] = cm
    w["self_host"] = sh

    # Agents list
    w["agents"] = w["agents"] if isinstance(w.get("agents"), list) else []

    # Daily cap
    # JS `w.daily_cap || {...}`: an explicit {} is truthy and KEPT (cap
    # never binds since enabled is absent). Only absent/None gets defaults.
    if w.get("daily_cap") is None:
        w["daily_cap"] = {
            "enabled": True, "amount_usd": 1500, "burst_days": 7, "burst_factor": 1.0,
        }

    # Rate limit
    if w.get("rate_limit") is None:
        w["rate_limit"] = {
            "strategy": "edge", "monthly_cost": 15, "bot_ceiling": 2.5,
        }

    w["infrastructure"] = w.get("infrastructure") or {}

    # Federal block
    w["federal"] = _merge(DEFAULT_FEDERAL, w.get("federal"))

    # Backward compat: deployment.fedrampTier → federal.fedramp_tier
    dep = w.get("deployment") or {}
    if dep.get("fedrampTier") and (
        not w["federal"].get("fedramp_tier") or w["federal"]["fedramp_tier"] == "none"
    ):
        w["federal"]["fedramp_tier"] = dep["fedrampTier"]

    # Defaults block
    rate_cards = w["rate_cards"]
    mix_dict = w.get("mix") or {}
    w["defaults"] = _merge(
        {
            "model": next(iter(rate_cards.keys()), None),
            "tier": "standard",
            "mix": next(iter(mix_dict.keys()), None),
            "rate_limit": (w.get("rate_limit") or {}).get("strategy", "edge"),
            "hosting": "api",
            "cost_mode": "optimistic",
        },
        w.get("defaults"),
    )

    # anchor_query.session_baseline_turns default
    aq = w.get("anchor_query")
    if aq and not aq.get("session_baseline_turns"):
        aq["session_baseline_turns"] = 6

    # Tools registry: built-in defaults merged with workload overrides
    w["tools_registry"] = _merge(DEFAULT_TOOLS_REGISTRY, w.get("tools_registry"))

    # Clamp non-negative numeric fields
    _non_negative(w.get("anchor_query"), ["input_tokens", "output_tokens", "session_baseline_turns"])
    for seg in w.get("segments") or []:
        _non_negative(seg, ["mau", "sessions_per_day", "questions_per_session"])
    for agent in w.get("agents") or []:
        _non_negative(agent, ["input_tokens", "output_tokens", "calls_per_query"])
    _non_negative(w.get("daily_cap"), ["amount_usd", "burst_days", "burst_factor"])

    return w


def compute_queries(
    workload: Dict[str, Any],
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Compute monthly query volume per segment. Mirrors computeQueries()."""
    opts = options or {}
    bot_factor = opts["botFactor"] if opts.get("botFactor") is not None else 1.5
    rl = workload.get("rate_limit") or {}
    bot_ceiling_raw = rl.get("bot_ceiling")
    bot_ceiling = bot_ceiling_raw if bot_ceiling_raw is not None else float("inf")
    bot_effective = min(bot_factor, bot_ceiling)

    DAYS = 30
    auth = 0.0
    anon = 0.0
    total = 0.0
    by_segment: Dict[str, float] = {}

    for seg in workload.get("segments") or []:
        seg_apply_bot = seg.get("applyBotFactor")
        if seg_apply_bot is None:
            seg_apply_bot = seg.get("apply_bot_factor")
        beta = bot_effective if seg_apply_bot else 1.0
        q = (
            float(seg.get("mau") or 0)
            * float(seg.get("sessions_per_day") or 0)
            * DAYS
            * float(seg.get("questions_per_session") or 0)
            * beta
        )
        by_segment[seg.get("id")] = q
        total += q
        if seg_apply_bot:
            anon += q
        else:
            auth += q

    return {
        "total": total,
        "bySegment": by_segment,
        "auth": auth,
        "anon": anon,
        "botEffective": bot_effective,
    }
