# cost-calc MCP server

Stateless MCP server that costs AI-agent deployments using the calculator's
canonical engine. The LLM runs the interview; every number comes from the
engine via `compute_cost` (hard-gated so it refuses until the cost-driving
inputs are present). Numbers are byte-identical to calc.ajinkya.ai.

## Install (Claude Code)
```bash
npm install
claude mcp add cost-calc -- node /Users/akulkarn/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/mcp/server.mjs
```

## Use
Invoke the `cost_interview` prompt, or just say "help me cost an AI agent". The
agent proposes defaults, confirms the cost-drivers, computes, and returns a
`calc.ajinkya.ai/#w=…` link to open the full visual calculator.

## Tools
list_presets · load_preset · get_schema · validate_workload · compute_cost · make_share_link

## Test
```bash
npm run mcp:test
```
