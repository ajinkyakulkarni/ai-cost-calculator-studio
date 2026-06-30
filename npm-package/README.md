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
