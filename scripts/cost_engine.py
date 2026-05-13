#!/usr/bin/env python3
# =====================================================================
# Cost Calculator Studio - Python parallel implementation
#
# Direct port of public/lib/cost-engine.js (the canonical JavaScript
# implementation cited from the paper). Designed for three-way diff:
# JS / Python / Excel must agree on every coefficient and equation.
#
# Function names match the JS engine's `api` object (snake_case here
# vs camelCase there). Equation numbers reference the published paper.
#
# Stdlib-only by intent - this should run anywhere Python 3.8+ runs.
# =====================================================================
import copy
import json
import math
import os
import re
import sys
from typing import Any, Dict, List, Optional, Tuple


# ---------------------------------------------------------------------
# Constants (mirrored verbatim from cost-engine.js)
# ---------------------------------------------------------------------
CACHE_RATE_PER_TURN_ADJ = 0.01
CACHE_RATE_FLOOR = 0.50
CACHE_RATE_CEILING = 0.94

# Per-query totals (already includes atoms_per_response multiplication).
# Earlier versions named this nliCallsPerAtom and double-counted; the
# Python port mirrors the fixed semantics.
VARIANT_NLI_CALLS = {"fr1": 24, "fr2": 160, "fr3": 350}

# Flat monthly $ for self-hosted NLI on the listed EC2 SKU.
NLI_HOSTING_FLAT = {"ec2-g6": 588, "ec2-g5": 735}

# Per-model TPS one PTU buys (Azure published table).
TPS_PER_PTU = {
    "gpt-4o": 50, "gpt-4o-mini": 200,
    "gpt-5": 30, "gpt-5.5": 25, "gpt-5.4": 35, "gpt-5.2": 40, "gpt-5.1": 50,
    "gpt-5-mini": 150, "gpt-5-nano": 400,
    "claude-opus-4.7": 30, "claude-sonnet-4.6": 50, "claude-haiku-4.5": 200,
    "gemini-3.1-pro": 50,
    "_default": 50,
}


# ---------------------------------------------------------------------
# Prices loader - parses public/lib/prices.js into a dict.
#
# We don't want a runtime JS dependency, so we read the file as text
# and extract the relevant tables with a permissive regex/eval approach.
# Specifically: strip the IIFE wrapper, then trust that the object
# literal portion is valid JSON-ish (with unquoted keys, trailing
# commas, and inline comments). We normalize those into real JSON and
# json.loads() the result.
#
# This is deliberately fragile-by-design - if prices.js gets a new
# syntactic flourish we fail loudly here rather than silently using
# stale numbers.
# ---------------------------------------------------------------------
def _strip_js_comments(text: str) -> str:
    # Remove /* block */ comments
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    # Remove // line comments (avoid eating inside strings - close enough
    # for prices.js which never embeds // inside a string literal).
    out_lines = []
    for line in text.split("\n"):
        # Crude: cut at first // not inside quotes.
        in_str = False
        quote = None
        cut = None
        i = 0
        while i < len(line):
            c = line[i]
            if in_str:
                if c == "\\":
                    i += 2
                    continue
                if c == quote:
                    in_str = False
            else:
                if c in ("'", '"'):
                    in_str = True
                    quote = c
                elif c == "/" and i + 1 < len(line) and line[i + 1] == "/":
                    cut = i
                    break
            i += 1
        out_lines.append(line[:cut] if cut is not None else line)
    return "\n".join(out_lines)


def _extract_object_literal(text: str, start_idx: int) -> Tuple[str, int]:
    """Return the substring covering one balanced {...} starting at start_idx."""
    assert text[start_idx] == "{"
    depth = 0
    in_str = False
    quote = None
    i = start_idx
    while i < len(text):
        c = text[i]
        if in_str:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                in_str = False
        else:
            if c in ("'", '"'):
                in_str = True
                quote = c
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return text[start_idx : i + 1], i + 1
        i += 1
    raise ValueError("Unbalanced braces in prices.js")


def _jsify_to_json(obj_text: str) -> str:
    """Convert a JS object literal into valid JSON."""
    # Convert single-quoted strings to double-quoted (handle escapes lazily).
    # prices.js uses single quotes for string values. We can swap them as long
    # as we don't have embedded double quotes in those strings (prices.js does
    # have a couple of "" inside notes, so we have to be careful).
    out = []
    i = 0
    while i < len(obj_text):
        c = obj_text[i]
        if c == "'":
            # Read until next unescaped single quote
            j = i + 1
            buf = []
            while j < len(obj_text):
                ch = obj_text[j]
                if ch == "\\":
                    buf.append(obj_text[j : j + 2])
                    j += 2
                    continue
                if ch == "'":
                    break
                buf.append(ch)
                j += 1
            s = "".join(buf)
            # Escape any embedded double quotes for JSON.
            s = s.replace('"', '\\"')
            out.append('"' + s + '"')
            i = j + 1
        else:
            out.append(c)
            i += 1
    text = "".join(out)
    # Quote unquoted object keys: {foo: ...} -> {"foo": ...}
    # Match keys that are identifiers (incl. dots/hyphens within unquoted spans
    # are rare in prices.js - all such keys are already quoted strings).
    text = re.sub(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:", r'\1"\2":', text)
    # Strip trailing commas before } or ]
    text = re.sub(r",(\s*[}\]])", r"\1", text)
    # Numeric literals like 1_000_000 -> 1000000
    text = re.sub(r"(\d)_(\d)", r"\1\2", text)
    text = re.sub(r"(\d)_(\d)", r"\1\2", text)  # second pass for triple underscores
    return text


def _load_prices(prices_js_path: str) -> Dict[str, Any]:
    with open(prices_js_path, "r") as f:
        raw = f.read()
    raw = _strip_js_comments(raw)
    # Find "const Prices = {" and extract that object.
    m = re.search(r"const\s+Prices\s*=\s*\{", raw)
    if not m:
        raise RuntimeError("Could not find `const Prices = {` in prices.js")
    obj_text, _ = _extract_object_literal(raw, m.end() - 1)
    json_text = _jsify_to_json(obj_text)
    return json.loads(json_text)


# Resolve prices.js path relative to this file.
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_PRICES_JS = os.path.normpath(os.path.join(_THIS_DIR, "..", "public", "lib", "prices.js"))
Prices: Dict[str, Any] = _load_prices(_PRICES_JS)


# ---------------------------------------------------------------------
# Build engine-facing default tables (strip metadata fields)
# ---------------------------------------------------------------------
_META_KEYS = {"source_url", "last_verified", "notes"}


def _strip_meta(entry: Dict[str, Any], keep_provider: bool = False) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for k, v in (entry or {}).items():
        if k in _META_KEYS:
            continue
        if k == "provider" and not keep_provider:
            continue
        out[k] = v
    return out


def _project_category(cat: str, include_provider: bool = False) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for k, v in (Prices.get(cat) or {}).items():
        if not isinstance(v, dict):
            continue
        out[k] = _strip_meta(v, keep_provider=include_provider)
    return out


DEFAULT_RATE_CARDS = _project_category("llm_models", include_provider=True)
DEFAULT_GPU_CATALOG = _project_category("gpu_instances", include_provider=False)
DEFAULT_COST_MODES = _project_category("self_host_cost_modes", include_provider=False)

DEFAULT_TIER_MULTIPLIERS = {
    k: v.get("multiplier", 1.0)
    for k, v in (Prices.get("tier_multipliers") or {}).items()
}

FEDRAMP_MULTIPLIERS = {
    k: v.get("multiplier", 1.0)
    for k, v in ((Prices.get("federal_multipliers") or {}).get("fedramp") or {}).items()
}
MULTI_REGION_MULTIPLIERS = {
    k: v.get("multiplier", 1.0)
    for k, v in ((Prices.get("federal_multipliers") or {}).get("multi_region") or {}).items()
}

DEFAULT_FEDERAL = {
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


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------
def _merge_defaults(defaults: Dict[str, Any], override: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    out = dict(defaults)
    out.update(override or {})
    return out


def _opt(opts: Dict[str, Any], *keys, default=None):
    """Read first present key from opts (supports JS camelCase + Python snake_case)."""
    for k in keys:
        if k in opts and opts[k] is not None:
            return opts[k]
    return default


# ---------------------------------------------------------------------
# Workload normalization
# ---------------------------------------------------------------------
def normalize_workload(spec: Dict[str, Any]) -> Dict[str, Any]:
    w = copy.deepcopy(spec)
    w["rate_cards"] = _merge_defaults(DEFAULT_RATE_CARDS, w.get("rate_cards"))
    w["tier_multipliers"] = _merge_defaults(DEFAULT_TIER_MULTIPLIERS, w.get("tier_multipliers"))
    sh = w.get("self_host") or {}
    sh["gpu_options"] = _merge_defaults(DEFAULT_GPU_CATALOG, sh.get("gpu_options"))
    sh["diurnal_peak_factor"] = sh.get("diurnal_peak_factor") or 4
    sh["headroom"] = sh.get("headroom") or 1.5
    sh["min_replicas"] = sh.get("min_replicas") or 2
    sh["tokens_per_query_default"] = sh.get("tokens_per_query_default") or 2000
    cm = sh.get("cost_modes") or {}
    cm["optimistic"] = _merge_defaults(
        DEFAULT_COST_MODES.get("optimistic", {}), cm.get("optimistic")
    )
    cm["realistic"] = _merge_defaults(
        DEFAULT_COST_MODES.get("realistic", {}), cm.get("realistic")
    )
    sh["cost_modes"] = cm
    w["self_host"] = sh
    w["agents"] = w.get("agents") if isinstance(w.get("agents"), list) else []
    w["daily_cap"] = w.get("daily_cap") or {
        "enabled": True, "amount_usd": 1500, "burst_days": 7, "burst_factor": 1.0,
    }
    w["rate_limit"] = w.get("rate_limit") or {
        "strategy": "edge", "monthly_cost": 15, "bot_ceiling": 2.5,
    }
    w["infrastructure"] = w.get("infrastructure") or {}
    w["federal"] = _merge_defaults(DEFAULT_FEDERAL, w.get("federal"))
    # Backward compat: deployment.fedrampTier mirrored into federal.fedramp_tier
    dep = w.get("deployment") or {}
    if dep.get("fedrampTier") and (
        not w["federal"].get("fedramp_tier") or w["federal"].get("fedramp_tier") == "none"
    ):
        w["federal"]["fedramp_tier"] = dep["fedrampTier"]
    rate_cards = w["rate_cards"]
    mix_dict = w.get("mix") or {}
    w["defaults"] = _merge_defaults(
        {
            "model": next(iter(rate_cards.keys()), None),
            "tier": "standard",
            "mix": next(iter(mix_dict.keys()), None),
            "rate_limit": (w["rate_limit"] or {}).get("strategy", "edge"),
            "hosting": "api",
            "cost_mode": "optimistic",
        },
        w.get("defaults"),
    )
    aq = w.get("anchor_query")
    if aq and not aq.get("session_baseline_turns"):
        aq["session_baseline_turns"] = 6
    return w


# ---------------------------------------------------------------------
# Eq. 2 cache-rate blend.
#   p_cached,eff = w * p_write + (1 - w) * p_read
# ---------------------------------------------------------------------
def effective_cached_rate(rates: Dict[str, Any], write_share: Optional[float]) -> float:
    p_in = rates["input_per_million"]
    p_read = rates.get("cached_per_million")
    if p_read is None:
        p_read = p_in * 0.1
    p_write = rates.get("cached_write_per_million")
    if p_write is None:
        p_write = p_in
    w = write_share if (write_share is not None and not _is_nan(write_share)) else 0
    return w * p_write + (1 - w) * p_read


def _is_nan(x: Any) -> bool:
    try:
        return math.isnan(x)
    except TypeError:
        return False


# ---------------------------------------------------------------------
# Eq. 3 effective cache rate per segment.
#   adj = baseline + (q_per_session - baseline_turns) * 0.01
#   clamp to [0.50, 0.94]
# ---------------------------------------------------------------------
def effective_cache_rate(baseline: float, q_per_session: float, baseline_turns: float) -> float:
    adj = baseline + (q_per_session - baseline_turns) * CACHE_RATE_PER_TURN_ADJ
    return min(CACHE_RATE_CEILING, max(CACHE_RATE_FLOOR, adj))


# ---------------------------------------------------------------------
# Multi-agent per-query cost (bypasses shape x mix when agents present).
# ---------------------------------------------------------------------
def per_query_cost_agents(
    workload: Dict[str, Any],
    main_model: str,
    tier_id: str,
    cache_rate: float,
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    opts = options or {}
    mult = workload["tier_multipliers"].get(tier_id, 1.0)
    total = 0.0
    breakdown: List[Dict[str, Any]] = []
    for agent in workload.get("agents", []) or []:
        hosting = agent.get("hosting", "api")
        calls = agent["calls_per_query"] if agent.get("calls_per_query") is not None else 1
        in_t = agent.get("input_tokens", 0) or 0
        out_t = agent.get("output_tokens", 0) or 0
        if hosting in ("byok", "self-host"):
            breakdown.append({
                "id": agent.get("id"),
                "label": agent.get("label") or agent.get("id"),
                "hosting": hosting,
                "model": agent.get("model") or main_model,
                "calls": calls, "input": in_t, "output": out_t,
                "per_call_cost": 0, "per_query_cost": 0,
                "note": ("Excluded from API total - user provides their own key."
                        if hosting == "byok"
                        else "Excluded from API total - costed in self-host section."),
            })
            continue
        model_id = agent.get("model") or main_model
        rates = workload["rate_cards"].get(model_id)
        if not rates:
            continue
        eff = cache_rate if agent.get("cache_eligible") else 0
        cached = in_t * eff
        uncached = in_t - cached
        agent_write_share = agent.get("cache_write_share")
        if agent_write_share is None:
            agent_write_share = opts.get("cacheWriteShare") or opts.get("cache_write_share") or 0
        p_cached_eff = effective_cached_rate(rates, agent_write_share)
        per_call = (
            uncached * rates["input_per_million"] / 1e6
            + cached * p_cached_eff / 1e6
            + out_t * rates["output_per_million"] / 1e6
        ) * mult
        contrib = calls * per_call
        total += contrib
        breakdown.append({
            "id": agent.get("id"),
            "label": agent.get("label") or agent.get("id"),
            "hosting": hosting, "model": model_id,
            "calls": calls, "input": in_t, "output": out_t,
            "per_call_cost": per_call, "per_query_cost": contrib,
        })
    return {"per_query": total, "breakdown": breakdown}


# ---------------------------------------------------------------------
# Eq. 1 per-query cost: shape x mix weighted blend.
# ---------------------------------------------------------------------
def per_query_cost(
    workload: Dict[str, Any],
    model_id: str,
    tier_id: str,
    mix_id: str,
    cache_rate: float,
    write_share: Optional[float] = 0,
) -> float:
    rates = workload["rate_cards"].get(model_id)
    if not rates:
        return 0.0
    mult = workload["tier_multipliers"].get(tier_id, 1.0)
    mix = (workload.get("mix") or {}).get(mix_id)
    if not mix or not mix.get("weights"):
        return 0.0
    anchor_in = workload["anchor_query"]["input_tokens"]
    anchor_out = workload["anchor_query"]["output_tokens"]
    p_cached_eff = effective_cached_rate(rates, write_share)
    total = 0.0
    total_weight = 0.0
    for shape_name, weight in mix["weights"].items():
        shape = (workload.get("shapes") or {}).get(shape_name)
        if not shape:
            continue
        in_t = anchor_in * shape["input_factor"]
        out_t = anchor_out * shape["output_factor"]
        eff = cache_rate if shape.get("cache_eligible") else 0
        cached = in_t * eff
        uncached = in_t - cached
        shape_cost = (
            uncached * rates["input_per_million"] / 1e6
            + cached * p_cached_eff / 1e6
            + out_t * rates["output_per_million"] / 1e6
        ) * mult
        total += weight * shape_cost
        total_weight += weight
    return total / total_weight if total_weight > 0 else 0.0


# ---------------------------------------------------------------------
# Eq. 4 monthly query volume per segment + aggregated.
# ---------------------------------------------------------------------
def compute_queries(workload: Dict[str, Any], options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    opts = options or {}
    bot_factor = opts["botFactor"] if "botFactor" in opts and opts["botFactor"] is not None else opts.get("bot_factor", 1.5)
    rl = workload.get("rate_limit") or {}
    bot_ceiling = rl.get("bot_ceiling") if rl.get("bot_ceiling") is not None else float("inf")
    bot_effective = min(bot_factor, bot_ceiling)
    DAYS = 30
    auth = 0.0
    anon = 0.0
    total = 0.0
    by_segment: Dict[str, float] = {}
    for seg in workload.get("segments") or []:
        # Accept both camelCase and snake_case
        seg_apply_bot = seg.get("applyBotFactor")
        if seg_apply_bot is None:
            seg_apply_bot = seg.get("apply_bot_factor")
        beta = bot_effective if seg_apply_bot else 1
        q = (
            seg.get("mau", 0)
            * seg.get("sessions_per_day", 0)
            * DAYS
            * seg.get("questions_per_session", 0)
            * beta
        )
        by_segment[seg["id"]] = q
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


# ---------------------------------------------------------------------
# Hosting multiplier (FedRAMP x multi-region).
# ---------------------------------------------------------------------
def hosting_multiplier(workload: Dict[str, Any]) -> float:
    f = (workload or {}).get("federal") or {}
    fr = FEDRAMP_MULTIPLIERS.get(f.get("fedramp_tier", "none"), 1.0)
    mr = MULTI_REGION_MULTIPLIERS.get(f.get("multi_region", "single"), 1.0)
    return fr * mr


# ---------------------------------------------------------------------
# Full API cost (monthly), including Eq. 2 cache blend + Eq. 5 retry inflate.
# ---------------------------------------------------------------------
def compute_api_cost(
    workload: Dict[str, Any],
    queries: Dict[str, Any],
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    opts = options or {}
    model_id = opts.get("model") or workload["defaults"]["model"]
    tier_id = opts.get("tier") or workload["defaults"]["tier"]
    mix_id = opts.get("mix") or workload["defaults"]["mix"]
    cache_base = opts["cacheRate"] if "cacheRate" in opts and opts["cacheRate"] is not None else workload["anchor_query"]["cache_rate_baseline"]
    # cache write share read order: opts -> anchor -> rate-card default -> 0
    if opts.get("cacheWriteShare") is not None:
        write_share = opts["cacheWriteShare"]
    elif (workload.get("anchor_query") or {}).get("cache_write_share") is not None:
        write_share = workload["anchor_query"]["cache_write_share"]
    elif (workload.get("rate_cards") or {}).get(model_id, {}).get("cache_write_share_default") is not None:
        write_share = workload["rate_cards"][model_id]["cache_write_share_default"]
    else:
        write_share = 0

    agent_mode = isinstance(workload.get("agents"), list) and len(workload["agents"]) > 0

    seg_per_query: Dict[str, Any] = {}
    total_cost = 0.0
    agent_breakdown = None
    for seg in workload.get("segments") or []:
        eff = effective_cache_rate(
            cache_base,
            seg["questions_per_session"],
            workload["anchor_query"]["session_baseline_turns"],
        )
        if agent_mode:
            r = per_query_cost_agents(workload, model_id, tier_id, eff, opts)
            pq = r["per_query"]
            if agent_breakdown is None:
                agent_breakdown = r["breakdown"]
        else:
            pq = per_query_cost(workload, model_id, tier_id, mix_id, eff, write_share)
        seg_per_query[seg["id"]] = {"eff_cache": eff, "per_query": pq}
        total_cost += queries["bySegment"][seg["id"]] * pq

    blended = total_cost / queries["total"] if queries["total"] > 0 else 0
    host_mult = hosting_multiplier(workload)
    gross_with_host = total_cost * host_mult

    # No daily-cap clipping; kept here for field parity with JS.
    capped_with_host = gross_with_host
    monthly_refused = 0
    monthly_capped_pre = capped_with_host / (host_mult or 1)

    # Eq. 5 retry inflate
    if opts.get("retryInflate") is not None:
        retry_inflate = opts["retryInflate"]
    else:
        retry_inflate = 1 + 1.5 * (opts.get("retry_rate") or 0)
    monthly_with_retry = capped_with_host * retry_inflate

    return {
        "monthly_gross": gross_with_host,
        "monthly_capped": capped_with_host,
        "monthly_with_retry": monthly_with_retry,
        "retry_inflate": retry_inflate,
        "monthly_gross_pre_federal": total_cost,
        "monthly_capped_pre_federal": monthly_capped_pre,
        "hosting_multiplier": host_mult,
        "monthly_refused_queries": monthly_refused,
        "per_query_blended": blended * host_mult,
        "per_segment": seg_per_query,
        "agent_mode": agent_mode,
        "agent_breakdown": agent_breakdown,
    }


# ---------------------------------------------------------------------
# Eq. 6 self-host: instances + duty_cycle * 730 effective hours.
# ---------------------------------------------------------------------
def compute_self_host(
    workload: Dict[str, Any],
    monthly_queries: float,
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    opts = options or {}
    sh = workload["self_host"]
    gpu_id = opts.get("gpu") or next(iter(sh["gpu_options"].keys()))
    commitment_id = opts.get("commitment") or "ri-1y"
    replicas = opts["replicas"] if opts.get("replicas") is not None else sh["min_replicas"]
    tokens_per_q = opts.get("tokensPerQ") or sh["tokens_per_query_default"]
    cost_mode = opts.get("costMode") or "optimistic"

    gpu = sh["gpu_options"][gpu_id]
    params = sh["cost_modes"][cost_mode]

    if commitment_id == "on-demand":
        disc = 0
    elif commitment_id == "ri-1y":
        disc = params["discount_1yr"]
    else:
        disc = params["discount_3yr"]
    eff_tput = gpu["tput_tps"] * params["throughput_derate"]
    qps_avg = monthly_queries / (30 * 86400)
    peak_tps = qps_avg * tokens_per_q * sh["diurnal_peak_factor"] * sh["headroom"]
    needed_by_load = math.ceil(peak_tps / eff_tput) if eff_tput > 0 else 0
    min_floor = max(sh["min_replicas"], replicas)
    instances = max(needed_by_load, min_floor)
    gpu_hourly_eff = gpu["hourly"] * (1 - disc)
    host_mult = hosting_multiplier(workload)
    duty_cycle = max(0.05, min(1.0, sh.get("duty_cycle") or 1.0))
    effective_hours = 730 * duty_cycle

    gpu_monthly = instances * gpu_hourly_eff * effective_hours * host_mult
    ops_monthly_eff = params["ops_monthly"] * host_mult

    platform = sh.get("compute_platform") or "fargate"
    k8s_hidden = (sh.get("k8s_hidden_cost") or 5333) if platform == "k8s" else 0

    total = gpu_monthly + ops_monthly_eff + params["fte_monthly"] + params["setup_amortized"] + k8s_hidden

    return {
        "gpu_spec": gpu,
        "cost_mode": cost_mode,
        "compute_platform": platform,
        "qps_avg": qps_avg,
        "peak_tps": peak_tps,
        "effective_tput": eff_tput,
        "needed_by_load": needed_by_load,
        "instances": instances,
        "gpu_monthly": gpu_monthly,
        "ops_monthly": ops_monthly_eff,
        "fte_monthly": params["fte_monthly"],
        "setup_amortized": params["setup_amortized"],
        "k8s_hidden_cost": k8s_hidden,
        "hosting_multiplier": host_mult,
        "duty_cycle": duty_cycle,
        "effective_hours": effective_hours,
        "total": total,
        "effective_per_query": total / monthly_queries if monthly_queries > 0 else 0,
    }


# ---------------------------------------------------------------------
# Self-host capped to monthly budget (equal-budget scenario).
# ---------------------------------------------------------------------
def compute_self_host_capped(
    workload: Dict[str, Any],
    monthly_queries: float,
    peer_self_host: Dict[str, Any],
    options: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    opts = options or {}
    dc = workload.get("daily_cap") or {}
    if not dc.get("enabled"):
        return None
    monthly_budget = (dc.get("amount_usd") or 0) * 30
    if monthly_budget <= 0:
        return None

    cost_mode = opts.get("costMode") or "optimistic"
    gpu_id = opts.get("gpu") or next(iter(workload["self_host"]["gpu_options"].keys()))
    commitment_id = opts.get("commitment") or "ri-1y"
    params = workload["self_host"]["cost_modes"][cost_mode]
    gpu = workload["self_host"]["gpu_options"][gpu_id]

    if commitment_id == "on-demand":
        disc = 0
    elif commitment_id == "ri-1y":
        disc = params["discount_1yr"]
    else:
        disc = params["discount_3yr"]
    host_mult = hosting_multiplier(workload)
    fixed = params["ops_monthly"] * host_mult + params["fte_monthly"] + params["setup_amortized"]
    gpu_hourly_eff = gpu["hourly"] * (1 - disc) * host_mult
    duty_cycle = max(0.05, min(1.0, workload["self_host"].get("duty_cycle") or 1.0))
    effective_hours = 730 * duty_cycle
    budget_for_gpu = max(0, monthly_budget - fixed)
    gpu_hour_cost = gpu_hourly_eff * effective_hours
    instances_affordable = math.floor(budget_for_gpu / gpu_hour_cost) if gpu_hour_cost > 0 else 0
    instances = max(0, min(instances_affordable, peer_self_host["instances"]))
    gpu_monthly = instances * gpu_hour_cost
    total = gpu_monthly + fixed
    capacity = instances * peer_self_host["effective_tput"]
    frac_served = min(1, capacity / peer_self_host["peak_tps"]) if peer_self_host["peak_tps"] > 0 else 1
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
        "note": (
            "Equal-budget projection only: shows how many queries a self-host fleet could serve "
            "at the same monthly $ as the API daily cap x 30. Not a run-rate cost (API side does "
            "not enforce the cap symmetrically)."
        ),
    }


# ---------------------------------------------------------------------
# Verification (FactReasoner-style) cost.
#
# NLI calls per VERIFIED query come from VARIANT_NLI_CALLS - these are
# per-query totals, NOT per-atom (the JS used to double-count by
# multiplying by atoms_per_response; the Python port matches the fixed
# semantics).
# ---------------------------------------------------------------------
def compute_verification(
    workload: Dict[str, Any],
    monthly_queries: float,
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    v = workload.get("verification")
    if not v or not v.get("enabled"):
        return {"enabled": False, "monthly": 0, "verified_queries": 0, "breakdown": {}}
    opts = options or {}
    coverage = opts["verifCoverage"] if "verifCoverage" in opts and opts["verifCoverage"] is not None else (v.get("coverage") or 0)
    if coverage <= 0:
        return {
            "enabled": True, "coverage": 0, "monthly": 0,
            "verified_queries": 0, "breakdown": {},
            "variant": v.get("variant"), "nli_hosting": v.get("nli_hosting"),
        }
    variant = opts.get("verifVariant") or v.get("variant") or "fr1"
    atoms = v.get("atoms_per_response") or 8
    override = (v.get("atoms_per_response_nli_calls") or {}).get(variant)
    nli_calls_per_query = override if override is not None else VARIANT_NLI_CALLS.get(variant, 24)
    verified_queries = monthly_queries * coverage

    model_id = opts.get("verifModel") or opts.get("model") or workload["defaults"]["model"]
    tier_id = opts.get("tier") or workload["defaults"]["tier"]
    rates = workload["rate_cards"][model_id]
    mult = workload["tier_multipliers"].get(tier_id, 1.0)

    def token_cost(tokens: Dict[str, Any]) -> float:
        return (
            (tokens.get("input", 0) or 0) * rates["input_per_million"] / 1e6
            + (tokens.get("output", 0) or 0) * rates["output_per_million"] / 1e6
        ) * mult

    atomizer_per_q = token_cost(v.get("atomizer_tokens") or {"input": 1500, "output": 400})
    reviser_per_q = atoms * token_cost(v.get("reviser_tokens") or {"input": 500, "output": 30})
    nli_hosting = opts.get("nliHosting") or v.get("nli_hosting") or "api"
    if nli_hosting == "api":
        nli_per_call = token_cost(v.get("nli_tokens") or {"input": 1200, "output": 20})
        nli_monthly = verified_queries * nli_calls_per_query * nli_per_call
    else:
        nli_monthly = NLI_HOSTING_FLAT.get(nli_hosting, 0)

    retrieval = opts.get("retrieval") or v.get("retrieval") or "wikipedia"
    retrieval_monthly = verified_queries * atoms * (5 / 1000) if retrieval == "serper" else 0

    atomizer_monthly = verified_queries * atomizer_per_q
    reviser_monthly = verified_queries * reviser_per_q
    service_pod = v.get("service_pod_monthly") or 0
    monthly = atomizer_monthly + reviser_monthly + nli_monthly + retrieval_monthly + service_pod

    return {
        "enabled": True,
        "coverage": coverage,
        "variant": variant,
        "verified_queries": verified_queries,
        "monthly": monthly,
        "breakdown": {
            "atomizer": atomizer_monthly,
            "reviser": reviser_monthly,
            "nli": nli_monthly,
            "retrieval": retrieval_monthly,
            "service_pod": service_pod,
        },
        "nli_hosting": nli_hosting,
        "nli_calls_per_query": nli_calls_per_query,
    }


# ---------------------------------------------------------------------
# Federal additive line items (on top of LLM compute).
# ---------------------------------------------------------------------
def compute_federal(
    workload: Dict[str, Any],
    monthly_queries: float,
    api_result: Optional[Dict[str, Any]] = None,
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    f = workload.get("federal") or {}
    ato = f.get("ato_monthly", 0) or 0
    egress_gb = (f.get("egress_gb_per_query", 0) or 0) * monthly_queries
    egress = egress_gb * (f.get("egress_cost_per_gb", 0) or 0)
    audit_gb_per_month = (f.get("audit_log_kb_per_query", 0) or 0) * monthly_queries / (1024 * 1024)
    audit_total_gb = audit_gb_per_month * 12 * (f.get("audit_retention_years", 0) or 0)
    audit = audit_total_gb * (f.get("audit_storage_per_gb_month", 0) or 0)
    retrieval = f.get("retrieval_infra_monthly", 0) or 0
    pii = 0.0
    if f.get("pii_redaction_per_million_tokens") and workload.get("anchor_query"):
        anchor = workload["anchor_query"]
        tokens_per_q = (anchor.get("input_tokens", 0) or 0) + (anchor.get("output_tokens", 0) or 0)
        pii = monthly_queries * tokens_per_q * (f.get("pii_redaction_per_million_tokens") or 0) / 1e6
    additive = ato + egress + audit + retrieval + pii
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
        "hosting_premium_api": (
            (api_result["monthly_capped"] - api_result["monthly_capped_pre_federal"])
            if api_result else 0
        ),
    }


# ---------------------------------------------------------------------
# Infrastructure item -> $/mo. Stubbed version of resolveInfraCost.
# ---------------------------------------------------------------------
def resolve_infra_cost(value: Any, monthly_queries: float) -> float:
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
        return rate * monthly_queries / 1000
    if per == "per_million_queries":
        return rate * monthly_queries / 1e6
    if per == "per_gb_per_query":
        gb = float(value.get("gb") or 0)
        return rate * monthly_queries * gb
    return 0.0


# ---------------------------------------------------------------------
# Reservation: PTU (fixed) or discount-style.
# ---------------------------------------------------------------------
def compute_reservation(
    workload: Dict[str, Any],
    api_cost_monthly: float,
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    r = workload.get("reservations") or {}
    if not r.get("enabled") or not r.get("type") or r["type"] == "none":
        return {
            "enabled": False, "applied_discount": 0, "fixed_monthly": 0,
            "effective_monthly": api_cost_monthly, "savings": 0,
        }
    spec = ((Prices.get("api_reservations") or {}).get(r["type"]))
    if not spec:
        return {
            "enabled": False, "applied_discount": 0, "fixed_monthly": 0,
            "effective_monthly": api_cost_monthly, "savings": 0,
        }
    if spec.get("dollar_per_unit_per_month") is not None:
        units = r.get("units") or 1
        fixed = units * spec["dollar_per_unit_per_month"]
        return {
            "enabled": True, "type": r["type"], "spec": spec,
            "units": units, "applied_discount": 0,
            "fixed_monthly": fixed, "effective_monthly": fixed,
            "savings": max(0, api_cost_monthly - fixed),
            "notes": f"{units} PTU x ${spec['dollar_per_unit_per_month']}/mo = ${fixed:.0f}/mo flat",
        }
    if spec.get("discount") and spec["discount"] > 0:
        discounted = api_cost_monthly * (1 - spec["discount"])
        return {
            "enabled": True, "type": r["type"], "spec": spec,
            "applied_discount": spec["discount"], "fixed_monthly": 0,
            "effective_monthly": discounted, "savings": api_cost_monthly - discounted,
            "notes": f"{int(spec['discount']*100)}% discount on API spend",
        }
    return {
        "enabled": False, "applied_discount": 0, "fixed_monthly": 0,
        "effective_monthly": api_cost_monthly, "savings": 0,
    }


# ---------------------------------------------------------------------
# Embedding generation (ingest amortized + per-query).
# ---------------------------------------------------------------------
def compute_embedding(
    workload: Dict[str, Any],
    monthly_queries: float,
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    e = workload.get("embedding") or {}
    if not e.get("enabled"):
        return {"enabled": False, "monthly": 0, "ingest_amortized": 0, "query_monthly": 0}
    model_id = e.get("model") or "text-embedding-3-small"
    model = (Prices.get("embeddings") or {}).get(model_id)
    if not model:
        return {"enabled": False, "monthly": 0, "ingest_amortized": 0, "query_monthly": 0}
    rate_per_m = model.get("dollar_per_million_tokens", 0) or 0
    corpus_tokens = e.get("corpus_size_tokens", 0) or 0
    reembed_months = max(1, e.get("reembed_frequency_months", 12) or 12)
    ingest_total = corpus_tokens * rate_per_m / 1e6
    ingest_amortized = ingest_total / reembed_months
    query_tokens = e.get("query_embedding_tokens", 8) or 8
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


# ---------------------------------------------------------------------
# Personnel (FTE x loaded annual / 12).
# ---------------------------------------------------------------------
def compute_personnel(
    workload: Dict[str, Any],
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    p = workload.get("personnel") or {}
    if not p.get("enabled") or not isinstance(p.get("roles"), list) or not p["roles"]:
        return {"enabled": False, "monthly": 0, "breakdown": []}
    breakdown = []
    monthly = 0.0
    for r in p["roles"]:
        defn = (Prices.get("personnel") or {}).get(r.get("role"))
        if not defn:
            continue
        fte = float(r.get("fte") or 0)
        loaded = (defn.get("annual_base", 0) or 0) * (defn.get("total_comp_multiplier", 1) or 1)
        m = fte * loaded / 12
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


# ---------------------------------------------------------------------
# ATO tier (replaces flat federal.ato_monthly when set).
# ---------------------------------------------------------------------
def compute_ato_from_prices(workload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    c = workload.get("compliance") or {}
    tier = c.get("ato_tier")
    if not tier or tier == "none":
        return None
    defn = (Prices.get("ato") or {}).get(tier)
    if not defn:
        return None
    amort_months = c.get("upfront_amortization_months", 36) or 36
    upfront_monthly = (defn.get("upfront", 0) or 0) / amort_months
    continuous_monthly = (defn.get("annual_continuous_monitoring", 0) or 0) / 12
    return {
        "tier": tier,
        "upfront": defn.get("upfront"),
        "annual_continuous": defn.get("annual_continuous_monitoring"),
        "amortization_months": amort_months,
        "upfront_monthly": upfront_monthly,
        "continuous_monthly": continuous_monthly,
        "monthly": upfront_monthly + continuous_monthly,
    }


# ---------------------------------------------------------------------
# Hybrid (split traffic between API + self-host).
# ---------------------------------------------------------------------
def compute_hybrid(
    workload: Dict[str, Any],
    queries: Dict[str, Any],
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    opts = options or {}
    split = min(1, max(0, opts.get("apiSplit") if opts.get("apiSplit") is not None else 0.5))

    def scale_queries(q: Dict[str, Any], frac: float) -> Dict[str, Any]:
        out = copy.deepcopy(q)
        out["total"] = q["total"] * frac
        out["bySegment"] = {k: v * frac for k, v in (q.get("bySegment") or {}).items()}
        out["auth"] = (q.get("auth") or 0) * frac
        out["anon"] = (q.get("anon") or 0) * frac
        return out

    api_q = scale_queries(queries, split)
    sh_q = scale_queries(queries, 1 - split)
    api_part = compute_api_cost(workload, api_q, opts)
    sh_part = compute_self_host(workload, sh_q["total"], opts)
    return {
        "api_share": split, "self_share": 1 - split,
        "api_part": api_part, "self_part": sh_part,
        "api_queries": api_q["total"], "self_queries": sh_q["total"],
        "total": api_part["monthly_capped"] + sh_part["total"],
    }


# ---------------------------------------------------------------------
# Top-level: run the whole pipeline.
# ---------------------------------------------------------------------
def compute(raw_workload: Dict[str, Any], options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    workload = normalize_workload(raw_workload)
    opts = options or {}
    queries = compute_queries(workload, opts)
    api = compute_api_cost(workload, queries, opts)
    self_host_res = compute_self_host(workload, queries["total"], opts)
    self_host_capped = compute_self_host_capped(workload, queries["total"], self_host_res, opts)
    verification = compute_verification(workload, queries["total"], opts)
    federal = compute_federal(workload, queries["total"], api, opts)
    reservation = compute_reservation(workload, api["monthly_capped"], opts)
    embedding = compute_embedding(workload, queries["total"], opts)
    personnel = compute_personnel(workload, opts)
    ato_from_prices = compute_ato_from_prices(workload)
    if ato_from_prices:
        federal["ato_from_tier"] = ato_from_prices
        federal["additive_total"] = (
            (federal.get("additive_total") or 0)
            - (federal["breakdown"].get("ato_monthly") or 0)
            + ato_from_prices["monthly"]
        )
        federal["breakdown"]["ato_monthly"] = ato_from_prices["monthly"]
        federal["breakdown"]["ato_tier"] = ato_from_prices["tier"]
    hybrid = compute_hybrid(workload, queries, opts) if opts.get("hosting") == "hybrid" else None

    # Fixed costs: infrastructure + rate_limit
    infra_items = workload.get("infrastructure") or {}
    infra_breakdown: Dict[str, float] = {}
    infra_sum = 0.0
    for name, val in infra_items.items():
        cost = resolve_infra_cost(val, queries["total"])
        infra_breakdown[name] = cost
        infra_sum += cost
    rate_limit_cost = float((workload.get("rate_limit") or {}).get("monthly_cost") or 0)
    fixed_costs = {
        "infrastructure": infra_sum,
        "infrastructure_breakdown": infra_breakdown,
        "rate_limit": rate_limit_cost,
        "total": infra_sum + rate_limit_cost,
    }

    return {
        "workload": workload,
        "queries": queries,
        "api": api,
        "self_host": self_host_res,
        "self_host_capped": self_host_capped,
        # Migration + risk-bands intentionally stubbed - the port focuses on
        # the core equations. Re-enable later if needed.
        "break_even": {"enabled": False},
        "migration": {"enabled": False},
        "risk_bands": None,
        "verification": verification,
        "federal": federal,
        "hybrid": hybrid,
        "reservation": reservation,
        "embedding": embedding,
        "personnel": personnel,
        "fixed_costs": fixed_costs,
    }


def summary(result: Dict[str, Any], opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Compact summary mirroring scripts/calc.js headline composition."""
    opts = opts or {}
    api = result["api"]
    retry_inflate = api.get("retry_inflate", 1.0)
    api_bill = api.get("monthly_with_retry", api["monthly_capped"])
    hosting = opts.get("hosting") or (result["workload"]["defaults"] or {}).get("hosting") or "api"
    if hosting == "hybrid" and result.get("hybrid"):
        llm = result["hybrid"]["total"]
    elif hosting == "self":
        llm = result["self_host"]["total"]
    elif result["reservation"].get("enabled"):
        llm = result["reservation"]["effective_monthly"]
    else:
        llm = api_bill
    verif = result["verification"].get("monthly", 0) or 0
    federal_add = result["federal"].get("additive_total", 0) or 0
    fixed = result["fixed_costs"].get("total", 0) or 0
    embeddings = (result["embedding"].get("monthly", 0) or 0) if result["embedding"].get("enabled") else 0
    personnel = (result["personnel"].get("monthly", 0) or 0) if result["personnel"].get("enabled") else 0
    headline = llm + verif + federal_add + fixed + embeddings + personnel
    return {
        "queries_per_month": result["queries"]["total"],
        "llm_monthly": llm,
        "verification_monthly": verif,
        "federal_additive_monthly": federal_add,
        "fixed_monthly": fixed,
        "embedding_monthly": embeddings,
        "personnel_monthly": personnel,
        "headline_monthly": headline,
        "retry_inflate": retry_inflate,
        "api_capped_raw": api["monthly_capped"],
    }


# =====================================================================
# Validation harness - mirrors scripts/calc.js on
# public/examples/public-geospatial-qa.json. Target reference numbers:
#   llm        ≈ $1097.30
#   headline   ≈ $4933.65
#   queries    = 915,000
# =====================================================================
if __name__ == "__main__":
    example_path = os.path.normpath(
        os.path.join(_THIS_DIR, "..", "public", "examples", "public-geospatial-qa.json")
    )
    with open(example_path, "r") as f:
        workload = json.load(f)

    # Match calc.js default opts: hosting=api, model/tier/mix from workload.defaults,
    # cost_mode from workload.defaults, botFactor=1.5, retry_rate=0, cacheRate from anchor.
    opts = {
        "hosting": workload["defaults"]["hosting"],
        "model": workload["defaults"]["model"],
        "tier": workload["defaults"]["tier"],
        "mix": workload["defaults"]["mix"],
        "costMode": workload["defaults"]["cost_mode"],
        "botFactor": 1.5,
        "retry_rate": 0,
        "cacheRate": workload["anchor_query"]["cache_rate_baseline"],
        "verifCoverage": (workload.get("verification") or {}).get("coverage", 0),
    }
    result = compute(workload, opts)
    s = summary(result, opts)
    print(f"queries_per_month = {s['queries_per_month']:,.0f}")
    print(f"llm_monthly       = ${s['llm_monthly']:.2f}")
    print(f"headline_monthly  = ${s['headline_monthly']:.2f}")
    print()
    print(f"  (verification: ${s['verification_monthly']:.2f}, "
          f"federal_additive: ${s['federal_additive_monthly']:.2f}, "
          f"fixed: ${s['fixed_monthly']:.2f})")

    # Reference targets from JS CLI on 2026-05-13:
    REF_LLM = 1097.30
    REF_HEADLINE = 4933.65
    REF_QUERIES = 915000
    tolerance = 1.0
    ok = (
        abs(s["llm_monthly"] - REF_LLM) < tolerance
        and abs(s["headline_monthly"] - REF_HEADLINE) < tolerance
        and abs(s["queries_per_month"] - REF_QUERIES) < 1
    )
    if ok:
        print("\nValidation: MATCH (within $1 of JS reference)")
        sys.exit(0)
    else:
        print(
            f"\nValidation: DIVERGENCE - expected llm=${REF_LLM}, "
            f"headline=${REF_HEADLINE}, queries={REF_QUERIES}"
        )
        sys.exit(1)
