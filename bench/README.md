# agent-cost-bench

Production-shaped benchmark harness for multi-agent LLM systems. Runs realistic
scenarios against real provider APIs, captures complete traces, and compares
actual usage to the AXIOM simulator's predictions inside [calc.ajinkya.ai](https://calc.ajinkya.ai/).

The companion's job is to give the simulator empirical credibility — every
coefficient AXIOM uses (cache hit rate, retry waste, multi-agent handoff
overhead, etc.) is testable here.

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

Compare against AXIOM's predictions for the same scenario:

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

Each scenario is a self-contained YAML spec.

| Scenario | Pattern | Validates |
|---|---|---|
| `small-chat.yml` | 5-turn customer-support dialog | baseline single-agent cost |
| `long-chat.yml` | 30-turn analytical dialog with caching | cache hit ramp, sysprompt amortization |
| `rag-pgvector.yml` | query → embed → retrieve → answer | embedding API, retrieval-augment input |
| `tool-chain.yml` | agent calls DB → API → computation | tool-schema overhead, tool-result tokens |
| `mcp-chain.yml` | agent uses real MCP servers (filesystem + git) | MCP transport overhead |
| `parallel-fleet.yml` | orchestrator + 3 specialists running concurrently | handoff tokens, concurrency-quota waste |
| `nl2sql.yml` | NL → SQL → execute → summarize | structured-output overhead, error-correction loops |
| `deep-reasoning.yml` | extended-thinking task with factcheck | thinking tokens (provider-reported), factcheck atom counts |
| `refusal.yml` | out-of-scope queries that bounce early | actual refusal cost (often surprising) |

v1 ships with `long-chat`, `rag-pgvector`, `mcp-chain`. Others land progressively.

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
`coefficients.json` that AXIOM consumes. When the variance report says
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
