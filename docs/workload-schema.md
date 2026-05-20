# Workload JSON schema

A workload JSON is the input the calculator runs on. It is what
**Import/Export JSON** round-trips, what the share-link hash encodes, and
what the files in `public/examples/` contain.

This is a reference for authoring an example by hand. The canonical
normalizer is `normalizeWorkload` in `public/lib/cost-engine.js` — anything
you omit gets a default from there, so a minimal workload is short and the
engine fills in the rest. The fastest way to a valid file is still to copy
`public/examples/public-geospatial-qa.json` and edit it.

All examples below are drawn from that file.

---

## Top-level shape

```json
{
  "schemaVersion": "1.0",
  "deployment":   { ... },
  "anchor_query": { ... },
  "tool_response_mode": "templated",
  "shapes":   { ... },
  "mix":      { ... },
  "segments": [ ... ],
  "verification":   { ... },
  "rate_limit":     { ... },
  "daily_cap":      { ... },
  "infrastructure": { ... },
  "defaults":       { ... },
  "migration":      { ... }
}
```

`deployment`, `anchor_query`, `shapes`, `mix`, `segments`, and `defaults`
are load-bearing — every example should set them. The rest are optional
cost layers; omit a block and that layer contributes nothing.

---

## `schemaVersion`

String. Currently `"1.0"`. Identifies the workload format.

## `deployment`

Identity and compliance context for the deployment.

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Display name shown in the UI. |
| `agency` | string | Owning org. Anonymize it for a public example. |
| `description` | string | One or two sentences on what the agent does. |
| `publicFacing` | bool | Whether anonymous users can reach it (drives bot-traffic modeling). |
| `fedrampTier` | string | `none` \| `low` \| `moderate` \| `high` — applies the federal cost multiplier. |

## `anchor_query`

The representative single query the per-query cost is built from.

| Field | Type | Meaning |
|---|---|---|
| `input_tokens` | int | Input tokens for one baseline (`full`-shape) query. |
| `output_tokens` | int | Output tokens for one baseline query. |
| `cache_rate_baseline` | float 0–1 | Effective prompt-cache hit rate at the baseline session length. |
| `session_baseline_turns` | int | Turns in the session that `cache_rate_baseline` was measured at. |
| `example` | string | A real example question, shown in the UI. |
| `payload_modes` | object | Optional. Named token-shape variants (`minimal` / `moderate` / `heavy`), each with its own `input_tokens`, `output_tokens`, `cache_rate_baseline`, `label`, `description`. Lets one example carry a measured floor and estimated heavier variants. |
| `_calibration` | object | Optional but **required if you claim "measured."** Provenance — see below. |

### `anchor_query._calibration`

If your numbers came from a real API run, document it here. Fields are
free-form provenance, but reviewers look for:

- `validated_against` — provider and model, e.g. `"real OpenAI API (gpt-5.2)"`.
- `validated_on` — ISO date.
- `sample_size` — e.g. `"120 user-turns (6 turns × 20 repeats); 238 LLM calls"`.
- `bench_scenario` — path to the scenario YAML that produced it.
- `validation_report` / `trace_artifact` — paths under `bench/reports/`.
- `accuracy_statement` — the measured tolerance.

An example with a `_calibration` block but no committed trace will not be
accepted as "measured" — see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

## `tool_response_mode`

String: `templated` or `freeform`. Whether tool returns are condensed to
short status strings before the LLM sees them (`templated`) or serialized
into context in full (`freeform`). This is the single largest per-query
cost lever; default `templated`.

## `shapes`

The canonical query shapes. Each is expressed as a factor relative to a
`full`-pipeline call.

```json
"full": { "input_factor": 1.00, "output_factor": 1.00, "cache_eligible": true, "description": "Full pipeline" }
```

| Field | Type | Meaning |
|---|---|---|
| `input_factor` | float | Input tokens as a multiple of `anchor_query.input_tokens`. |
| `output_factor` | float | Output tokens as a multiple of `anchor_query.output_tokens`. |
| `cache_eligible` | bool | Whether this shape can hit the prompt cache (`refusal` typically cannot). |
| `description` | string | What this shape represents. |

Keep the five standard keys (`full`, `rag`, `partial`, `refusal`, `heavy`)
unless your workload genuinely has different shapes.

## `mix`

Named blends of the shapes. Each entry has a `label` and a `weights` object
mapping shape name → fraction. Weights should sum to 1.0.

```json
"mixed": { "label": "Mixed (40/30/15/10/5)",
           "weights": { "full": 0.40, "rag": 0.30, "partial": 0.15, "refusal": 0.10, "heavy": 0.05 } }
```

## `segments`

Array of audience segments. Monthly query volume is computed per segment.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable key. |
| `label` | string | Display name. |
| `mau` | int | Monthly active users in this segment. |
| `sessions_per_day` | float | Average sessions per user per day. |
| `questions_per_session` | int | Average questions per session. |
| `applyBotFactor` | bool | Whether to apply the bot-overhead multiplier (true for anonymous segments). |
| `description` | string | Who this segment is. |

## `verification`

Optional. The post-hoc fact-checking layer. Omit the block to disable it.

| Field | Type | Meaning |
|---|---|---|
| `enabled` | bool | Whether verification runs. |
| `coverage` | float 0–1 | Fraction of responses verified. |
| `atoms_per_response` | int | Atomic facts decomposed per response. |
| `variant` | string | Verifier preset — `fr1` / `fr2` / `fr3` / `minicheck` / etc. |
| `atomizer_tokens` / `reviser_tokens` / `nli_tokens` | `{input,output}` | Token shapes for each verification stage. |
| `retrieval` | string | Evidence source, e.g. `wikipedia`. |
| `nli_hosting` | string | Where the NLI model runs — `ec2-g6`, `bedrock`, `azure`, direct API, etc. |
| `service_pod_monthly` | number | Fixed monthly cost of the verification service pod. |

## `rate_limit`

Optional. Edge rate-limiting.

| Field | Type | Meaning |
|---|---|---|
| `strategy` | string | e.g. `edge`. |
| `monthly_cost` | number | Fixed monthly cost of the rate-limiting layer. |
| `bot_ceiling` | number | Upper bound the gateway enforces on the bot multiplier. |

## `daily_cap`

Optional. The daily-spend safety cap and refusal accounting.

| Field | Type | Meaning |
|---|---|---|
| `enabled` | bool | Whether a daily cap applies. |
| `amount_usd` | number | Hard daily LLM-spend ceiling. |
| `burst_days` | int | Burst days per 30-day month (default split is 7/30). |
| `burst_factor` | number | Demand multiplier on a burst day. |

## `infrastructure`

Optional. A flat object of `"line item": monthly_usd` pairs (RDS, ALB, S3,
CloudWatch, …). Summed into the fixed-infrastructure layer.

## `defaults`

The starting control values when the example loads. The regression and
`calc.js` paths read this block, so it must reflect how the example is
meant to be evaluated.

| Field | Type | Meaning |
|---|---|---|
| `model` | string | A key in `public/lib/prices.js` `llm_models`. |
| `tier` | string | `standard` \| `flex` \| `batch` \| `priority`. |
| `mix` | string | A key in the `mix` block. |
| `rate_limit` | string | A `rate_limit.strategy` value. |
| `hosting` | string | `api` \| `self` \| `hybrid`. |
| `cost_mode` | string | `optimistic` \| `realistic` (self-host sizing). |

## `migration`

Optional. A multi-year phased plan.

| Field | Type | Meaning |
|---|---|---|
| `enabled` | bool | Whether the migration timeline renders. |
| `phases` | array | Each: `label`, `months`, `hosting`, `reservation_type`, optional `apiSplit` (for `hybrid`), `description`. |

---

## Minimal valid workload

Everything else defaults. This is enough for the engine to produce a
headline:

```json
{
  "schemaVersion": "1.0",
  "deployment": { "name": "My agent", "publicFacing": true, "fedrampTier": "none" },
  "anchor_query": { "input_tokens": 4000, "output_tokens": 300, "cache_rate_baseline": 0.80, "session_baseline_turns": 6 },
  "segments": [
    { "id": "users", "label": "Users", "mau": 5000, "sessions_per_day": 0.3, "questions_per_session": 6, "applyBotFactor": false }
  ],
  "defaults": { "model": "gpt-5.2", "tier": "standard", "mix": "mixed", "hosting": "api", "cost_mode": "optimistic" }
}
```

Verify it before opening a PR:

```bash
node scripts/calc.js --preset <slug> --json | jq .headline.monthly
```
