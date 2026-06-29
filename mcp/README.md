# cost-calc MCP server

Stateless MCP server that costs AI-agent deployments using the calculator's
canonical engine. The LLM runs the interview; every number comes from the
engine via `compute_cost` (hard-gated so it refuses until the cost-driving
inputs are present). Numbers are byte-identical to calc.ajinkya.ai.

## Install (no clone needed)

### Claude Code
```bash
claude mcp add cost-calc -- npx -y @ajinkyakulkarni/cost-calc-mcp
```

### Cursor (`.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "cost-calc": { "command": "npx", "args": ["-y", "@ajinkyakulkarni/cost-calc-mcp"] }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "cost-calc": { "command": "npx", "args": ["-y", "@ajinkyakulkarni/cost-calc-mcp"] }
  }
}
```

### Version-pinned
```bash
claude mcp add cost-calc -- npx -y @ajinkyakulkarni/cost-calc-mcp@1.0.0
```

> **Note:** `npx -y` caches the package locally after the first download.
> If prices are updated in a new package version, run `npx --yes @ajinkyakulkarni/cost-calc-mcp@latest`
> or clear the npx cache to pick up the update.

---

## Install (repo clone — contributors and developers)

```bash
git clone https://github.com/ajinkyakulkarni/ai-cost-calculator-studio.git
cd ai-cost-calculator-studio
npm install
claude mcp add cost-calc -- node $(pwd)/mcp/server.mjs
```

---

## Use
Invoke the `cost_interview` prompt, or just say "help me cost an AI agent". The
agent proposes defaults, confirms the cost-drivers, computes, and returns a
`calc.ajinkya.ai/#w=…` link to open the full visual calculator.

## Tools
list_presets · load_preset · get_schema · validate_workload · compute_cost · make_share_link

## Test
```bash
# In-repo test suite (must be run from the repo root)
npm run mcp:test

# Packaged artifact test (build + verify tarball before publishing)
node scripts/test-packaged.mjs
```
