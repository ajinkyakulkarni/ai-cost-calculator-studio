# Three-way response-templating bench: empirically test the paper's 7.5× cost lever

**Status:** Design — awaiting user review
**Date:** 2026-05-26
**Author:** ajinkyakulkarni
**Reviewers:** —
**Related:** `docs/REPRODUCING.md`, `bench/scenarios/public-geospatial-react.yml`, `bench/scenarios/public-geospatial-react-freeform.yml`, calc preset `public/examples/public-geospatial-qa.json`

## Problem

The paper's Section 5 worked example reports two anchor operating points for the same agent on the same workload: $1,097/month (templated tool returns) and $8,222/month (freeform tool returns), a paired 7.5× spread. The paper calls this the **tool-response architecture cost lever**.

Internally there is uncertainty about whether the 7.5× figure is real or a strawman:

> "Templated response is not going to save that much money."
> — coworker pushback, 2026-05-26

The coworker's implicit objection: real production agents do not actually let the LLM see raw STAC items. Modern LangChain / LangGraph / OpenAI Assistants flows use `structured_output` + Pydantic models that already extract key fields. If the realistic comparison is "raw freeform" vs "key-fields-templated", the lever might be much smaller than 7.5× — possibly only 2-3×. If so, the paper's claim is technically true but compares against a strawman that no production team actually deploys.

The current bench (`bench/scenarios/public-geospatial-react.yml` and `…-freeform.yml`) tests the paper's two endpoints (status-only-templated vs freeform) with simulated tool functions, not real STAC API responses. To settle the argument we need (a) real STAC payloads, not simulated, and (b) a three-way comparison that includes the production-realistic middle ground.

## Goals

1. **Empirically measure** the templating cost lever against real NASA VEDA STAC + MiCASA Land Carbon Flux v1 data, on real OpenAI GPT-5.2 calls.
2. **Three-way comparison**, not two. The middle ground (key-fields templating, what production agents actually do) is the test the paper omits.
3. **Two conversation patterns** so we know whether the lever depends on conversation shape:
   - Paper's 6-turn single-shot ReAct loop (the workload the paper measured).
   - Multi-gate drill-down pattern with ~9-10 turns (the workload an actually-deployed scientific Earth-data assistant uses).
4. **One trace JSON per run** plus a single Markdown summary comparing all 6 runs on per-query input/output tokens, cache hit rate, per-query cost, and projected monthly cost at 915K queries.
5. **Reproducibility.** Re-runs from the same scenario manifest produce comparable numbers (within provider-side cache and call-rate variance).

## Non-goals

- Not building a production application. The agent in this bench is a measurement instrument, not a product.
- Not testing model-quality differences. All six scenarios use the same model (GPT-5.2 by default) with the same temperature.
- Not validating the calc's other cost lines (verification, fixed costs, federal additive). Those have their own bench scenarios.
- Not testing the gated deployment directly. The "gated drill-down" conversation pattern *models* the gated-drill-down workload shape; it does not import, paraphrase, or reuse any gated code or prose. (See "Constraints" below.)

## Architecture

Six scenarios arranged as a 2 × 3 matrix:

|  | A: status-only | B: key-fields | C: freeform |
|---|---|---|---|
| **Pattern P** (paper's 6-turn ReAct) | P-A | P-B | P-C |
| **Pattern E** (gated drill-down, 5 gates, ~9-10 turns) | E-A | E-B | E-C |

Each cell is a runnable scenario YAML in `bench/scenarios/geo-qa-templating/`. The orchestrator (`agent-cost-bench run geo-qa-templating --all`) executes all 6 against:
- **Model:** OpenAI `gpt-5.2`, temperature 0
- **STAC catalog:** NASA VEDA STAC at `https://openveda.cloud/api/stac/`
- **Collection:** `micasa-carbonflux-monthgrid-v1` (MiCASA Land Carbon Flux v1, MERRA-2 driven, hosted by NASA GHG Center)
- **AOI:** Mendocino County, California (a single county-level polygon)
- **Variable / band:** `FIRE` (per-monthly grid wildfire carbon flux)
- **Window:** 2020-06-01 to 2020-11-01 (pre-fire to post-fire, 6 monthly items)

Same workload across all 6 scenarios. The only thing that differs between cells:
- Across rows: which conversation pattern the agent follows
- Across columns: which response handler middleware is wrapped around the tools

The empirically clean comparison: same query, same data, same model, same tools — only the middleware (rows: + the orchestration) varies.

## Response handler contracts

The three middleware classes intercept every tool return before it is serialized into the LLM's next-turn context. All three are pure functions over a typed tool response, defined as Pydantic schemas.

### A — `StatusOnlyHandler`

Each tool returns ≤ 60 tokens, regardless of input size. The schema is uniform across tools:

```python
class StatusReturn(BaseModel):
    ok: bool
    summary: str          # ≤ 50 tokens, deterministic format per tool
    tool_call_id: str     # opaque ref; LLM never reads it
    error: Optional[str] = None
```

Example for `search_items` returning 6 STAC items over Mendocino in 2020-06..2020-10:

```json
{
  "ok": true,
  "summary": "6 items found in micasa-carbonflux-monthgrid-v1, 2020-06 to 2020-10",
  "tool_call_id": "ti_3f2a"
}
```

The structured payload (6 items, every property, every asset URL, every geometry coord) is held in agent-side state keyed by `tool_call_id`. The final answer composer reads numeric stats from the `compute_stats` return (which is itself templated to ≤ 60 tokens) and writes prose from those numbers. The LLM never sees raw STAC items, ever.

This is the most aggressive templating contract — what the paper assumes when it claims 7.5×.

### B — `KeyFieldsHandler`

The keystone of the test. ~5-10 essential fields per tool response, with per-tool schemas:

```python
class GeocodeReturn(BaseModel):
    admin_name: str            # "Mendocino County"
    admin_level: str           # "county"
    bbox: tuple[float, float, float, float]
    # dropped: geometry coords, alternate names, parent admin chain

class STACItemFields(BaseModel):
    id: str                    # "micasa-carbonflux-monthgrid-v1-20200601"
    datetime: str              # ISO 8601
    bbox: tuple[float, float, float, float]
    primary_asset_url: str     # the COG band the LLM might need to reference
    # dropped: full `properties` dict, all non-primary assets, raw geometry, provider blob

class SearchItemsReturn(BaseModel):
    items: list[STACItemFields]    # ≤ 10 entries even if more match
    total_matched: int

class ComputeStatsReturn(BaseModel):
    band: str
    n_items: int
    mean: float
    median: float
    min: float
    max: float
    per_item: list[dict[str, float]]  # {item_id, mean} per item, no extras
```

Drops: full STAC `properties` dict (typically 20-50 fields per item), every non-primary asset URL (MiCASA items have ~10 assets), raw geometry polygon coords (only bbox kept), provider provenance blob, item-level extras (eo:bands list, raster:bands stats summary). The LLM has enough to reason about which items matter, to cite specific items by ID in its answer, and to reason about the spatial/temporal scope — but it does not see the raw blobs.

This is the contract most LangChain/LangGraph production agents default to via `structured_output` + Pydantic. **This is the contract the coworker says is realistic; the paper does not compare against it.**

### C — `FreeformHandler`

Identity function. Returns the raw STAC response as `json.dumps(stac_response, indent=2)`. Full geometry coords, every asset URL, every property, full provider blob. This is what a naive ReAct loop using `tools[...].invoke(args)` does without any output structuring.

Sized example (real MiCASA item from VEDA): a single item serialized JSON is ~2.1 KB ≈ 500 tokens. `search_items` returning 6 such items → ~12 KB ≈ 3,000 tokens per call. Multiply by 5 tool calls and 6 turns of cumulative history and you see why the paper's freeform anchor sits at 22,798 tokens/turn.

### Implementation note

All three handlers are pure transformations of the same real STAC response from NASA VEDA. The only thing that varies between scenario runs is which handler is wrapping the tool call. The same `veda_tools.search_items(…)` function is invoked in all three; the response is then either status-summarized (A), field-extracted (B), or passed through (C) before reaching the LLM.

This is the empirically clean isolation. Same tools, same data, same model, same agent system prompt, same conversation pattern within a row — the only variable is the response middleware.

## Conversation patterns

### Pattern P — paper's 6-turn single-shot ReAct

Agent receives one user query:

> "Visualize FIRE flux contribution from MiCASA Land Carbon Flux v1 over Mendocino County, California, June 2020 to November 2020."

Agent runs the full tool chain autonomously in a single ReAct loop. No human-in-the-loop, no confirmation gates. Tool sequence: `parse_datetime` → `geocode` → `search_collections` → `search_items` → `compute_stats`. Final answer composed at turn 6.

Matches the workload pattern the paper measured. Used to establish the apples-to-apples comparison against the paper's $1,097 / $8,222 anchors.

### Pattern E — gated drill-down, ~9-10 turns

Agent receives a deliberately under-specified query:

> "Analyze the contribution of the 2020 California wildfires to total CO2 flux using model-estimated carbon flux data."

Agent runs 5 confirmation gates, in order:

1. **Datetime gate** — agent proposes a default window, user-actor confirms it.
2. **State gate** — agent asks for area of interest, user-actor answers "California".
3. **County drill-down** — agent enumerates 2-3 most-impacted counties, user-actor picks "Mendocino".
4. **Dataset gate** — agent searches collections, user-actor picks "MiCASA Land Carbon Flux v1".
5. **Variable gate** — agent enumerates bands (NPP, FIRE, HR, NEE), user-actor picks "FIRE".

Between gates, the agent runs the corresponding tool (`parse_datetime`, `geocode`, `search_collections`, etc.). After the 5th gate the agent runs `search_items` + `compute_stats` autonomously and composes the answer. Total ~9-10 turns including 5 gate-response round-trips.

The "user actor" is a deterministic Python function in `geo_qa_user_actor.py`, not another LLM. It reads from a fixed answer list keyed by gate type. Re-runs are bit-for-bit reproducible.

Pattern E models the cumulative-input growth of a gated multi-turn conversation that the paper's single-shot pattern does not exercise. If templating savings depend on conversation shape (more turns = more cumulative payload across turns = bigger savings from templating), pattern E will surface that.

## Tools (5)

All five implemented against real NASA VEDA STAC. No mocks. No simulated payloads.

1. **`parse_datetime(text: str) → ParseDatetimeReturn`** — local Python, no API call. Uses `dateparser` (already a bench dep) to handle natural-language ranges. Returns `{start, end}` in ISO 8601.

2. **`geocode(text: str, level: str) → GeocodeReturn`** — uses NASA VEDA's geocoder if exposed by their API; otherwise falls back to a shipped county-bbox lookup table in `bench/data/us_county_bboxes.json` (covers ~3,100 US counties, sourced from Census TIGER, public domain). For the bench's single AOI (Mendocino), the lookup table is the source of truth so the bench has no external geocode dependency.

3. **`search_collections(text: str) → SearchCollectionsReturn`** — calls `GET https://openveda.cloud/api/stac/collections`, filters client-side by keyword match on collection `title` + `description`. Returns top 5 collections by relevance.

4. **`search_items(collection_id: str, bbox: tuple, datetime_range: str) → SearchItemsReturn`** — calls `GET /collections/{id}/items?bbox=…&datetime=…&limit=20`. Real STAC items, real metadata, real asset URLs. For MiCASA this returns monthly grids matching the bbox/datetime filter.

5. **`compute_stats(items: list[str], band: str, geometry: dict) → ComputeStatsReturn`** — for each STAC item, fetches the COG asset for the requested band and computes mean/median/min/max over the polygon AOI. Implemented via `rio-tiler` (already a bench candidate dep — common in geospatial pipelines). Returns per-band aggregates plus per-item monthly values for timeseries display.

The tool function signatures are uniform across handlers; the handler wraps the return value.

## Workload parameters (frozen for reproducibility)

```yaml
model: gpt-5.2
temperature: 0
stac_root: https://openveda.cloud/api/stac/
collection: micasa-carbonflux-monthgrid-v1
aoi:
  admin_name: Mendocino County
  state: California
  bbox: [-123.890, 38.756, -122.819, 40.005]
window:
  start: 2020-06-01
  end:   2020-11-01
variable: FIRE
repeats: 1   # single run per scenario; cache effects are observed across the turns within one session
```

A single run per scenario keeps total spend at ~$5. If variance is suspected after a first pass, bumping `repeats: 5` is a follow-up.

## Output / reporting

Per scenario:
- One trace JSON in `bench/reports/geo-qa-templating/{scenario}-{timestamp}.trace.json` with per-turn input/output tokens, cache hit rate, tool calls, raw LLM messages.

Across the 6 scenarios:
- One Markdown summary at `bench/reports/geo-qa-templating/2026-05-26-summary.md` with a 6-row comparison table:

| scenario | pattern | mode | turns | tokens/turn (in) | tokens/turn (out) | cache hit % | $/query | $/month @ 915K |
|---|---|---|---|---|---|---|---|---|
| P-A | paper | status-only | 6 | … | … | … | … | … |
| P-B | paper | key-fields  | 6 | … | … | … | … | … |
| P-C | paper | freeform    | 6 | … | … | … | … | … |
| E-A | gated | status-only | ~10 | … | … | … | … | … |
| E-B | gated | key-fields  | ~10 | … | … | … | … | … |
| E-C | gated | freeform    | ~10 | … | … | … | … | … |

Plus two ratio rows:
- `C/A ratio`: directly tests the paper's 7.5× claim
- `C/B ratio`: tests realistic production lever (freeform vs key-fields)

Plus a short paragraph of findings: which mode the paper anchored on, where reality sits, whether the coworker's pushback holds.

## Repo layout

```
bench/
  scenarios/
    geo-qa-templating/
      pattern-paper-status-only.yml
      pattern-paper-key-fields.yml
      pattern-paper-freeform.yml
      pattern-gated-status-only.yml
      pattern-gated-key-fields.yml
      pattern-gated-freeform.yml
  src/agent_cost_bench/
    veda_tools.py              # 5 real tools against NASA VEDA STAC
    response_handlers.py       # StatusOnlyHandler, KeyFieldsHandler, FreeformHandler
    geo_qa_user_actor.py       # deterministic gate-answerer for pattern E
    geo_qa_patterns.py         # LangGraph state machines for patterns P and E
  data/
    us_county_bboxes.json      # shipped fallback for geocode tool
  reports/geo-qa-templating/
    {scenario}-{timestamp}.trace.json    # one per run
    2026-05-26-summary.md                # the comparison report
docs/specs/
  2026-05-26-geo-qa-templating-three-way-bench-design.md  # this file
```

## CLI

```
# Run all six scenarios end-to-end + emit summary
agent-cost-bench run geo-qa-templating --all --model gpt-5.2 --emit-summary

# Run a single scenario (debug / re-run a flaky one)
agent-cost-bench run geo-qa-templating/pattern-gated-key-fields --model gpt-5.2

# Re-emit the summary from existing traces without re-running
agent-cost-bench report geo-qa-templating --since 2026-05-26
```

## Constraints

- **No gated prose paraphrase.** Pattern E models the gated-drill-down *workload shape* (number of gates, when the agent waits for user input, what gets confirmed). All agent system prompts, gate prompt wording, response strings, emoji conventions, and final-answer phrasing are written from scratch in neutral terse style. Do not import, paraphrase, or stylistically mirror any gated code or chat content. (Durable user preference.)
- **No `Co-Authored-By: Claude` trailer** on commits for this work. (Durable user preference.)
- **Engine is untouched.** This bench measures; it does not modify `public/lib/cost-engine.js`. `bench-validate` must remain 6/6 at ±0.00% after every commit in this work.
- **Tools call real APIs.** No mocked responses anywhere in the tool layer. The `repeats: 1` setting is for cost control; bumping it is a follow-up.

## Risks / open questions

1. **NASA VEDA STAC availability.** The bench depends on `openveda.cloud/api/stac/` being responsive and returning the MiCASA collection. If the API is down or rate-limits, scenarios will fail. Mitigation: cache real STAC responses to `bench/data/cached-veda/` on the first successful run and use the cache for re-runs (still real data, just locally pinned).
2. **COG fetch time.** `compute_stats` reads MiCASA COGs from NASA's data store. Per-item read is ~200-500ms. With 6 items × 5 tool calls across all scenarios that's tens of seconds of wall-clock. Acceptable for an offline measurement.
3. **GPT-5.2 prompt-cache behaviour.** OpenAI's cache TTL is documented as "minutes". If the 6 scenarios are run back-to-back, later scenarios may benefit from warmer caches than earlier ones, distorting per-scenario cache-hit comparisons. Mitigation: run the 6 scenarios in randomized order across two passes (12 runs total, $10 spend) and report the mean. Decide based on first-pass variance whether the second pass is needed.
4. **User-actor fixed answers.** Pattern E's deterministic user is a simplification. A real user might choose a different county or dataset, changing the agent's tool-arg distribution. Acceptable for this bench because we only care about the cumulative-token effect of the gated pattern, not the answer correctness.

## Acceptance criteria

The bench is "done" when:

1. All six scenario YAMLs exist and are individually runnable.
2. `agent-cost-bench run geo-qa-templating --all` produces 6 trace JSONs + 1 Markdown summary.
3. The summary's `C/A ratio` column has a credibly-measured value (≥ 1 successful run per scenario, OpenAI-reported cached_tokens included in the trace).
4. `npm run bench:validate` in the calc repo still passes 6/6 at ±0.00%.
5. The findings paragraph in the summary explicitly addresses: "is the paper's 7.5× claim correct against real data, and is the realistic production lever (C/B) meaningfully smaller?"

## Implementation plan

Out of scope for this design doc — will be produced by the `writing-plans` skill after this spec is approved.
