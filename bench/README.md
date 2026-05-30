# agent-cost-bench

Production-shaped benchmark harness for multi-agent LLM systems. Runs realistic
scenarios against real provider APIs, captures complete traces, and compares
actual usage to the cost simulator's predictions inside [calc.ajinkya.ai](https://calc.ajinkya.ai/).

The harness's job is to give the simulator empirical credibility — every
coefficient the simulator uses (cache hit rate, retry waste, multi-agent
handoff overhead, etc.) is testable here.

## Why this exists

A cost calculator that says "$30,836/mo" with no validation is a model. The
same number with a published variance report against real API runs is a
*measurement*. This package produces those reports.

If you're a NASA architect, a federal CIO, or a startup CTO trying to procure
a multi-agent system: download this, run it against your scenario, get a
calibration report you can put in a procurement document.

## Production-shaped, not toy

The bench uses what real teams use:

| Concern | What we use | Why |
|---|---|---|
| Provider abstraction | **LiteLLM** | One client, 100+ providers, consistent `usage` capture (including `cached_tokens`) |
| Multi-agent orchestration | **LangGraph** | The de-facto state-machine framework for agent flows in 2026 |
| Tracing | **OpenTelemetry GenAI semconv** | Emits standard `gen_ai.*` spans — works with Langfuse, Arize, Phoenix, Datadog out of the box |
| Tool calling | Native function calling + **MCP** | Mirrors what production agents actually do |
| Vector retrieval | **Chroma** (default) or **pgvector** | Real embedding + similarity search, not mocked |
| Cost reporting | Per-call attribution, OTEL spans | Auditable down to each request_id |

If we'd written custom OpenAI/Anthropic SDK wrappers, traces would look like
nobody's production. By using LiteLLM + LangGraph + OTEL, the traces this bench
produces look like traces from a real deployment — credible for a paper or a
procurement review.

## Installation

```bash
cd ai-cost-calculator-studio/bench
pip install -e .             # base install
pip install -e .[rag,mcp]    # with optional RAG + MCP scenarios
```

## Running a scenario

Set provider credentials:

```bash
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
```

Run a scenario (CLI prints the estimated cost upfront and asks for confirmation):

```bash
agent-cost-bench run scenarios/long-chat.yml
```

Output:

```
reports/long-chat-2026-05-05T...-trace.json     # full OTEL trace
reports/long-chat-2026-05-05T...-summary.md     # readable session summary
```

Compare against the simulator's predictions for the same scenario:

```bash
agent-cost-bench compare reports/long-chat-2026-05-05T...-trace.json \
                         --scenario scenarios/long-chat.yml \
                         --simulator-export ./scenario-from-calc.json
```

This emits a variance report:

```
reports/long-chat-2026-05-05T...-variance.md
{
  "cache_hit_rate":          { "predicted": 0.84, "actual": 0.91, "delta": +0.07 },
  "sysprompt_tokens":        { "predicted": 800,  "actual": 760,  "delta": -40 },
  "retry_rate":              { "predicted": 0.03, "actual": 0.01, "delta": -0.02 },
  "multi_agent_handoff_tok": { "predicted": 200,  "actual": 340,  "delta": +140 }
}
```

## Scenario library

Each scenario is a self-contained YAML spec. The current set (12 scenarios):

| Scenario | Pattern | Validates |
|---|---|---|
| `smoke-test.yml` | minimal plumbing check | harness wiring, OTEL trace shape, cost reporting |
| `long-chat.yml` | long-shared-sysprompt 6-turn chat (OpenAI variant) | OpenAI cache hit ramp, sysprompt amortization |
| `cached-pipeline.yml` | long-shared-sysprompt cached pipeline (OpenAI) | OpenAI cache write/read pattern |
| `cached-pipeline-anthropic.yml` | long-shared-sysprompt cached pipeline (Anthropic) | Anthropic cache-write share w (measured w ≈ 0.20 on Sonnet 4.5, May 14, 2026) |
| `tool-chain.yml` | agent calls a chain of tools with structured returns | tool-schema overhead, tool-result tokens |
| `streaming-pipeline.yml` | streaming output, multi-stage pipeline | time-to-first-token, steady-state output rate |
| `parallel-fan-out.yml` | orchestrator + 3 parallel specialists | handoff tokens, parallel-call cache suppression |
| `multi-stage-research.yml` | sequential 5-stage research pipeline | cumulative-context growth across stages, handoff overhead |
| `data-discovery.yml` | discovery-style agent (gpt-4o-mini variant) | I/O ratio on tool-orchestration topology |
| `data-discovery-gpt52.yml` | discovery-style agent (gpt-5.2 variant) | I/O ratio on a higher-tier model on the same topology |
| `public-geospatial-react.yml` | production-shape geospatial Q&A agent, **templated tool returns** | templated-floor anchor (N=20, 238 calls, 3,342 tok/turn, $0.00178/q) |
| `public-geospatial-react-freeform.yml` | same agent, **freeform tool returns** (full STAC items) | freeform anchor (N=5, 60 calls, 22,798 tok/turn, $0.01392/q); paired ~3–6× cost lever vs templated (with 7.8× as the heaviest-config single-run upper bound — replication on a second dataset measured 2.3–6.2×) |

The v0.1.0 pilot calibration used 9 of these 12 scenarios (174 calls).
The three production-shape scenarios — `public-geospatial-react` (templated),
`public-geospatial-react-freeform` (freeform), and `cached-pipeline-anthropic`
(Anthropic w) — were added in May 2026 to anchor the paper's
tool-response architecture finding and the symmetric Eq. 2 validation.

## Authoring your own scenario

The scenario YAML format — `topology`, `agents`, `turns`, `tools`, cost
caps — is documented in [`AUTHORING.md`](AUTHORING.md). To contribute a
scenario or a measured coefficient back, see
[`../CONTRIBUTING.md`](../CONTRIBUTING.md).

## Trace format

Per the OpenTelemetry GenAI semantic conventions
([see spec](https://opentelemetry.io/docs/specs/semconv/gen-ai/)):

```json
{
  "scenario": "long-chat",
  "started_at": "2026-05-05T14:00:00Z",
  "config_hash": "sha256:...",
  "calls": [
    {
      "trace_id": "...",
      "span_id": "...",
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-5.2",
      "gen_ai.usage.input_tokens": 4200,
      "gen_ai.usage.output_tokens": 180,
      "gen_ai.usage.cached_tokens": 3800,
      "gen_ai.request.temperature": 0.2,
      "gen_ai.operation.name": "chat",
      "duration_ms": 920,
      "request_id": "req_...",
      "tool_calls": ["search","db_query"]
    }
  ],
  "session_totals": {
    "input_tokens": 84000,
    "output_tokens": 5400,
    "cached_tokens": 76000,
    "cost_usd": 0.087
  }
}
```

## Calibration loop

Variance reports across many scenarios feed into a versioned
`coefficients.json` that the simulator consumes. When the variance report says
"cache_hit_rate predicted 0.84, actual 0.91 across 50 runs," the simulator's
default for that coefficient gets bumped to 0.91 — and the published
predictions on calc.ajinkya.ai now have a measurement provenance.

## Reproducibility

Every scenario run is reproducible:

- Scenario YAML pins the model version, temperature, and prompt template
- LiteLLM logs the exact API request body
- OTEL trace includes `request_id` for re-running the same call against
  provider audit logs
- `--seed` flag for deterministic prompts (where supported)

## Cost guardrail

The CLI estimates cost before running and requires confirmation. Default
sample size is 50 queries; expect $0.30–$2.00 per scenario run depending on
models. Use `--max-cost-usd` to enforce a hard cap.

## License

MIT. Use it, fork it, publish your own variance reports.
