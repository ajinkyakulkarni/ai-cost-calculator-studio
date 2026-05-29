# Geospatial Q&A Templating Bench

Empirically tests the paper's claim that templating tool responses saves ~7.5× in agent input tokens.

The bench compares three response-handler modes — **status-only** (a 60-token summary), **key-fields** (the typed schema only), and **freeform** (raw STAC payload verbatim) — across two conversation patterns: **paper** (parallel ReAct, ~4–7 turns) and **gated** (gated drill-down, ~11–15 turns). All 6 scenarios run the same workload against NASA VEDA STAC + GPT-5.2, so the only variable is templating shape.

## Run it

```bash
cd bench
export OPENAI_API_KEY=...                      # required
python -m agent_cost_bench.cli run-geo-qa-templating --scenario all
python -m agent_cost_bench.cli report-geo-qa-templating
```

Add `--force-compute-stats` to require the agent to actually call `compute_stats` before its final answer — useful when mode A's status summaries are so terse the agent gives up early. The bench captures both natural and forced behaviour as separate trace files.

Each run writes a trace JSON to `bench/reports/geo-qa-templating/`. The report aggregates the latest trace per `(scenario_id, forced)` pair into `<date>-summary.md`.

## Files

| File | Role |
|---|---|
| `schemas.py` | Pydantic shapes for all 5 tool returns + `StatusReturn` |
| `handlers.py` | `StatusOnlyHandler`, `KeyFieldsHandler`, `FreeformHandler` |
| `stac_tools.py` | 5 real tools: `parse_datetime`, `geocode`, `search_collections`, `search_items`, `compute_stats` (hits VEDA STAC + raster API) |
| `dispatch.py` | `TOOL_SCHEMAS` (OpenAI tool format) + `dispatch_tool_call` |
| `user_actor.py` | Deterministic gate-answer fixture for the gated drill-down pattern |
| `pattern_paper.py` | LangGraph state machine — parallel ReAct |
| `pattern_gated.py` | LangGraph state machine — gated drill-down |
| `provider_shim.py` | Thin LiteLLM wrapper; converts LangChain Message → OpenAI dict |
| `runner.py` | Glue: scenario → pattern × handler → trace JSON |
| `scenario_loader.py` | YAML → `ScenarioCfg` |
| `report.py` | Trace JSONs → markdown summary |

Scenario YAMLs: `bench/scenarios/geo-qa-templating/`. Design + rationale: `bench/docs/specs/2026-05-26-geo-qa-templating-three-way-bench-design.md`. Tests: `bench/tests/geo_qa/` (128 tests, all mocked HTTP via `pytest-httpx`).

## Map previews

A standalone utility for eyeballing the geospatial layer an agent computed stats over. **Completely decoupled from the cost-measuring path** — it does not involve the LLM, does not affect token counts, and does not require an OpenAI key.

```bash
cd bench
# Fetch PNG previews for the first 3 items in the default collection
python -m agent_cost_bench.cli preview-geo-qa-templating

# Custom county, collection, and colormap
python -m agent_cost_bench.cli preview-geo-qa-templating \
    --county "Sonoma County, California" \
    --collection "lis-global-da-gpp" \
    --datetime "2020-06-01/2020-09-01" \
    --max-items 5 \
    --colormap plasma
```

Each preview is saved to `bench/reports/geo-qa-templating/preview-{item_id}.png` (400×400 PNG, viridis colormap by default). One bad item does not abort the rest — the command continues and prints a warning.

The underlying function is `map_preview.render_preview()` in `map_preview.py`. It calls the VEDA raster `/bbox` endpoint directly and raises a clear `ValueError` (rather than silently writing HTML) when the collection or item id is wrong — the same defensive pattern used by `compute_stats`.
