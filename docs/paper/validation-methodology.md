# Validation methodology: empirical calibration of AI cost-simulator coefficients

> Section of the AXIOM cost-calculator paper. Covers the methodology by
> which every coefficient AXIOM uses is measured against real provider
> APIs, the design of the `agent-cost-bench` harness, the scenario
> library, the calibrated results, and threats to validity.

## 1. Motivation

A cost simulator without empirical validation is a model with hand-tuned
constants. The constants may be plausible — derived from documentation,
napkin math, or the authors' production experience — but they are not
*measurements*. Procurement reviewers, federal authorising officers, and
serious technical due diligence reviewers cannot defend a number whose
derivation is "we picked it."

The contribution of this section is a methodology for converting an AI
cost simulator's constants from hand-tuned defaults into measured values
with auditable provenance. The methodology is implemented as
`agent-cost-bench`, an open-source harness that runs production-shape
multi-agent scenarios against real LLM provider APIs, captures complete
traces (per the OpenTelemetry GenAI semantic conventions), and emits
variance reports that compare measured per-call usage to the simulator's
predictions.

The output of the methodology is a versioned `coefficients.json` file
that the simulator (in this work, AXIOM, exposed at calc.ajinkya.ai)
loads at startup. Every value in the file names its source scenario,
sample size, provider, and measured range — so a reviewer can audit how
each constant was derived without re-running the experiment.

## 2. Cost model recap

For context, AXIOM models the monthly cost of an LLM-agent deployment as
the sum of five layers:

```
total_monthly_cost  =  per_session_token_cost × monthly_query_volume
                    +  infrastructure_monthly
                    +  compliance_overhead
                    +  personnel
                    +  amortized_migration
```

The token-cost layer is the focus of this validation work, because it
is both the most slider-driven and the most often miscalibrated.
Infrastructure, compliance, and personnel are dollar line items pulled
from procurement quotes; they do not require empirical measurement in
the same sense.

Per-session token cost expands as:

```
session_cost = Σ_agents [ (1 - cache_hit_rate) × input_tokens × rate_in
                        +      cache_hit_rate  × input_tokens × rate_in × cache_discount
                        + retry_rate × input_tokens × rate_in × retry_penalty
                        + output_tokens × rate_out ]
```

with `input_tokens` itself a sum over sysprompt, few-shot examples, tool
schemas, RAG chunks, multimodal inputs, and conversation history.

Eight coefficients in this expansion are candidates for empirical
validation: `cache_hit_rate`, `cache_discount`, `retry_rate`,
`retry_penalty`, sysprompt-tokens, tool-schema-tokens,
tool-result-tokens, and multi-agent handoff overhead. Two more
(time-to-first-token, output-rate) emerge as new tracked coefficients
once we instrument streaming paths.

## 3. Harness architecture

The bench is implemented in Python, deliberately matching the production
stack that real teams deploy:

| Concern | Library | Rationale |
|---|---|---|
| Provider abstraction | **LiteLLM** | One client surface for 100+ providers; consistent normalised `usage` reporting (including provider-specific cache fields) |
| Multi-agent orchestration | **LangGraph** | The de-facto state-machine framework for multi-agent flows. State + edges + conditional routing match production agent code |
| Tracing | **OpenTelemetry GenAI semconv** | The published spec for `gen_ai.*` attributes. Traces work with Langfuse, Arize Phoenix, Datadog, etc., out of the box |
| Tool execution | **Real local function-calling** + **MCP servers** | No mocks. Tools execute real code so tool-result-token counts reflect production payloads |
| Vector retrieval | **Chroma** (default) or **pgvector** | Real embedding API + similarity search, not synthetic data |

The decision to use real production frameworks (rather than custom
SDK wrappers) is methodological. A bench that uses `openai.completions.
create()` directly looks like academic toy code; reviewers discount
the results. A bench that uses `LiteLLM + LangGraph + OTEL` looks
like the consumer's own production stack, and its measurements
transfer.

## 4. Scenario library

Each scenario is a self-contained YAML specification of an agent
topology, prompt templates, conversation flow, and provider/model
configuration. The library targets a coefficient-validation matrix:

| Scenario | Topology | Validates |
|---|---|---|
| `smoke-test` | Single agent, 3 turns | Plumbing only |
| `multi-stage-research` | Sequential 5-stage pipeline | Cumulative-context growth, sequential handoff overhead |
| `streaming-pipeline` | 3-stage with streaming | Time-to-first-token, output rate |
| `tool-chain` | Single agent + 3 tools | Tool-schema overhead, tool-result tokens |
| `data-discovery` | Single agent, 7 tools, confirmation gates | Confirmation-gated orchestration cost (EIE-shape pattern) |
| `cached-pipeline` | Long shared sysprompt, 6 turns | Provider cache hit rate (OpenAI auto, Anthropic explicit) |
| `parallel-fan-out` | Orchestrator + 3 parallel specialists | Parallel handoff cost, synthesizer fan-in |

Scenarios are designed to be reproducible: the YAML pins model version,
temperature, and prompt templates; LiteLLM logs the exact request body;
OTEL traces include `request_id` for cross-referencing against provider
audit logs.

## 5. Trace format

Every LLM call produces an OTEL span with GenAI-semconv attributes.
A scenario run yields a trace JSON artifact:

```json
{
  "scenario": "cached-pipeline",
  "started_at": "2026-05-06T...",
  "config_hash": "sha256:...",
  "calls": [
    {
      "trace_id": "...",
      "span_id": "...",
      "name": "chat gpt-4o-mini",
      "attributes": {
        "gen_ai.system": "openai",
        "gen_ai.request.model": "gpt-4o-mini",
        "gen_ai.usage.input_tokens": 1840,
        "gen_ai.usage.output_tokens": 56,
        "gen_ai.usage.cached_tokens": 1792,
        "gen_ai.response.id": "chatcmpl-..."
      },
      "duration_ms": 1224
    }, ...
  ],
  "session_totals": {
    "input_tokens": 39375,
    "output_tokens": 3287,
    "cached_tokens": 35840
  }
}
```

The trace artifact is the audit record. Any reviewer can replay any
call by querying the provider's request log with the captured
`response.id`.

## 6. Variance comparator

Given a trace artifact and the simulator's exported scenario JSON
(produced by AXIOM's "Export JSON" feature), the comparator computes
per-coefficient variance:

```
delta_relative_pct = (actual - predicted) / predicted × 100
```

Coefficients drifting more than ±15% from their predicted values are
flagged for calibration. The comparator emits both Markdown
(human-readable) and JSON (programmatic) outputs.

## 7. Results

The 0.1.0 release of `agent-cost-bench` ran 9 distinct scenarios
across 174 real LLM calls (cumulative spend $0.224, distributed
across OpenAI gpt-4o-mini, gpt-5.2, and Anthropic
claude-sonnet-4-5). Headline results follow.

### 7.1 cache_hit_rate

AXIOM's default: 0.84 (flat coefficient).

| Provider/scenario | Median hit rate | Cold (turn 0) | Warm (turn 1+) |
|---|---:|---:|---:|
| OpenAI gpt-4o-mini, multi-turn chat (cached-pipeline) | **0.91** | 0.61 | 0.94–0.97 |
| Anthropic claude-sonnet-4-5 (cached-pipeline) | **0.77** | 0.00 | 0.85–0.92 |
| OpenAI parallel fan-out (parallel-fan-out) | **0.60** | 0.00 | 0.72–0.85 |

**Findings:**

1. AXIOM's default (0.84) is conservative for OpenAI multi-turn chat
   workloads (actual 0.91); under-counting savings.
2. A flat coefficient is structurally wrong. The hit rate is a curve:
   cold-start at the cache write threshold, asymptoting to the
   sysprompt-fraction as conversation history grows.
3. Provider behavior differs materially. OpenAI's automatic
   prefix-matching extends the cache as conversation grows; Anthropic's
   explicit `cache_control` caches only the marked block (typically the
   system prompt). For the same workload, OpenAI wins by ~14 percentage
   points.
4. Parallel topologies suppress cache hit rate because each parallel
   call's prompt is shorter and less prefix-shareable.

**Recommended simulator update:** `cache_hit_rate` should be a
function of (provider, topology, turn_index, sysprompt_token_fraction)
rather than a single scalar. Phase-2 enhancement.

### 7.2 input_output_ratio

AXIOM's default: 6:1 (chat-style assumption).

| Scenario | I/O ratio | Notes |
|---|---:|---|
| Chat (cached-pipeline) | 12:1 | Long shared sysprompt + short turns |
| Sequential pipeline (multi-stage-research) | 2.2:1 | Each stage produces substantial output |
| Tool-chain (tool-chain) | 9:1 | Tool results dominate input |
| Data-discovery (gpt-4o-mini, EIE-shape) | **73:1** | Output-suppression rules + tool-state bypass |
| Data-discovery (gpt-5.2, EIE-shape) | **88:1** | Same shape, more concise model |

**Finding:** AXIOM's 6:1 default is wrong by an order of magnitude for
agents that follow the EIE pattern (long sysprompt + tool-state bypass +
output-suppression rules). For these agents, *input* is the dominant
cost driver; output is tiny. A simulator that assumes 6:1 understates
input cost by ~12×.

**Recommended simulator update:** Branch on agent topology. For
"tool-orchestration with output suppression" agents, use I/O ratio
~70:1; for chat-style, ~6:1; for analytical pipelines, ~2:1.

### 7.3 sequential_handoff_overhead_tokens

AXIOM's default: 200 tokens (flat per-stage constant).

Measured on multi-stage-research (5-stage pipeline):

| Stage | Cumulative input tokens | Per-stage growth |
|---|---:|---:|
| 1 (analyst) | 175 | — |
| 2 (feasibility) | 523 | +348 |
| 3 (architect) | 1,243 | +720 |
| 4 (implementer) | 2,038 | +795 |
| 5 (reviewer) | 2,854 | +816 |

**Finding:** Per-stage input growth averages ~700 tokens, dominated by
prior stages' outputs being concatenated into context. The 200-token
flat default understates this by 3.5× on a 5-stage pipeline. The
correct model is:

```
handoff_overhead(N) = Σ_(i<N) average_output_tokens_of_stage_i
```

i.e., overhead is a **linear function of upstream stage count**, not a
constant.

### 7.4 Latency coefficients (new)

AXIOM does not currently model latency. Bench introduces:

| Coefficient | gpt-4o-mini median | gpt-4o-mini p90 |
|---|---:|---:|
| `median_latency_ms` (blocking) | 1,224 | 3,437 |
| `time_to_first_token_ms` (streaming) | 873 | 4,956 |
| `output_rate_tokens_per_sec` (streaming) | 47 | 77 (max) |

These are first-class production planning numbers (queue depth,
user-perceived responsiveness, capacity reservations) that a cost
simulator without a latency model cannot inform.

## 8. Closing the calibration loop

The bench writes calibrated values into `coefficients.json`. The live
simulator (calc.ajinkya.ai) fetches this file at page load and applies
the values to its sliders. A "✓ MEASURED" badge appears in the topbar;
clicking it opens a panel listing every measured coefficient with its
source scenario, sample size, provider, and measured range.

This converts the simulator from a model into a measurement.
Procurement reviewers can audit every constant down to the trace
artifact and the provider's request_id. Reproducibility is
guaranteed by the harness being open-source.

## 9. Threats to validity

**Sample size.** Cache_hit_rate is measured over 18 calls in a single
scenario. Variance estimates would tighten with more runs and more
scenarios. v1 is sufficient for "is the default in the right
ballpark?"; deeper calibration requires 100+ runs per coefficient.

**Provider drift.** Cache implementations and pricing change. The
`coefficients.json` file is dated; consumers should re-run the bench
quarterly (or trigger on provider-pricing changes) to detect drift.

**Scenario coverage.** The 7 scenarios in v1 cover the most common
production patterns but not all of them. Specifically: long-running
batch jobs, fine-tuned models, inference-time RAG with realistic
billion-document corpora, and FedRAMP-grade isolated networks are all
out of scope for v1. Each is a future scenario.

**Realism of synthetic prompts.** Some scenarios (cached-pipeline,
parallel-fan-out) use NASA-themed Earth-science prompts as a
realistic-looking content corpus. The token counts do not depend on
content; the prompts are just there to drive non-trivial responses.
Reviewers concerned about content-specific bias can swap the prompts.

**LiteLLM normalization layer.** LiteLLM may strip or transform some
provider-specific fields. We mitigate by reading raw `usage` and the
nested `prompt_tokens_details.cached_tokens` directly; we do not rely
on LiteLLM to surface every field correctly. The bench's parser is
provider-aware where it matters.

## 10. Future work

1. Anthropic explicit-cache scenarios with ephemeral and 1h TTLs to
   characterise cache lifetime.
2. Multi-region deployment scenarios to measure egress + replication
   overhead.
3. Long-running batch jobs (large-scale offline inference) to validate
   the batch-tier discount.
4. Self-hosted scenario (vLLM + open-weight model) to validate the
   self-host break-even math.
5. Public benchmark page on calc.ajinkya.ai aggregating
   community-submitted variance reports.

The harness, scenarios, traces, and `coefficients.json` are all
open-source under MIT at
[github.com/ajinkyakulkarni/ai-cost-calculator-studio](https://github.com/ajinkyakulkarni/ai-cost-calculator-studio).

## Appendix A: Coefficient deltas summary

| Coefficient | AXIOM default | Measured | Δ% | Status |
|---|---:|---:|---:|---|
| cache_hit_rate | 0.84 | 0.91 (OpenAI) | +8% | Default conservative; calibrated |
| cache_hit_rate (Anthropic) | (0.84) | 0.77 | -8% | Provider-specific divergence — new sub-coefficient added |
| input_output_ratio | 6:1 | 73:1 (EIE-shape) | +1117% | Default wrong by an order of magnitude for tool-orchestration agents |
| sequential_handoff_overhead | 200 tok | 700 tok/stage | +250% | Default structurally wrong; replaced with linear function |
| median_latency_ms | not modeled | 1,224 | new | New tracked coefficient |
| time_to_first_token_ms | not modeled | 873 | new | New tracked coefficient |
| output_rate_tokens_per_sec | not modeled | 47 | new | New tracked coefficient |
| parallel_fan_out_synthesizer_input_tokens | not modeled | 1,900 | new | New tracked coefficient |
