# NASA EIE preset — bench validation, 2026-05-12

## Summary

The NASA EIE preset's anchor_query was re-measured against the real
OpenAI API after the bench harness was extended with two structural
features missing from the previous run:

1. **Templated tool responses** — the bench's `tool_response_mode`
   was set to `templated`, matching the production EIE agent's
   centralized response-template layer. In freeform mode, tool
   returns carry the full structured payload (geometry polygons,
   item arrays, per-item stat dicts); in templated mode the LLM
   sees only short status messages while the structured payloads
   stay in server-side state. This is the cost-dominant difference
   between bench and production for long-session agents.
2. **build_viz_tiles tool** — added so the bench exercises all 7
   stages of the real EIE pipeline (the previous bench had 6).

## Configuration

| Setting | Value |
|---|---|
| Scenario | `bench/scenarios/eie-react.yml` |
| Model | gpt-5.2 (OpenAI, standard tier) |
| Topology | single agent + ReAct tool loop |
| Tools | 7 (parse_datetime, geocode, search_collections, select_collection, search_items, compute_stats, build_viz_tiles) |
| Tool response mode | `templated` |
| User turns per session | 6 |
| Repeats | 3 |
| Total user-turns | 18 |
| Total LLM calls | 36 (≈ 2.0 calls/turn — one gate confirmation per user turn) |
| Trace artifact | `reports/eie-react-2026-05-13T02-41-33-523087+00-00-trace.json` |

## Measured vs. predicted

| Coefficient | Predicted | Measured | Δ% | Pass? |
|---|---:|---:|---:|:---:|
| `cache_hit_rate` | 0.75 | **0.86** | +14.6% | ✓ within ±15% |
| `per_turn_input_tokens` | 3,921 | **3,376** | −13.9% | ✓ within ±15% |
| `per_turn_output_tokens` | 56 | **42** | −25.3% | ⚠ slightly outside ±15% |
| `llm_calls_per_user_turn` | — | **2.0** | — | observe-only |
| `median_latency_ms` | — | **1,136** | — | observe-only |

## Preset updates applied

The preset's `anchor_query` was re-anchored to the measured values:

- `input_tokens`: 3,921 → **3,376**
- `output_tokens`: 56 → **42**
- `cache_rate_baseline`: 0.75 → **0.86**

The previous values are preserved in `_calibration.previous_values`
so calibration drift is auditable.

## Interpretation

- **Cache rate jumped from 0.75 to 0.86** because the bench's system
  prompt was extended from ~700 tokens to ~1,000 tokens in the
  templated-responses work. A longer cacheable prefix makes the
  per-turn user message a smaller fraction of total input.
- **Per-turn output dropped from 56 to 42 tokens** because the
  bench prompt now includes a strict "say *Statistics retrieved.*
  and terminate" rule. Real production agents that allow short
  natural-language summaries will be higher.
- **Per-turn input is within ±15%** of the preset's prediction —
  the calc's prediction is defensible for procurement.

## Cost note

The variance report still flags `session_cost_usd` as off because the
comparator's predicted-cost fallback (`$5/M in, $15/M out`) doesn't
match gpt-5.2 standard-tier rates ($1.75 / $14). The *measured* cost
($0.0346 across 18 user-turns = $0.0019/query) is authoritative —
it comes from LiteLLM's billed `response_cost` per call. The
prediction-side fallback is a known limitation, not a calc-side error.

## Reproducibility

```bash
# From the bench/ directory, with .env loaded:
agent-cost-bench run scenarios/eie-react.yml --max-cost-usd 2.00 --yes
agent-cost-bench compare reports/eie-react-*-trace.json \
    --simulator-export ../public/examples/nasa-eie.json
```

Total spend for this validation run: ~$0.05 (well under the $2.00 cap).
