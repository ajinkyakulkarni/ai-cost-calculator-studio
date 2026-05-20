# Authoring a bench scenario

A scenario is a self-contained YAML file in `bench/scenarios/` that pins a
topology, the agents, and the user turns. `agent-cost-bench run` executes it
against a real provider API and writes a trace.

This guide covers the scenario format. For *why* the bench exists and how
traces feed `coefficients.json`, see [`README.md`](README.md). For how to
submit a scenario, see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

The fastest start is to copy `scenarios/smoke-test.yml` and edit it.

---

## File shape

```yaml
name: my-scenario
description: One sentence on what topology this exercises and what it validates.
topology: single
repeat: 3
max_cost_usd: 0.30

agents:
  - id: researcher
    role: research-assistant
    model: gpt-4o-mini
    temperature: 0.2
    max_output_tokens: 600
    system_prompt: |
      You are a research assistant. ...

turns:
  - user: "First user message."
  - user: "Second user message."
```

## Top-level fields

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Scenario id. Match the filename (`my-scenario.yml` → `name: my-scenario`). |
| `description` | yes | What topology this exercises and which coefficient it validates. |
| `topology` | yes | `single`, `sequential`, or `parallel` — see below. |
| `repeat` | yes | How many times the whole scenario runs. Sample size = `repeat` × number of `turns`. |
| `max_cost_usd` | yes | Hard cost cap. The run aborts rather than exceed it. |
| `meta` | no | Free-form provenance — `inspired_by`, `validates_axiom_coefficients`, etc. Not executed. |
| `agents` | yes | The agent(s) — see below. |
| `turns` | yes | The user messages — see below. |

## `topology`

How the agents are wired:

- **`single`** — one agent. Each `turns` entry is a message to it. Use for
  chat, tool-loop, and streaming scenarios.
- **`sequential`** — the agents are pipeline stages. The output of stage N
  is concatenated into stage N+1's context. `turns` usually holds a single
  user query that flows through all stages. Use to measure handoff overhead
  and cumulative-context growth.
- **`parallel`** — an orchestrator fans out to specialist agents and
  fans their results back in. Use to measure parallel-call cache
  suppression and fan-in cost.

## `agents`

Array. For `single` topology, one entry; for `sequential` / `parallel`,
one per stage/specialist, **in order**.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Stable identifier for the agent in the trace. |
| `role` | yes | Human-readable role label. |
| `model` | yes | A LiteLLM model id (`gpt-4o-mini`, `gpt-5.2`, `claude-sonnet-4-6`, …). Pin it — calibration numbers are model-specific. |
| `temperature` | yes | Sampling temperature. |
| `max_output_tokens` | yes | Output cap per call. |
| `system_prompt` | yes | The system prompt. Use a YAML block scalar (`|`). |
| `tools` | no | List of tool names the agent can call. Bare strings resolve to schemas in `src/agent_cost_bench/tools.py` (`TOOL_SCHEMAS`) — currently `search`, `fetch_doc`, `query_db`. These are real local function executions, not mocks. |

## `turns`

Array of user messages. Each entry is `{ user: "..." }`. Multi-line
messages use a YAML block scalar:

```yaml
turns:
  - user: |
      A longer multi-line
      user message.
```

For `single` topology, turns are sent in order to the one agent (so a
6-entry `turns` list is a 6-turn conversation). For `sequential`, the
single user query feeds stage 1; more turns means more workflow runs.

---

## Workflow

1. **Copy `smoke-test.yml`** and rename it to your scenario.
2. **Smoke it** — set `repeat: 1` and run once. The CLI prints an estimated
   cost and asks for confirmation; confirm only if it looks right.
   ```bash
   agent-cost-bench run scenarios/my-scenario.yml
   ```
3. **Check the trace** in `bench/reports/` — confirm the call count, token
   usage, and any tool calls look like what you intended.
4. **Scale up** — raise `repeat` to the sample size you need for variance
   (3 is a minimum for a variance estimate; the production-shape scenarios
   in this repo use 5–20). Keep `max_cost_usd` sane for the new size.
5. **Run for real** with `--yes` to skip the prompt once you trust it.

## Cost discipline

- The CLI estimates cost up front and requires confirmation. `--yes`
  skips the prompt — only use it after a smoke run.
- `max_cost_usd` is a hard cap; the run aborts before exceeding it. Always
  set it.
- Typical cost is $0.30–$2.00 per scenario run depending on models and
  `repeat`. Frontier models cost roughly 10× a `gpt-4o-mini` run — smoke on
  `gpt-4o-mini` first, then switch the `model` field for paper-grade
  calibration.
