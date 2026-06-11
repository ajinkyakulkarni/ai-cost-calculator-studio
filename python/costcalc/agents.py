"""agents.py — Multi-agent pipeline cost math.

Mirrors: public/lib/cost-engine.js
  - agentToolTokenBreakdown() lines 375-416
  - agentToolInputTokens() lines 420-424 (back-compat, not used internally)
  - perQueryCostAgents() lines 427-766
  - applyClarificationStrategy() lines 782-800 (imported from llm.py)

Key implementation notes matching JS behavior:
  - Mix blending in agent mode (f9a1526 fix): agent costs are blended across
    configured shapes exactly like workload mode. Default fallback shape is
    {full: 1.0} which replicates "worst-case single shape" when no mix is set.
  - schemaTok billed at agent's cache rate; resultTok billed at partial cache
    via tool_result_cache_share (default 0.5). This is fix-A (2026-06-03).
  - calls_per_turn_multiplier: ReAct/reflection loop multiplier on per-call cost.
  - activation_rate: fraction of queries the agent runs on.
  - turn_share: multiplies effective call count.
  - factcheck_passes: each pass adds another full per-call bill (1+passes mult).
  - tool_result_react_persistence: accumulation factor for result tokens across
    ReAct turns.
  - cache_rate_override: per-agent cache rate (0..1 or 1..99 integer percent).
  - max_output_tokens: cap on outT (applied before shape factor).
  - sysprompt_tokens: amortized over calls (cache-hot prefix).
  - iamsg_tokens: added every call.
  - fewshot_examples × tokens_per_fewshot_example: amortized over calls.
  - jsonschema_tokens, memory_tokens: per call (cache-eligible).
  - rag: rag_chunks × rag_tokens_per_chunk × rag_calls_per_query (fresh per call).
  - reasoning: thinking_budget_tokens × reasoning_turns_pct/100 + cot_steps×100.
  - citations: citation_output_tokens per call.
  - guard tokens: guard_input + guard_pii + guard_policy (input) + guard_output.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

from ._utils import to_float as _to_float

from .llm import (
    apply_clarification_strategy,
    effective_cached_rate,
    task_mix_output_multiplier_for_agent,
)


def agent_tool_token_breakdown(
    agent: Dict[str, Any],
    workload: Dict[str, Any],
) -> Tuple[float, float]:
    """Returns (schemaTok, resultTok) per query.

    Mirrors agentToolTokenBreakdown() in cost-engine.js lines 375-416.

    schemaTok: schema tokens (cache-eligible; billed at agent's cache rate).
    resultTok: result tokens (per-call payload; billed at partial cache
               via tool_result_cache_share, NOT full agent cache rate).
    """
    reg = (workload or {}).get("tools_registry") or {}
    enabled = (agent or {}).get("enabled_tools") or {}
    global_mode = (workload or {}).get("tool_response_mode") or "freeform"

    schema_tok = 0.0
    result_tok = 0.0

    for tid, spec in enabled.items():
        if not spec or not (_to_float(spec.get("calls_per_query")) > 0):
            continue
        t = reg.get(tid)
        if not t:
            continue
        calls_nominal = _to_float(spec.get("calls_per_query"))
        memo_rate = _to_float(t.get("memoize_hit_rate") if t.get("memoize") else 0)
        trig_raw = spec.get("trigger_rate")
        trig = (
            _to_float(trig_raw)
            if (trig_raw is not None and 0.0 <= _to_float(trig_raw) <= 1.0)
            else 1.0
        )
        calls_eff = calls_nominal * max(0.0, 1.0 - memo_rate) * trig
        schema = _to_float(t.get("schema_tokens"))
        raw_result = _to_float(t.get("result_tokens_avg"))

        # return_shape resolution: spec override → registry → global mode
        shape = spec.get("return_shape_override") or t.get("return_shape") or global_mode
        cap_raw = spec.get("cap_tokens_override")
        cap = (
            _to_float(cap_raw) if cap_raw is not None
            else (_to_float(t.get("cap_tokens")) if t.get("cap_tokens") is not None else 40.0)
        )
        eff_result = min(raw_result, cap) if shape == "templated" else raw_result

        schema_tok += calls_nominal * schema
        result_tok += calls_eff * eff_result

    return schema_tok, result_tok


def per_query_cost_agents(
    workload: Dict[str, Any],
    main_model_id: str,
    tier_id: str,
    cache_rate: float,
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Mirrors perQueryCostAgents(). Returns {per_query, breakdown}."""
    opts = options or {}
    mult = workload["tier_multipliers"].get(tier_id, 1.0)

    # Mix-blending (f9a1526 fix): same shape×mix logic as workload mode
    mix_id = opts.get("mix") or (workload.get("defaults") or {}).get("mix") or "worst"
    mix = (workload.get("mix") or {}).get(mix_id)
    mix_weights: Dict[str, float] = (
        mix.get("weights") if (mix and mix.get("weights") and len(mix.get("weights", {})) > 0)
        else {"full": 1.0}
    )

    total = 0.0
    breakdown: List[Dict[str, Any]] = []

    for agent in workload.get("agents") or []:
        hosting = agent.get("hosting") or "api"
        calls = _to_float(agent.get("calls_per_query"), 1.0)
        in_t = _to_float(agent.get("input_tokens"))
        out_t = _to_float(agent.get("output_tokens"))

        # BYOK / self-host: $0 API cost for this agent
        if hosting in ("byok", "self-host"):
            breakdown.append({
                "id": agent.get("id"),
                "label": agent.get("label") or agent.get("id"),
                "hosting": hosting,
                "model": agent.get("model") or main_model_id,
                "calls": calls, "input": in_t, "output": out_t,
                "per_call_cost": 0.0, "per_query_cost": 0.0,
                "note": (
                    "Excluded from API total — user provides their own key."
                    if hosting == "byok"
                    else "Excluded from API total — costed in self-host section."
                ),
            })
            continue

        model_id = agent.get("model") or main_model_id
        rates = workload["rate_cards"].get(model_id)
        if not rates:
            continue

        # Sysprompt amortized over calls; iamsg per call
        sys_amortized = _to_float(agent.get("sysprompt_tokens")) / max(1.0, calls)
        ia_per_call = _to_float(agent.get("iamsg_tokens"))

        # write_share: agent → opts → anchor → rate-card default → 0
        agent_write_share = agent.get("cache_write_share")
        if agent_write_share is None:
            cws = opts.get("cacheWriteShare")
            if cws is not None:
                agent_write_share = cws
            else:
                aq_ws = (workload.get("anchor_query") or {}).get("cache_write_share")
                if aq_ws is not None:
                    agent_write_share = aq_ws
                else:
                    rc_default = (workload.get("rate_cards") or {}).get(model_id, {}).get("cache_write_share_default")
                    agent_write_share = rc_default if rc_default is not None else 0.0

        p_cached_eff = effective_cached_rate(rates, agent_write_share)

        # Per-agent output multiplier (task_bias or workload mix)
        agent_out_mult = task_mix_output_multiplier_for_agent(agent, workload)

        # ReAct loop multiplier
        loop_mult_raw = _to_float(agent.get("calls_per_turn_multiplier"), 0.0)
        llm_call_mult = loop_mult_raw if (math.isfinite(loop_mult_raw) and loop_mult_raw > 0) else 1.0

        # Activation rate
        act_raw = agent.get("activation_rate")
        if act_raw is not None:
            act_fv = _to_float(act_raw, 1.0)
            active_rate = act_fv if (math.isfinite(act_fv) and 0.0 <= act_fv <= 1.0) else 1.0
        else:
            active_rate = 1.0

        # Tool token breakdown (schema vs result split — fix-A)
        agent_schema_tok, agent_result_tok = agent_tool_token_breakdown(agent, workload)

        # Per-agent extras
        fewshot_n = _to_float(agent.get("fewshot_examples"))
        # JS: `Number(agent.tokens_per_fewshot_example) || 200` — 0 is falsy,
        # so an explicit 0 ALSO falls back to 200. Match that exactly.
        fewshot_tok_per_ex = _to_float(agent.get("tokens_per_fewshot_example"), 0.0) or 200.0
        fewshot_in_amortized = (fewshot_n * fewshot_tok_per_ex) / max(1.0, calls)
        json_schema_in = _to_float(agent.get("jsonschema_tokens"))
        memory_in = _to_float(agent.get("memory_tokens"))
        rag_in_per_call = (
            _to_float(agent.get("rag_chunks"))
            * _to_float(agent.get("rag_tokens_per_chunk"))
            * _to_float(agent.get("rag_calls_per_query"))
        )
        reasoning_out = (
            _to_float(agent.get("thinking_budget_tokens"))
            * max(0.0, min(100.0, _to_float(agent.get("reasoning_turns_pct")))) / 100.0
        )
        cot_out = _to_float(agent.get("cot_steps")) * 100.0
        citation_out = _to_float(agent.get("citation_output_tokens"))
        factcheck_passes = max(0.0, _to_float(agent.get("factcheck_passes")))
        guard_in = (
            _to_float(agent.get("guard_input_tokens"))
            + _to_float(agent.get("guard_pii_tokens"))
            + _to_float(agent.get("guard_policy_tokens"))
        )
        guard_out = _to_float(agent.get("guard_output_tokens"))

        turn_share_raw = agent.get("turn_share")
        turn_share = (
            _to_float(turn_share_raw)
            if (turn_share_raw is not None and math.isfinite(_to_float(turn_share_raw, 0.0)) and _to_float(turn_share_raw, 0.0) > 0)
            else 1.0
        )
        eff_calls = calls * turn_share

        # max_output_tokens cap
        out_cap_raw = agent.get("max_output_tokens")
        if out_cap_raw is not None:
            out_cap = _to_float(out_cap_raw)
            capped_out_t = min(out_t, out_cap) if (math.isfinite(out_cap) and out_cap > 0) else out_t
        else:
            capped_out_t = out_t

        # Per-agent cache rate override
        cache_override_raw = agent.get("cache_rate_override")
        agent_cache_rate = None
        if cache_override_raw is not None:
            crv = _to_float(cache_override_raw, 0.0)
            if math.isfinite(crv) and crv > 0:
                if crv > 1:
                    agent_cache_rate = min(0.99, crv / 100.0)
                else:
                    agent_cache_rate = min(0.99, crv)

        # Blend across shape mix
        agent_per_query = 0.0
        blended_per_call = 0.0
        blended_tool_cost = 0.0
        weight_sum = 0.0

        for shape_name, weight in mix_weights.items():
            shape = (workload.get("shapes") or {}).get(shape_name)
            if not shape or not (weight > 0):
                continue
            in_factor = float(shape.get("input_factor") if shape.get("input_factor") is not None else 1)
            out_factor = float(shape.get("output_factor") if shape.get("output_factor") is not None else 1)
            shape_cache_eligible = agent.get("cache_eligible") and (shape.get("cache_eligible") is not False)

            eff = (
                (agent_cache_rate if agent_cache_rate is not None else cache_rate)
                if shape_cache_eligible else 0.0
            )

            # Per-call input
            eff_in_t = (
                in_t * in_factor + sys_amortized + ia_per_call
                + fewshot_in_amortized + json_schema_in + memory_in
                + rag_in_per_call + guard_in
            )
            cached = eff_in_t * eff
            uncached = eff_in_t - cached

            # Per-call output
            eff_out_t = (
                capped_out_t * out_factor * agent_out_mult
                + reasoning_out + cot_out + citation_out + guard_out
            )

            per_call = (
                uncached * rates["input_per_million"] / 1e6
                + cached * p_cached_eff / 1e6
                + eff_out_t * rates["output_per_million"] / 1e6
            ) * mult * (1.0 + factcheck_passes)

            # Tool cost for this shape
            shaped_schema_tok = agent_schema_tok * in_factor
            shaped_result_tok = agent_result_tok * in_factor
            shape_tool_cost = 0.0

            if shaped_schema_tok > 0:
                schema_cached = shaped_schema_tok * eff
                shape_tool_cost += (
                    (shaped_schema_tok - schema_cached) * rates["input_per_million"] / 1e6
                    + schema_cached * p_cached_eff / 1e6
                ) * mult * active_rate

            if shaped_result_tok > 0:
                # ReAct accumulation (persistence)
                raw_persist = (
                    agent.get("tool_result_react_persistence")
                    if agent.get("tool_result_react_persistence") is not None
                    else (
                        workload.get("tool_result_react_persistence")
                        if workload.get("tool_result_react_persistence") is not None
                        else 0.0
                    )
                )
                persist = max(0.0, min(1.0, _to_float(raw_persist)))
                react_multiplier = 1.0 + max(0.0, calls - 1.0) * persist
                accumulated_result_tok = shaped_result_tok * react_multiplier

                # tool_result_cache_share
                DEFAULT_RESULT_CACHE_SHARE = 0.5
                raw_share = (
                    agent.get("tool_result_cache_share")
                    if agent.get("tool_result_cache_share") is not None
                    else (
                        workload.get("tool_result_cache_share")
                        if workload.get("tool_result_cache_share") is not None
                        else DEFAULT_RESULT_CACHE_SHARE
                    )
                )
                share = max(0.0, min(1.0, _to_float(raw_share)))
                cached_portion = accumulated_result_tok * eff * share
                fresh_portion = accumulated_result_tok - cached_portion
                shape_tool_cost += (
                    fresh_portion * rates["input_per_million"] / 1e6
                    + cached_portion * p_cached_eff / 1e6
                ) * mult * active_rate

            shape_contrib = eff_calls * per_call * llm_call_mult * active_rate + shape_tool_cost
            agent_per_query += weight * shape_contrib
            blended_per_call += weight * per_call
            blended_tool_cost += weight * shape_tool_cost
            weight_sum += weight

        if weight_sum > 0:
            agent_per_query /= weight_sum
            blended_per_call /= weight_sum
            blended_tool_cost /= weight_sum

        total += agent_per_query
        breakdown.append({
            "id": agent.get("id"),
            "label": agent.get("label") or agent.get("id"),
            "hosting": hosting,
            "model": model_id,
            "calls": calls,
            "input": in_t,
            "output": out_t,
            "tool_input_tokens": agent_schema_tok + agent_result_tok,
            "tool_schema_tokens": agent_schema_tok,
            "tool_result_tokens": agent_result_tok,
            "tool_cost": blended_tool_cost,
            "per_call_cost": blended_per_call,
            "per_query_cost": agent_per_query,
        })

    # Apply clarification strategy wrapper
    adjusted = apply_clarification_strategy(workload, total)
    return {"per_query": adjusted, "breakdown": breakdown}
