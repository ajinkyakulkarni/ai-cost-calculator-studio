# Reproducing the paper

This repo is the artifact for *Cost Modeling for Public-Facing LLM Chat
Applications: An Equal-Budget, Refusal-Aware Comparison of Commercial APIs
and Self-Hosted GPU Fleets* (Kulkarni & Parajuli, 2026).

This file maps each numerical table in the paper to the command that
regenerates it.

## Pin the version first

The paper's dollar figures are a dated snapshot. Provider rate cards in
`public/lib/prices.js` get refreshed over time, so `main` will drift from
the published numbers. To reproduce the paper **exactly**, check out the
release it was written against:

```bash
git checkout v0.4.0
```

| Pin | Value |
|---|---|
| Release tag | `v0.4.0` |
| Harness version | `agent-cost-bench` 0.2.0 |
| `public/coefficients.json` sha256 | `6d12073cec675a7743b5ec21c74d838403c1da8ed14eb10c2b45d91d65d672d9` |
| Rate-card date | 2026-05-11 (GPT-5.2, Sonnet-4-5 prices captured) |

On `main` you will get numbers priced at the *current* rate card instead —
useful, but not the paper's figures. That is expected and is exactly why
the paper calls dollar figures "timestamps, not constants."

The shipped calculator (including `v0.4.0`) applies the Eq. 3 clamp
differently from the paper's printed form: the [0.50, 0.94] bound is
restricted to the session-length adjustment term `0.01·(q−6)` so the
"Cache hit rate" slider stays honest across its full 0–95% range (a
deployment with no prompt caching at all genuinely has cache <50%, and
Eq. 3 as printed silently bumps it to 0.50). Within the paper's own use
of Eq. 3 — fixed measured `r_baseline ≈ 0.84`, `q` varying over
realistic session lengths — neither bound binds and the result is
identical, so `v0.4.0` reproduces the paper's numbers exactly.

## What needs API keys

| Reproduction | Cost | Needs |
|---|---|---|
| Calibration tables (2, 3, 4) | real API spend, ~$0.30–$3 per scenario | OpenAI + Anthropic keys |
| Worked example / stress test (Table 7) | free | nothing — pure calculation |

Set keys for the calibration runs (see [`bench/README.md`](bench/README.md)):

```bash
cd bench
cp .env.example .env   # then paste your keys
```

---

## Table 2 — cache hit rate by provider and topology

The pilot rows come from the v0.1.0 calibration; the production re-cal row
comes from the templated geospatial scenario.

```bash
# Pilot (9 scenarios, 174 calls)
./scripts/reproduce-v0.1.0.sh

# Production-shape re-calibration (N=20, 238 calls)
cd bench && agent-cost-bench run scenarios/public-geospatial-react.yml --yes
```

## Table 3 — input/output ratio by topology

Covered by the same pilot run. The relevant scenarios are `long-chat`
(chat), `multi-stage-research` (sequential), `tool-chain`,
`data-discovery`, and `data-discovery-gpt52`.

```bash
./scripts/reproduce-v0.1.0.sh
```

## Table 4 — tool-response architecture cost lever

The paired templated/freeform measurement.

```bash
cd bench
# Templated anchor — $0.00168/q ($1,508/mo at 10K MAU mixed)
agent-cost-bench run scenarios/public-geospatial-react.yml --yes
# Freeform anchor — $0.01473/q ($13,253/mo at 10K MAU mixed)
agent-cost-bench run scenarios/public-geospatial-react-freeform.yml --yes
```

(Anchors updated 2026-06-01 against directly-measured EIE-agent `responses.py`
templated returns + openveda STAC API freeform payloads, with
`cache_write_share = 0` — OpenAI auto-prefix steady state. The bundled
`public-geospatial-qa.json` preset is 1-agent + 7-tool with the per-tool
breakdown — templated tool sum 119 tok, freeform tool sum 20,926 tok; flip
RETURN SHAPE per tool to model targeted templating changes.)

The Anthropic cache-write share `w ≈ 0.20` (§5) is a third run:

```bash
agent-cost-bench run scenarios/cached-pipeline-anthropic.yml --yes
```

## Table 7 — public-scale stress test

No API calls — this is the calculator's own arithmetic. Table 7 has two API
architectures, each with its **own bundled preset**. They are the same
deployment; they differ only in the tool-return shape, and every anchor
coordinate (input tokens, cache rate, output tokens) is baked into the
preset — there is nothing to override by hand:

| Row       | Preset                                | anchor input | cache  |
|---        |---                                    |---:          |---:    |
| Templated | `public-geospatial-qa.json`           | 2,933        | 0.88   |
| Freeform  | `public-geospatial-qa-freeform.json`  | 23,740       | 0.744  |

Both presets ship at the 10K-MAU worked-example scale. For the Table 7
**stress-test** rows, set the **public** segment to **75,000 MAU** (keep the
mixed traffic mix) — that is the *only* change. On the live site, load the
example and edit the segment. From the CLI, copy the preset, set
`segments[id=public].mau = 75000`, and run:

```bash
node scripts/calc.js --workload <preset-at-75k>.json --json
```

At the presets' default 10K MAU the two files give the §5 worked-example
operating points, **$1,508/mo** templated and **$13,253/mo** freeform
(api.monthly_gross, GPT-5.2 Standard tier, mixed traffic mix,
cache_write_share = 0). The stress-test rows at 75K MAU scale to
$11,309/mo templated and $99,398/mo freeform uncapped (capped at
$45,000/mo refusing 54.7% of public traffic).

> **Do not hand-build the freeform anchor.** Use the bundled
> `public-geospatial-qa-freeform.json` preset. The freeform anchor is three
> coupled coordinates — input 23,740, **cache 0.744**, output 41 — and all
> three are in the preset. Overriding only the input tokens and leaving the
> cache at the templated 0.88 understates the freeform cost; the
> `calc.js --cache` flag must also be set if you build the anchor by hand.

Both presets are regression-pinned in `scripts/bench-validate.mjs`
(`npm run bench:validate`).

## Tables 1, 5, 6

Classification and evidence-boundary tables — no numerical cells to
reproduce.

---

## Running the geospatial agent directly

The templated/freeform anchors above come from a six-stage geospatial
Q&A agent (parse_datetime → geocode → collections_rag → select_collection
→ stac_search → stats). The bench scenarios call OpenAI with the same
prompt+tool payloads the agent would, but they don't simulate the agent
loop itself. To run the loop end-to-end against a live OpenAI key — see
the per-stage cache_tokens, flip the tool-return mode in place, and
watch the cache warm up on a browser UI — use the companion repository:

- `github.com/ajinkyakulkarni/public-geospatial-qa-agent`

```bash
git clone https://github.com/ajinkyakulkarni/public-geospatial-qa-agent
cd public-geospatial-qa-agent && pip install -e .
cp .env.example .env   # paste OPENAI_API_KEY

python3 -m public_geospatial_qa_agent.cli run-once \
    --archetype single_dataset_viz --mode templated
python3 -m public_geospatial_qa_agent.cli serve --budget 1.00
```

`run-suite` writes one JSON line per LLM call into `runs/measurement.jsonl`,
and `analyze` rolls that up into per-stage averages directly comparable
to the bench output. Same model, same rate card, same cache key —
different runtime path. Per-cycle totals agree.

---

## Verifying a result

To check that the calculator's prediction matches a real API run for the
same workload, use `validate-preset.py` — it diffs the two per-query costs
layer by layer and flags anything off by more than ±15%:

```bash
python scripts/validate-preset.py \
    --preset public/examples/public-geospatial-qa.json \
    --trace bench/reports/<trace-from-a-run-above>.json
```

The committed reports in `bench/reports/` are the reference outputs.
