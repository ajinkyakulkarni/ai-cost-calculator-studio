# @ajinkyakulkarni/cost-calc-mcp

An **MCP server** that costs AI-agent deployments — wired to the same engine that powers **[calc.ajinkya.ai](https://calc.ajinkya.ai)**, so the numbers it returns are byte-identical to the visual calculator.

The LLM (your Claude Code / Cursor / Claude Desktop) runs the conversation; it **never does the arithmetic**. Every dollar figure comes from `compute_cost`, which is *hard-gated* — it refuses to return a number until the cost-driving inputs (volume, model, hosting, cache rate, per-query token profile) are actually provided. Describe your deployment in plain language; the agent proposes sensible defaults, confirms what it must, computes, and hands back a `calc.ajinkya.ai/#w=…` link to open the full visual model.

## Install

**Claude Code:**
```bash
claude mcp add cost-calc -- npx -y @ajinkyakulkarni/cost-calc-mcp
```

**Cursor / Claude Desktop** — add to your `mcpServers` config:
```json
{
  "mcpServers": {
    "cost-calc": {
      "command": "npx",
      "args": ["-y", "@ajinkyakulkarni/cost-calc-mcp"]
    }
  }
}
```

### Prefer zero install? Use the hosted endpoint
No npm needed — point your client at the hosted Worker:
```bash
claude mcp add --transport http cost-calc https://calc.ajinkya.ai/mcp
```
(Cursor / Desktop: an `mcpServers` entry with `"url": "https://calc.ajinkya.ai/mcp"`.)

## Tools
`list_presets` · `load_preset` · `get_schema` · `validate_workload` · `compute_cost` · `make_share_link`

Plus a `cost_interview` prompt for a guided session — or just say *"help me cost an AI agent."*

## Example prompts
Talk to your assistant naturally — for example:
- *"Cost a single-agent RAG support bot for ~5,000 monthly users on gpt-5-mini."*
- *"How much would a 3-agent research fleet cost at 50k MAU with FedRAMP moderate?"*
- *"Load the customer-support-fleet preset and show me the cost on a cheaper model."*
- *"What drives the cost in my deployment — show me the breakdown."*
- *"Give me a share link so I can open this in the visual calculator."*

## Worked example
*(Conversation wording is illustrative — it varies by client/model — but the numbers and the tool behavior below are exactly what the engine returns.)*

**You:** "Cost a RAG support bot for about 5,000 monthly users — single agent, managed API."

**Assistant** → calls `validate_workload`, which flags the inputs it still needs, and proposes defaults:
> Before I quote a number, confirm:
> - **Model** — I'll assume **gpt-5-mini**.
> - **Per query** — ~**3,000 input / 500 output tokens**, **80% cache hit** (typical for a stable system prompt).
> - **Volume** — 5,000 MAU × 0.2 sessions/day × 10 questions.

**You:** "Yes, that's right."

**Assistant** → calls `compute_cost` (the *engine* does the math, not the model):
> **≈ $397 / month** (~**$0.00118 per query**) — managed API, gpt-5-mini.
> Breakdown: LLM $397 · infra $0 · verification $0.
> Open it in the visual calculator: `https://calc.ajinkya.ai/#w=…`

### The hard gate in action
`compute_cost` returns **no number** until the cost-drivers are present. Omit the model, for example, and you get:
```json
{
  "error": "missing_required",
  "message": "Cannot compute a cost until these inputs are provided …",
  "missing_required": [
    { "field": "model", "why": "Per-token rates depend on the model.",
      "suggested_value": { "defaults": { "model": "gpt-5.4" } },
      "rationale": "A current flagship; pick your actual model." }
  ]
}
```
That's the anti-hallucination guarantee: the assistant must gather (or confirm) real inputs before any dollar figure exists.

## Why trust the numbers
- **Same engine as the website.** This package bundles the canonical engine modules verbatim (no fork); a parity check asserts byte-identical output across all 18 presets.
- **No hallucinated math.** The model only fills in a structured `workload` and calls the engine.
- **Auditable.** Every result carries the assumptions it made and the engine's derivation trace.

## Requirements
Node ≥ 18. Runs locally over stdio; no API key (the engine is pure math — your client provides the model).

## Links
- Calculator: https://calc.ajinkya.ai
- Source: https://github.com/ajinkyakulkarni/ai-cost-calculator-studio

MIT
