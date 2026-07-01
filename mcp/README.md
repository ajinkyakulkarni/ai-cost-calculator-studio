# cost-calc MCP server

Stateless MCP server that costs AI-agent deployments using the calculator's
canonical engine. The LLM runs the interview; every number comes from the
engine via `compute_cost` (hard-gated so it refuses until the cost-driving
inputs are present). Numbers are byte-identical to calc.ajinkya.ai.

Three ways to use it — pick one.

## 1. Hosted (zero install)
Point any MCP client at the live Worker — no npm, no clone:
```bash
claude mcp add --transport http cost-calc https://calc.ajinkya.ai/mcp
```
Cursor / Claude Desktop: an `mcpServers` entry with `"url": "https://calc.ajinkya.ai/mcp"`.

## 2. npx (published package, no clone)

**Claude Code:**
```bash
claude mcp add cost-calc -- npx -y @ajinkyakulkarni/cost-calc-mcp
```

**Cursor** (`.cursor/mcp.json`) **/ Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "cost-calc": { "command": "npx", "args": ["-y", "@ajinkyakulkarni/cost-calc-mcp"] }
  }
}
```

**Version-pinned:** `claude mcp add cost-calc -- npx -y @ajinkyakulkarni/cost-calc-mcp@1.0.0`

> `npx -y` caches the package after first download. If prices change in a new
> version, run `npx --yes @ajinkyakulkarni/cost-calc-mcp@latest` (or clear the
> npx cache) to pick it up.

## 3. Local from this repo (contributors / development)
```bash
git clone https://github.com/ajinkyakulkarni/ai-cost-calculator-studio.git
cd ai-cost-calculator-studio && npm install
claude mcp add cost-calc -- node "$(pwd)/mcp/server.mjs"
```

## Use
Invoke the `cost_interview` prompt, or just say "help me cost an AI agent". The
agent proposes defaults, confirms the cost-drivers, computes, and returns a
`calc.ajinkya.ai/#w=…` link to open the full visual calculator.

## Example prompts
- *"Cost a single-agent RAG support bot for ~5,000 monthly users on gpt-5-mini."*
- *"How much would a 3-agent research fleet cost at 50k MAU with FedRAMP moderate?"*
- *"Load the customer-support-fleet preset and show me the cost on a cheaper model."*
- *"What drives the cost — show the breakdown."* · *"Give me a share link."*

## Worked example
*(Wording is illustrative; the numbers + tool behavior are exactly what the engine returns.)*

> **You:** "Cost a RAG support bot for ~5,000 monthly users — single agent, managed API."
> **Assistant** → `validate_workload` → proposes gpt-5-mini, ~3,000 in / 500 out tokens,
> 80% cache, 5,000 MAU × 0.2 × 10, and asks you to confirm.
> **You:** "Yes."
> **Assistant** → `compute_cost` → **≈ $397/month** (~$0.00118/query), + breakdown + a
> `calc.ajinkya.ai/#w=…` link.

Omit a cost-driver (say, the model) and `compute_cost` returns **no number** —
`{ "error": "missing_required", "missing_required": [{ "field": "model", … }] }`.
That's the hard gate: real inputs before any dollar figure.

## Tools
list_presets · load_preset · get_schema · validate_workload · compute_cost · make_share_link

## Architecture
- **stdio** (methods 2 & 3): `mcp/server.mjs` + `mcp/lib/*.mjs`, reusing the canonical
  engine in `public/lib/*` via `createRequire`.
- **hosted** (method 1): `src/worker.mjs` serves `/mcp` (SDK Streamable HTTP) from the
  same site Worker; `src/*-worker.mjs` mirror the lib with esbuild-friendly imports.
- **npm package**: `npm-package/` bundles the engine into a self-contained tarball
  (`scripts/copy-engine.mjs` build step — single source of truth, no fork).

All three share one engine, so numbers stay identical across surfaces (guarded by the
HTTP/stdio parity tests).

## Test
```bash
npm run mcp:test         # stdio server + engine parity (run from repo root)
npm run mcp:test:http    # against a running `wrangler dev` (the /mcp Worker)
node scripts/test-packaged.mjs   # build + verify the npm tarball before publishing
```
