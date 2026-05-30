# AI Cost Calculator Studio

> **Live at [calc.ajinkya.ai](https://calc.ajinkya.ai)** — interactive,
> procurement-grade cost calculator for multi-agent LLM deployments,
> with empirically-validated coefficients.

A multi-agent LLM cost calculator + an open-source benchmark harness
that measures every coefficient against real provider APIs. Built for
federal procurement reviews, AI-startup capacity planning, and
research-grade cost-modeling papers — anywhere a number larger than
"$X per million tokens × N tokens" is needed.

What makes this different from generic per-token calculators:

- **Three-layer cost model**: token math × volume + infrastructure +
  compliance + people. The first layer alone is wrong by an order of
  magnitude for production agent workloads.
- **Empirically calibrated**: every coefficient has a measured value
  from `bench/` runs against real OpenAI / Anthropic APIs. Click the
  ✓ MEASURED badge in the live calc to see provenance.
- **Production-shape benchmark**: the bench uses LiteLLM + LangGraph
  + OpenTelemetry GenAI semconv — the same stack real teams deploy.

### What you get out of the box

- **~12 preset scenarios** spanning federal (Public Geospatial Q&A,
  NIH ClinicalTrials, NOAA Storm Tracking, DOE Grid Modeling), health
  (HIPAA patient portal), finance (bank compliance Q&A), legal
  (litigation discovery), and commercial (SaaS website builder,
  SWE-bench coder, startup support chatbot, …), **plus an
  `mcp-research-fleet` demo** that walks through the per-agent
  tools-registry end to end. Click "Load example…" in the top bar.
- **MCP-style per-agent tools registry**: workload-level catalog of
  available tools (web search, file search, container, Wikipedia, plus
  custom MCP servers); each agent checks which tools it can call and
  at what frequency. Cost engine bills per-agent against the registry's
  per-tool rate. Mixed-provider fleets (Anthropic + OpenAI + Bedrock)
  bill correctly per agent.
- **Multi-approach fact-checking**: 10 verifier presets across 4 cost
  shapes — FactReasoner FR1/FR2/FR3 (measured), MiniCheck and FactScore
  (estimated), RAGAS faithfulness + Anthropic citations (self-check
  overhead), Patronus and Galileo (commercial flat-rate). Verifier NLI
  hosting picker: direct API, Bedrock on-demand/provisioned, Azure
  OpenAI/PTU, EC2 self-host.
- **Per-agent guard-model picker**: 11 options including Meta Llama
  Guard 3, IBM Granite Guardian, AWS Bedrock Guardrails, Azure Content
  Safety, OpenAI Moderation (free), Patronus Lynx, Lakera Guard, etc.
  Each agent picks its own guardrail model + the engine bills the
  right shape ($/1M tokens vs $/check vs free).
- **AS-IS vs proposed**: enter what you're paying today (or what an
  incumbent quoted you) and the calculator shows annual delta, payback
  timeline, and a procurement-shaped verdict.
- **Multi-year migration timeline**: phase Year 1 API pilot → Year 2
  committed-spend → Year 3 hybrid self-host. Bar chart of phased cost.
- **Sensitivity panel + budget solver**: tornado chart on ±20% MAU /
  ±10pp cache / ±15% rates; inverse calc "given $X/mo, how many users?".
- **Cited benchmark chart**: log-axis dot plot of 24+ published reference
  prices (OpenAI Enterprise, Microsoft Copilot, Anthropic Claude
  Enterprise, GAO federal AI reports, etc.) with your scenario plotted
  alongside. No uncited estimates.
- **Print / PDF export**: clean print stylesheet hides the live UI for
  a self-contained procurement deliverable.
- **Auditable derivation**: copy-pasteable line-by-line math trace that
  reconciles to the headline. Drop into any LLM and ask "verify this".

### First-time visit

Land on [calc.ajinkya.ai](https://calc.ajinkya.ai) → an overlay walks you
through what the tool is, who it's for, and a 3-step quickstart. Dismiss
once and it remembers. Click the **?** button in the appbar anytime to
re-open the tour.

### Run the tests

```bash
npm test          # engine smoke + price-book apply (Node, fast)
npm run test:e2e  # full Playwright UI suite against calc.ajinkya.ai
```

**`npm test`** runs two suites:
- `test-engine-smoke.js` (78 invariants across all 8 presets — finite
  cost, FedRAMP multipliers, MAU linearity, headline reconciliation,
  per-query > 0, taskMix output multiplier, retry inflate, etc.)
- `test-apply.js` (regex-replacement unit tests for the price-book
  refresher)

**`npm run test:e2e`** runs 9 Playwright scenarios in a real Chromium:
boot + headline visibility, MAU/cache slider response, agent-mode
promotion with badge fly-away animation, verifier preset switching,
tools registry add/edit, per-agent enabled-tools, share-URL round-trip
across reload, and the MCP Research Fleet demo preset. Suite completes
in ~45s headless and is suitable for CI.

Flags:
- `--local` — run against `file://./public/index.html` instead of live
- `--headed` — show the browser window
- `--slow=400` — adjust slowMo (default 250ms)
- `--only=<name>` — run a single scenario (`boot-and-defaults`,
  `mau-slider`, `cache-slider`, `agent-promotion`, `verifier-preset`,
  `tools-registry`, `agent-enabled-tools`, `share-url-roundtrip`,
  `mcp-research-fleet`)

> 🤖 **Picking this repo up cold (human or AI)?** Three things to
> know:
> 1. **What this is**: the source for [calc.ajinkya.ai](https://calc.ajinkya.ai)
>    + a sibling Python benchmark in `bench/` that validates the
>    calc's coefficients against real LLM APIs.
> 2. **Auto-deploy**: `git push` to `main` → Cloudflare Pages
>    auto-builds + serves `public/` from the `ai-cost-calculator-studio`
>    Worker. ~30s end-to-end.
> 3. **Cloudflare credentials**: deploys need a Cloudflare API token
>    with Workers Edit scope ([create one](https://dash.cloudflare.com/profile/api-tokens)).
>    Keep it in a chmod-600 file of your choice (gitignored) and
>    export `CLOUDFLARE_API_TOKEN` before any `wrangler` command, e.g.
>    `export CLOUDFLARE_API_TOKEN=$(tr -d '\n\r ' < <your-token-file>)`.
> 4. **Prices**: `public/lib/prices.js` is refreshed from external
>    scrapes — see the `last_verified` field on each rate card for
>    currency.

## What's in here

```
ai-cost-calculator-studio/
├── README.md                # this file
├── wrangler.jsonc           # Cloudflare Workers Static Assets config
├── package.json             # npm deps (wrangler only — no build step)
├── public/                  # the live calculator (served at calc.ajinkya.ai)
│   ├── index.html           # markup + CSS for the calc + cost simulator
│   ├── app.js               # state mgmt, editor, scroll-spy nav, registry UI
│   ├── lib/
│   │   ├── cost-engine.js   # pure-function TCO calculator + preset tables
│   │   ├── cost-simulator.js # per-agent fleet editor + simulator math
│   │   └── prices.js        # model rate cards (last_verified dates)
│   ├── coefficients.json    # bench-produced empirical coefficients
│   └── examples/            # 15 preset workload JSONs incl. mcp-research-fleet
├── bench/                   # agent-cost-bench — Python harness
│   ├── README.md            # full bench docs (LiteLLM + LangGraph + OTEL)
│   ├── pyproject.toml
│   ├── coefficients.json    # canonical source for public/coefficients.json
│   ├── scenarios/           # YAML specs (smoke-test, multi-stage-research,
│   │                        #  cached-pipeline, tool-chain, data-discovery,
│   │                        #  parallel-fan-out, streaming-pipeline, …)
│   └── src/agent_cost_bench/
│       ├── runner.py        # LangGraph executor
│       ├── provider.py      # LiteLLM wrapper
│       ├── tracing.py       # OTEL GenAI semconv spans
│       ├── tools.py         # function-calling tool implementations
│       ├── scenario.py      # YAML scenario loader
│       ├── compare.py       # variance reports
│       ├── cli.py           # `agent-cost-bench run|compare|estimate`
│       └── geo_qa/          # replication bench: 6 scenarios (2 patterns
│                            #  × 3 response-handler modes) — stac_tools,
│                            #  handlers, dispatch, runner, schemas
├── docs/
│   └── paper/
│       └── validation-methodology.md   # paper section: empirical calibration
├── excel-template/
│   └── cost-model.xlsx      # pre-generated procurement-friendly spreadsheet
└── scripts/                 # build helpers, one-shot fixers
```

## Deploy the calculator (calc.ajinkya.ai)

The calc is pure static assets served via Cloudflare Workers.
**No build step** — `public/` is uploaded as-is.

```bash
# One-time per shell: export the Cloudflare API token (see callout above).
export CLOUDFLARE_API_TOKEN=$(tr -d '\n\r ' < <your-token-file>)

# Deploy: pushes public/ to the ai-cost-calculator-studio Worker,
# which serves calc.ajinkya.ai.
cd ai-cost-calculator-studio
npx wrangler deploy
```

Output:

```
✨ Read 17 files from the assets directory ai-cost-calculator-studio/public
Uploaded N of M assets
✨ Success! Uploaded N files (… already uploaded)
Uploaded ai-cost-calculator-studio (X.XXs)
```

The `Authentication error [code: 10000]` line that sometimes appears
at the very end is a known harmless artifact — wrangler tries to hit
a routes API endpoint at the end of every deploy that the user-API
token doesn't have scope for. **The actual asset upload completes
before that line.** Look for `Uploaded ai-cost-calculator-studio` to
confirm success.

Most asset changes are visible at calc.ajinkya.ai within ~30 seconds.
Hard-refresh (Cmd-Shift-R) to bypass browser cache.

## Run the benchmark

The bench is a separate Python package. See
[`bench/README.md`](./bench/README.md) for the full design rationale,
scenario library, and trace format.

Quick start:

```bash
cd bench
python3 -m venv .venv
.venv/bin/pip install -e .

# Set OpenAI / Anthropic API keys (gitignored)
cp .env.example .env  # or edit existing .env
# paste your keys

# Run a scenario
.venv/bin/agent-cost-bench run scenarios/smoke-test.yml --yes

# Compare against the simulator's predictions
.venv/bin/agent-cost-bench compare \
    reports/smoke-test-…-trace.json \
    --simulator-export ./scenario-from-calc.json
```

Each scenario produces a JSON trace artifact (OTEL GenAI semconv
attributes, per-call usage, request_ids) and the comparator emits a
Markdown variance report. Coefficients drifting more than ±15% from
their predicted values get flagged for calibration.

## The calibration loop

```
agent-cost-bench (Python)
  └─ runs scenarios against real OpenAI/Anthropic APIs
     └─ produces bench/coefficients.json
        └─ mirrored to public/coefficients.json
           └─ calc.ajinkya.ai fetches it at page load
              └─ the simulator applies measured values to its sliders
                 └─ ✓ MEASURED badge appears in the topbar
                    └─ click → modal panel with full provenance
                       (source scenario, sample size, provider,
                        measured range)
```

This is what turns the calc from a model into a measurement. Every
coefficient the simulator publishes has a named source scenario, a sample
size, and a provider — auditable down to the trace artifact in
`bench/reports/`.

The full methodology is documented in
[`docs/paper/validation-methodology.md`](./docs/paper/validation-methodology.md).

## Architecture — per-agent canonical + tools registry

The calc moved to a **per-agent-canonical** architecture in May 2026.
Three things to understand:

**1. Agent card is the editing surface.** Each agent has its own
TOOLS / RAG / Reasoning / Guardrails sub-sections inside its expanded
card. There's no global "RAG Pipeline Tokens" panel that broadcasts
to all agents — that pattern silently overwrote per-agent edits on
every tick. Bulk-edit lives as the "↧ Apply to all agents" link
inside each agent card. The remaining global sliders (cache rate,
batch %, retry, growth, peak, language multiplier) are workload-
shape parameters, not per-agent concerns.

**2. Tools registry is workload-level.** `workload.tools_registry`
is a catalog of available tools — each entry has a label, cost
shape (`per_call` / `per_session` / `free`), USD rate, schema
tokens (in prompt), result tokens (fed back to context), and
provider. Built-in entries (web_search, file_search,
container_session, wikipedia_retrieval, plus a placeholder
internal_db_query) are seeded by `normalizeWorkload`; users can
override their rates and add custom MCP tools via the editable
**Tools registry** panel in the "Tool routing & rates" section.

**3. Per-agent enabled_tools declares usage.** Each agent has
`agent.enabled_tools = { tool_id: { calls_per_query: N } }`.
The cost engine walks each agent's enabled tools, looks up rate +
shape in the registry, and bills correctly per agent. Mixed-
provider fleets (Claude orchestrator + GPT researcher + Bedrock
reporter) compute per-agent fees against each agent's own provider
rate card. Workload-mode (no agents declared) contributes $0 in
tool fees — the registry path is the only way to declare tool
usage now.

**Worked example:** load the **MCP Research Fleet** preset
(Examples → Demo · MCP Research Fleet) to see a 3-agent fleet
(Orchestrator + Researcher + Reporter) where each enables a
different subset of registered tools, including 2 custom MCP
entries.

## How the calc UI is structured

calc.ajinkya.ai is a single-page app with three navigation layers:

1. **L1 sidebar** (left): top-level tabs — Workspace · Prices ·
   Benchmarks · Report.
2. **L2 sub-nav** (sticky): scoped to the Components-half of
   Workspace — Hosting · Infrastructure · Compliance · People & Plan
   · Reference. Visible once you scroll past the cost simulator.
3. **L3 simulator nav** (inside the simulator pane): Configuration ·
   Audience · Agent Settings · Architecture · Token Analysis · Cost
   Models · Sensitivity · Routing · Methodology · Simulation.

All three navs share the same visual language (uppercase, letter-
spaced, cyan accent on active). The design reasoning is documented
in commit history; search for "design system" or "unify".

The Workspace tab itself is a single continuous scroll:

```
[Quick Start chat — collapses after first interaction]
[Your Deployment SVG diagram with $/mo on each box]
[Sticky scroll-spy sub-nav]
[cost simulator (full multi-agent token modeller)]
[Components-half — TCO inputs (Audience / Hosting / Infra /
                  Compliance / People & Plan / Reference)]
```

## Why this exists

A handful of public LLM cost calculators exist
([llm-prices.com](https://www.llm-prices.com/),
[Curlscape](https://curlscape.com/tools/llm-pricing-calculator),
[LiteLLM](https://docs.litellm.ai/docs/proxy/pricing_calculator),
many others), but none of them combine the dimensions a federal AI
procurement actually requires:

- Workload-specific traffic shapes (not "one query")
- Segment-aware prompt-cache modeling
- Verification pipeline overhead (FactReasoner-style)
- Daily-spend-cap refusal accounting
- Capacity-scaled self-host comparison with
  optimistic-vs-realistic toggle
- A same-budget fair comparison row that resolves the
  apples-to-oranges trap pervasive in API-vs-self-host analyses
- **Empirical validation**: every coefficient measured against
  real provider APIs

The methodology is documented in the companion paper
*Cost Modeling for Public-Facing LLM Chat Applications: Token Math,
Self-Host Break-Even, and Empirical Calibration*. The validation
methodology is documented separately at
[`docs/paper/validation-methodology.md`](./docs/paper/validation-methodology.md).

## Companion blog posts

- [Explaining the LLM cost paper](https://ajinkya.ai/posts/the-cost-paper-explained)
  — section-by-section walk-through of the paper's methodology: the
  naïve per-token formula and why it lies, the structural corrections
  that break it (caching, traffic shape, segments, daily caps), the
  six equations that replace it, and the worked public-geospatial example.
- [How to cost an AI agent — a tutorial](https://ajinkya.ai/posts/how-to-cost-an-ai-agent-tutorial)
  — build-your-own-calculator walkthrough. Start with one slider; add
  caching, traffic mix, segments, and refusal accounting; end with a
  procurement-grade artefact you can defend in review.

## Status

| Component | State |
|---|---|
| Calculator UI (`calc.ajinkya.ai`) | ✅ Live |
| cost simulator (multi-agent token math) | ✅ Live, inlined into the calc |
| **Per-agent canonical architecture** (no global broadcast loop) | ✅ Live |
| **Tools registry + per-agent enabled_tools** (MCP-style) | ✅ Live |
| **Multi-approach verifier picker** (10 presets, 4 cost shapes) | ✅ Live |
| **Per-agent guard-model picker** (11 options inc. Granite Guardian) | ✅ Live |
| **Bedrock + Azure hosting for verifier NLI** | ✅ Live |
| State unification (auto-sync simulator ↔ Components) | ✅ Live |
| Theme system (Tactical / Mission / Command) | ✅ Live |
| `coefficients.json` calibration loop | ✅ Live, fetched at page load |
| `agent-cost-bench` v0.2.0 | ✅ 12 scenarios validated (v0.1.0 pilot N=174, +N=238 templated re-cal May 13, +N=60 freeform anchor May 13, +N=18 Anthropic w=0.20 May 14) + `geo_qa` replication bench (second dataset, 2 patterns × 3 response-handler modes × 3 prompt variants = 18 paired rows) |
| Anthropic provider in bench | ✅ Live (via LiteLLM) |
| Playwright E2E suite (9 scenarios) | ✅ Live (`npm run test:e2e`) |
| Repo public on GitHub | ✅ Live |
| Self-host bench scenario | ⏸ planned (vLLM + open-weight model) |
| Public benchmark page (`calc.ajinkya.ai/benchmarks`) | ⏸ planned |
| MCP server discovery (auto-populate registry from URL) | ⏸ planned (Phase 4) |
| CI hookup (E2E on PR) | ⏸ planned |

## Contributing

Two ways to contribute, both of which make the calculator more useful for
everyone else:

- **A measured coefficient** — run `agent-cost-bench` (or measure your own
  way) and contribute the trace, so the simulator's defaults get more
  accurate.
- **An example workload** — author a workload JSON and it becomes a preset
  others can load.

[`CONTRIBUTING.md`](./CONTRIBUTING.md) has the full workflow and the
verification gate. Supporting docs:
[`docs/workload-schema.md`](./docs/workload-schema.md) (example JSON
fields), [`bench/AUTHORING.md`](./bench/AUTHORING.md) (scenario YAML
format), and [`REPRODUCING.md`](./REPRODUCING.md) (regenerate the paper's
tables).

## Citing

If you use this toolkit in published work or a procurement document:

```bibtex
@misc{kulkarni2026cost,
  author = {Kulkarni, Ajinkya},
  title  = {Cost Modeling for Public-Facing {LLM} Chat Applications:
            Token Math, Self-Host Break-Even, and Empirical Calibration},
  year   = {2026},
  url    = {https://github.com/ajinkyakulkarni/ai-cost-calculator-studio}
}
```

## Related work

- [CEBench (arXiv:2407.12797)](https://arxiv.org/abs/2407.12797) — a
  benchmarking toolkit for the cost-effectiveness of LLM pipelines.
  Complementary: CEBench produces empirical throughput numbers that a
  calculator like this one consumes; `agent-cost-bench` produces
  per-coefficient calibration data for the simulator's defaults.
- [A Cost-Benefit Analysis of On-Premise LLM Deployment
  (arXiv:2509.18101)](https://arxiv.org/abs/2509.18101) — closest
  academic companion. They estimate a single break-even point; we
  model the full curve.
- [Demystifying Cost-Efficiency in LLM Serving over Heterogeneous
  GPUs (arXiv:2502.00722)](https://arxiv.org/abs/2502.00722) —
  cost-efficient mixed-fleet scheduling.
- [TokenPowerBench (arXiv:2512.03024)](https://arxiv.org/abs/2512.03024)
  — power-consumption methodology.
- [FedRAMP AI prioritization](https://www.fedramp.gov/ai/) and the
  [GSA + NIST partnership](https://www.gsa.gov/about-us/newsroom/news-releases/gsa-and-nist-partner-to-boost-ai-evaluation-science-in-federal-procurement-03182026)
  for the federal procurement context this toolkit plugs into.

## License

MIT.
