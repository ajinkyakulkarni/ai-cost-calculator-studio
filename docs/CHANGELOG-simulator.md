# Cost-Simulator changelog

History of the workflow/multi-agent simulator embedded in the calculator's
Simulator tab. These notes used to live inside the app UI; they're moved here
so they can be picked up as GitHub release notes when the next simulator
version is tagged.

---

## v9.6 — DAG topology + realistic long messages

Two refinements making the workflow simulation more representative of real
research-orchestration systems:

- **Long-form simulation messages.** In workflow mode, both user prompts and
  agent responses use realistic multi-paragraph templates that match what
  research-orchestration agents actually produce — structured outputs with
  sections like "What I observed", "What cannot be determined", "What I need
  from you", "Risks detected". Token counts shown in the live stream reflect
  actual session realities.
- **DAG topology controls.** Three execution patterns:
  - *Sequential* — linear pipeline, one agent at a time.
  - *Parallel* — all stages concurrently; wall-clock = max stage time but
    hits rate limits.
  - *Hybrid* — sequential trunk + parallel sub-branches at certain stages,
    realistic for research workflows.

  Cost is identical regardless of topology, but parallelism affects rate-limit
  overage costs and concurrent quota utilisation.
- **Concurrent quota model.** Each provider has a max concurrent request quota
  (e.g. Anthropic Tier 2 = 50 concurrent). Exceeding it triggers
  queueing/throttling — modelled as a 2% surcharge per overflow request. Rate-
  limit overage on retries adds 1.5× cost on the failed fraction.

The bundled research-workflow preset applies the hybrid topology by default
with 3 parallel branches and 20 concurrent quota.

## v9.5 — Workflow DAG mode

Adds an explicit **Workflow DAG mode** for sequential pipeline systems
(research orchestration, multi-stage analyst pipelines). Toggle in the topbar.
Workflow mode adds six cost components on top of the base per-agent
calculation:

- **Sequential chain handoff** — each stage's output becomes part of the next
  stage's input. Slider controls the % of prior output passed forward
  (typical 70–90%).
- **Bulk document ingestion** — PDFs/session × pages × tokens/page added to
  the % of stages that read the corpus. Distinct from RAG retrieval.
- **Partial rerun** — % of stages re-executed when users review and reject
  output. Multiplies base cost.
- **Fact-check sidecar** — separate verification call per stage with its own
  (typically cheaper) model. Common in research workflows where every output
  is checked.
- **Template amortization** — workflow planning is one-time but template runs
  many times. Subtracts a small saving as runs/template grows.
- **HITL pause storage** — session state retention during user review pauses.
  Negligible per session, accumulates at scale.

A calibrated research-workflow preset is available in the Routing tab
(5 stages, 8 PDFs/session, fact-check on every stage, 4 HITL pauses).

## v9.4 — Tool fees, cache write share, multi-tier pricing

Three structural improvements to the pricing engine:

- **Per-provider tool fees.** Web search, file search, and container-session
  fees are now keyed by the agent's provider+family. Anthropic web search is
  $10/1k; OpenAI Assistants $10/1k web + $2.50/1k file + $0.03/container
  session; Google Vertex Search Grounding $35/1k. Bedrock/Azure/OpenRouter
  pass through with no separate billing. Self-hosted has zero tool fees.
- **Tunable cache write share.** Cached tokens are split between cache reads
  (cheap, 90% discount) and cache writes (premium, ~25% over list price for
  the first hit on Anthropic's 5-minute TTL). The new slider lets you model
  "cold start" vs "steady state" deployments — the share defaults to 10%
  (steady state) but rises to 30–50% for low-volume or fresh deployments
  where the 5-minute TTL frequently expires.
- **Multi-tier long context.** Models can declare a `tiers[]` array with
  multiple price levels (e.g. Gemini standard ≤200k, long 200k–1M, ultra-long
  >1M). The legacy `longThreshold`/`longIn`/`longOut` binary format remains
  supported. The engine picks the highest `thresholdAt` ≤ current input size.

## v9 — Per-agent heterogeneous config

Exposes per-agent configuration as a first-class Agent Settings tab. Each
agent in a multi-agent fleet can have its own model, provider, turns share,
RAG/tools/reasoning/guardrail settings, cache rate, max output cap, and task-
type bias. The cost engine walks each agent independently and sums per-
session costs. This reveals that **uniform-fleet pricing materially
overstates real heterogeneous system costs** for some configurations and
understates them for others (notably when expensive specialised models like
Opus are used for high-context analyst roles).
