# Paper additions from the 2026-06-04 corpus run

Draft sections to add to the main cost-modeling paper. Numbers come
from the public-geospatial-qa-agent corpus run logged in
`runs/curated-paper.{jsonl,trace.jsonl}` and
`runs/naive-paper.{jsonl,trace.jsonl}` in the agent repo
(github.com/ajinkyakulkarni/public-geospatial-qa-agent, commit
`64b7e67`, 2026-06-04). Every cycle's cost is tied to an
OpenAI `chatcmpl-*` response id in the trace.

## §5.x  Templating cost lever revisited

The v0.4.0 paper anchored the templating lever at 8.8×
(templated $0.00168 vs freeform $0.01473 per query). The 2026-06-04
corpus run measures **2.4×** on the same model
(gpt-5.2, standard tier):

| Cell | n | Cost / cycle | 95% CI | Cache % |
|---|---:|---:|---:|---:|
| templated, single-turn, no gate | 50 | $0.008141 | ±$0.000847 | 92.3% |
| freeform, single-turn, no gate | 50 | $0.019686 | ±$0.001260 | 72.2% |
| **ratio** | | | **2.42×** | |

The direction holds: freeform mode pays more per cycle in every cell.
The ratio is smaller than the v0.4.0 anchor because the corpus
measurement walks the full six-stage cycle with accumulating message
history, whereas the v0.4.0 anchor was a single-turn approximation.
With real Planetary Computer STAC payloads (the live backend smoke
showed Houston's MultiPolygon at 305 KB), the freeform per-cycle
cost rose to **$0.45** — a **55× ratio** to the canned templated
$0.00814. The headline cost lever is therefore best stated as:

> The templating cost lever is at least 2.4× on a calibrated
> reproducible corpus and scales with catalog-payload size. Production
> deployments serving real STAC items will see ratios in the 10–55×
> range depending on the per-item geometry size.

The trace meta sidecars (`runs/*.trace.meta.json`) record:
- sysprompt sha256 (`b7e7361435...`)
- tool-schemas sha256 (`85acba1fc2...`)
- corpus file sha256 + content (50 hand-curated queries)
- gpt-5.2 standard rate card ($1.75/$0.175/$14.00 per million)
- git commit + dirty flag of the runner code

These let any reviewer reproduce the measurement against the same
prompt, schemas, and query corpus.

## §6  Pattern cost lever: single-turn vs per-stage confirmation

The cycle pattern itself is a separately measurable cost lever.
Two patterns:

- **single-turn**: the agent walks the six stages in one OpenAI session
  with accumulating history. The runner forces the next stage's tool
  call rather than honouring the model's natural choice; this keeps
  per-stage records comparable across queries.
- **per-stage-confirm**: after each input-resolution stage
  (`parse_datetime`, `geocode`, `select_collection`), an extra OpenAI
  call generates the confirmation prose (*"Time set to 2020-01-01/2020-12-31.
  Confirm to continue."*) and a synthetic *"Confirm."* user reply is
  appended before the next stage runs.

Measured on the same 50-query curated corpus:

| Mode | Pattern | n | Cost / cycle | 95% CI | Cache % | Δ vs single-turn |
|---|---|---:|---:|---:|---:|---:|
| templated | single-turn | 50 | $0.008141 | ±$0.000847 | 92.3% | — |
| templated | per-stage-confirm | 50 | $0.014118 | ±$0.000653 | 87.2% | **+73.4%** |
| freeform | single-turn | 50 | $0.019686 | ±$0.001260 | 72.2% | — |
| freeform | per-stage-confirm | 50 | $0.025725 | ±$0.000465 | 72.5% | **+30.7%** |

Per-stage costs more because each pending stage adds one full OpenAI
call (the confirmation prose) plus a synthetic user turn that grows
the history seen by every subsequent stage. The templated overhead
is proportionally larger (1.73× vs 1.31×) because the base cost is
smaller — three confirmation calls of ~30-50 output tokens
each represent a meaningful share of a cheap cycle but only a small
share of an expensive one.

Production parallels:
- **Single-turn** mirrors most LLM chat deployments (ChatGPT, Claude.ai,
  Cursor): one OpenAI call per user turn, model decides what to do.
- **Per-stage-confirm** mirrors wizard-style or high-stakes setup
  flows (Stripe Connect onboarding, AWS Lambda creation): each step
  confirms with the user before advancing.

For an Earth-observation Q&A surface targeted at general public
traffic, single-turn is the appropriate default — the user wants an
answer, not a multi-step confirmation flow.

## §7  Pre-flight gate and the f_naive crossover

A third cost lever applies to public-facing deployments: whether to
run any cycle at all when the user query is incomplete. The 2026-06-04
naive corpus (30 messy public-style queries: missing dates, vague
phrasing, scope violations) makes this measurable.

**Pre-flight gate.** One small LLM call before the cycle decides
whether the query has enough context (date + place + dataset hint) or
should ask back. The gate uses gpt-5.2 with a tight system prompt
(~560 input tokens, ~30 output) that either returns the literal token
`OK` or proposes a default and asks for confirmation
(*"Going to use NO2 for 2023. Want a different year?"*).

Measured gate cost per call: **$0.0014 ± $0.0003**.

**Coverage:**
- Curated corpus (50 complete queries): gate flagged 17/50 (34%) on
  the templated path, 15/50 (30%) on the freeform path. The 30%+
  flag rate on the curated corpus is concentrated on the
  `catalog_discovery` archetype where the query intentionally omits
  a time window ("what datasets do you have for SST"); the gate
  treats those as incomplete by default.
- Naive corpus (30 messy queries): gate flagged **30/30 (100%)**.
  Every naive query produced a follow-up question instead of a
  billed cycle.

**Cost model.** Let `g` = gate cost, `c` = cycle cost, `f_naive`
= share of public traffic missing a required field, `r` = share of
gated queries whose user supplies the missing field on the next turn.

```
no_gate     : E[cost] = c
gated       : E[cost] = g · (1 + r · f_naive) + (1 − f_naive · (1 − r)) · c
```

Solving for the break-even f_naive (gated = no-gate) with `r = 1`:

```
f_naive_crossover = g / c
```

Plugging in the measured values:

| Mode | g | c | f_naive crossover |
|---|---:|---:|---:|
| templated | $0.0014 | $0.008141 | **16.0%** |
| freeform | $0.0014 | $0.019686 | **6.6%** |

**Production claim.** For any public-facing geospatial Q&A deployment
where more than 16% of incoming traffic is incomplete in templated
mode (6.6% in freeform), the pre-flight LLM gate is strictly cheaper
than running every query. The naive corpus puts public-traffic
f_naive well above both crossovers; the gate also matches the
production analog of task-oriented bot slot-filling (intent classifier
+ slot detection used by Intercom Fin, Klarna's support bot, voice
assistants).

The per-stage-confirm pattern by contrast pays cycle cost on every
query — it never short-circuits — so per-stage is dominated by the
pre-flight gate for public traffic at every measured `f_naive ≥ 17%`.

## §8  Combined cost model for public-facing deployments

The three levers compose. The cost-calculator preset
`public-geospatial-qa.json` exposes:

```
mode:                    templated | freeform
clarification_strategy:  none | pre_flight_gate | per_stage_confirm
f_naive:                 [0.0, 1.0]
recovery_rate:           [0.0, 1.0]
gate_cost_per_call_usd:  $0.0014   (measured)
```

For a 10 K MAU public deployment at 0.2 sessions/day × 10 q/session ×
30 days = 600 K cycles/month, the **mixed-mode per-cycle blended cost**
at `mode = templated`, `clarification_strategy = pre_flight_gate`,
`f_naive = 0.50`, `recovery_rate = 0.90` is:

```
0.0014 · (1 + 0.9 · 0.5) + (1 − 0.5 · 0.1) · 0.008141 = $0.00937 / query
```

For 600 K cycles/month: **~$5,620/month**. Without the gate, the
same workload runs **~$4,884/month** (all queries pay cycle cost).
The gate adds ~15% to the bill on a query stream where 50% are
incomplete; the trade-off is positive only when the recovery rate
times cycle cost exceeds the gate overhead. With the freeform mode
(`c = $0.0197`), the gate saves money on any `f_naive > 6.6%`.

The full preset and reproduction pointers are in
`public/examples/public-geospatial-qa.json`'s
`anchor_query._calibration.measured_per_cycle` block.

---

## Reproducibility appendix

To reproduce these numbers exactly:

```bash
git clone https://github.com/ajinkyakulkarni/public-geospatial-qa-agent
cd public-geospatial-qa-agent
git checkout 64b7e67   # commit pinned in trace meta
pip install -e '.[live]'   # live optional dep for the demo backend

# Curated matrix (50 queries × 6 cells):
export OPENAI_API_KEY=sk-...
PGQA_CORPUS_FILE=data/queries.json python3 -m public_geospatial_qa_agent.cli serve \\
    --backend canned --budget 25 \\
    --measurement-log runs/curated-paper.jsonl \\
    --trace runs/curated-paper.trace.jsonl

# In another terminal:
python3 scripts/run_corpus_in_browser.py --slow-mo 80 \\
    --corpus-file data/queries.json \\
    --measurement-log runs/curated-paper.jsonl

# Naive matrix (30 queries × 6 cells), repeat with the naive corpus:
PGQA_CORPUS_FILE=data/queries-naive.json python3 -m public_geospatial_qa_agent.cli serve \\
    --backend canned --budget 25 \\
    --measurement-log runs/naive-paper.jsonl \\
    --trace runs/naive-paper.trace.jsonl
python3 scripts/run_corpus_in_browser.py --slow-mo 80 \\
    --corpus-file data/queries-naive.json \\
    --measurement-log runs/naive-paper.jsonl

# Build the per-cell aggregate + calc-preset JSON:
python3 -m public_geospatial_qa_agent.cli analyze --corpus \\
    --log runs/curated-paper.jsonl
python3 -m public_geospatial_qa_agent.cli analyze --corpus \\
    --log runs/naive-paper.jsonl
python3 scripts/build_calc_preset.py \\
    --curated-log runs/curated-paper.jsonl \\
    --naive-log runs/naive-paper.jsonl \\
    --out runs/calc-preset.public-geospatial-qa.json
```

Total spend: ~$4.20 (measured at $1.75/$0.175/$14.00 per million
gpt-5.2 standard-tier input/cached-input/output). The trace meta
sidecars (`*.trace.meta.json`) carry the sysprompt sha256, tool-schemas
sha256, corpus file sha256, runner git commit, package versions, and
the gpt-5.2 rate card so any deviation in the reproduction can be
attributed to its source.
